import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { forbidden, validationFailed } from '@onengo/kernel/errors';
import { can } from '../../domain/permissions.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import { canReadField } from '../definitions/field-permissions.js';
import type { FieldDef } from '../definitions/types.js';
import type { Period, RecordGroup, RecordMeasure } from './query-ast.js';
import type { RecordQuery, RecordService } from './record-service.js';

export type { Period };

export interface AggregateRequest extends Pick<RecordQuery, 'statusIn' | 'owner' | 'sharedWithMe' | 'filters' | 'states' | 'search'> {
  measure: 'count' | 'sum';
  field?: string;
  groupBy?: { field: string } | { period: Period; dateField: string };
}

export type AggregateResult = { value: number } | { buckets: { key: string; label: string; value: number }[] };

const GROUPABLE = new Set(['choice', 'boolean', 'reference']);
const DATE_COLUMNS = new Set(['createdAt', 'updatedAt']);
const PERIODS = new Set<string>(['day', 'week', 'month', 'financialYear']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 2000;

const dateLabel = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

/**
 * Counts and totals for pages and widgets, over the same records the list
 * query would return for the person (permissions, filters, visibility), as one
 * number or split by a field or a period. Results are kept for five minutes per
 * request shape.
 */
export class RecordAggregates {
  private readonly cache = new Map<string, { at: number; result: AggregateResult }>();

  constructor(
    private readonly db: TransactionManager,
    private readonly records: RecordService,
    private readonly now: () => number = Date.now,
  ) {}

  async aggregate(ctx: TenantContext, typeKey: string, req: AggregateRequest): Promise<AggregateResult> {
    const key = JSON.stringify([ctx.tenantId, typeKey, ctx.actor.id, [...ctx.actor.permissions].sort(), [...ctx.actor.roles].sort(), req]);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.result;

    const q = await this.records.buildQuery(ctx, typeKey, {
      statusIn: req.statusIn,
      owner: req.owner,
      sharedWithMe: req.sharedWithMe,
      filters: req.filters,
      states: req.states,
      search: req.search,
    });
    const fields = new Map(q.type.body.fields.map((f) => [f.key, f]));
    const readable = (k: string, what: string): FieldDef => {
      const f = fields.get(k);
      if (!f) throw validationFailed(`Unknown field '${k}'.`);
      if (!canReadField(ctx.actor, q.type.body, f)) {
        throw forbidden(f.sensitive ? `Sensitive fields cannot be ${what}.` : `'${f.label}' cannot be ${what}: you cannot see it.`);
      }
      return f;
    };

    let measure: RecordMeasure = { kind: 'count' };
    if (req.measure === 'sum') {
      const f = readable(req.field ?? '', 'totalled');
      if (f.type !== 'number' && f.type !== 'money') throw validationFailed(`'${f.key}' is not a number or money field.`);
      measure = { kind: 'sum', field: f.key };
    } else if (req.measure !== 'count') throw validationFailed("measure must be 'count' or 'sum'.");

    let group: {
      ast: RecordGroup;
      label: (key: string) => string | Promise<string>;
      order: 'key' | 'value';
      field?: FieldDef;
    } | null = null;
    if (req.groupBy && 'field' in req.groupBy) {
      if (req.groupBy.field === 'status') {
        const states = new Map(q.workflows.flatMap((w) => w.states.map((s) => [s.key, s.label] as const)));
        group = { ast: { kind: 'status' }, label: (k) => states.get(k) ?? k, order: 'value' };
      } else {
        const f = readable(req.groupBy.field, 'grouped');
        if (!GROUPABLE.has(f.type)) throw validationFailed(`'${f.key}' cannot be grouped by; use a choice, yes/no or reference field.`);
        const choices = new Map((f.choices ?? []).map((c) => [c.value, c.label]));
        group = {
          ast: { kind: 'field', field: f.key },
          label: (k) => (f.type === 'boolean' ? (k === 'true' ? 'Yes' : 'No') : choices.get(k) ?? k),
          order: 'value',
          field: f,
        };
      }
    } else if (req.groupBy && 'period' in req.groupBy) {
      const { period, dateField } = req.groupBy;
      let date: Extract<RecordGroup, { kind: 'period' }>['date'];
      if (DATE_COLUMNS.has(dateField)) date = { column: dateField as 'createdAt' | 'updatedAt' };
      else {
        const f = readable(dateField, 'grouped');
        if (f.type !== 'date') throw validationFailed(`'${dateField}' is not a date field.`);
        date = { field: f.key };
      }
      if (!PERIODS.has(period)) throw validationFailed("period must be 'day', 'week', 'month' or 'financialYear'.");
      const labels: Record<Period, (k: string) => string> = {
        day: dateLabel,
        week: (k) => `Week of ${dateLabel(k)}`,
        month: (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`,
        financialYear: (k) => `FY ${k}`,
      };
      group = { ast: { kind: 'period', period, date }, label: labels[period], order: 'key' };
    }

    const { records: store, queries } = this.records.stores;
    const rows = await this.db.withTenant(ctx.tenantId, async (tx) => {
      let ast = group?.ast;
      if (ast?.kind === 'period' && ast.period === 'financialYear') ast = { ...ast, fiscalYearStartMonth: await store.fiscalYearStartMonth(tx) };
      return queries.aggregate<{ k?: string | null; v: number | string }>(tx, q, { measure, group: ast });
    });

    let result: AggregateResult;
    if (!group) result = { value: Number(rows[0]?.v ?? 0) };
    else {
      const raw = rows.map((r) => ({ key: String(r.k), value: Number(r.v) }));
      const titles = group.field?.type === 'reference' ? await this.titles(ctx, group.field, raw.map((b) => b.key)) : null;
      const buckets = [];
      for (const b of raw) buckets.push({ key: b.key, label: titles?.get(b.key) ?? (await group.label(b.key)), value: b.value });
      buckets.sort((a, b) => (group!.order === 'key' ? a.key.localeCompare(b.key) : b.value - a.value || a.label.localeCompare(b.label)));
      result = { buckets };
    }
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(key, { at: this.now(), result });
    return result;
  }

  /** Titles of referenced records the person can read; others keep their id. */
  private async titles(ctx: TenantContext, f: FieldDef, ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!f.referenceType || !can(ctx.actor, `record:${f.referenceType}:read`)) return out;
    const titleField = await this.records.titleFieldOf(ctx.tenantId, f.referenceType);
    for (const id of ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x))) {
      try {
        const r = await this.records.get(ctx, id);
        out.set(id, String((titleField && r.data[titleField]) || r.number || id));
      } catch {
        // Not visible to this person: keep the id.
      }
    }
    return out;
  }
}
