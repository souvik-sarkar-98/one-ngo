import { notFound, validationFailed } from '@onengo/kernel/errors';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import { API_CORS_SETTING, corsOriginsOf } from '../../domain/identity/api-key-policy.js';
import type { AdministrationStore } from '../administration/ports/administration-store.js';
import type { ApiKeyService } from '../identity/api-key-service.js';
import type { OrganisationService } from '../organisations/organisation-service.js';
import type { DefinitionService } from '../../runtime/definitions/definition-service.js';
import type { DataFeedDef, FieldDef, RecordTypeDef } from '../../runtime/definitions/types.js';
import type { RecordPredicate, RecordQueries, RecordQueryAst, RecordSort } from '../../runtime/records/ports/record-query.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_OFFSET = 500;
const MAX_SEARCH = 200;
const SEALED = 'enc:v1:';

export interface DataFeedField {
  key: string;
  label: string;
  type: string;
}

export interface DataFeedRecordItem {
  id: string;
  number: string | null;
  status: string | null;
  values: Record<string, unknown>;
}

export type DataFeedPage =
  | { key: string; label: string; source: 'records'; fields: DataFeedField[]; items: DataFeedRecordItem[]; total: number }
  | { key: string; label: string; source: 'content'; entries: { key: string; label: string; text: string }[] };

/**
 * A published data feed read with a key bound to that feed. The caller cannot
 * change the fields, the statuses or the sort. Browser origins are the organisation's list.
 */
export class DataFeedService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly organisations: Pick<OrganisationService, 'publicHome'>,
    private readonly definitions: DefinitionService,
    private readonly queries: RecordQueries,
    private readonly settings: Pick<AdministrationStore, 'setting'>,
    private readonly keys: Pick<ApiKeyService, 'authenticateFeed'>,
  ) {}

  /** The organisation and the origins a browser may use. Unknown and inactive codes are not found. */
  async access(code: string): Promise<{ tenantId: string; origins: string[] }> {
    const home = await this.organisations.publicHome(code);
    const stored = await this.transactions.withTenant(home.tenantId, (tx) => this.settings.setting(tx, API_CORS_SETTING));
    return { tenantId: home.tenantId, origins: corsOriginsOf(stored) };
  }

  /** Accepts only a key bound to this feed in this organisation. */
  authenticate(credential: string, tenantId: string, feedKey: string): Promise<void> {
    return this.keys.authenticateFeed(credential, tenantId, feedKey);
  }

  /** The feed is published. Unknown and unpublished feeds are not found, before the key is checked. */
  async published(tenantId: string, feedKey: string): Promise<void> {
    const found = await this.definitions.get(tenantId, 'dataFeed', feedKey);
    if (!found) throw notFound('Not found.');
  }

  /** The feed's page. `query` is the raw query string: `q`, `limit`, `offset` and `filter.<field>`. */
  async read(tenantId: string, feedKey: string, query: Record<string, unknown>): Promise<DataFeedPage> {
    const published = await this.definitions.get(tenantId, 'dataFeed', feedKey);
    if (!published) throw notFound('Not found.');
    const feed = published.body;
    if (feed.source === 'content') return this.content(feed, query);
    return this.records(tenantId, feed, query);
  }

  private content(feed: DataFeedDef, query: Record<string, unknown>): DataFeedPage {
    const extra = Object.keys(query);
    if (extra.length) {
      throw validationFailed('A content feed takes no query.', [{ path: `/${extra[0]}`, message: 'is not allowed' }]);
    }
    return {
      key: feed.key,
      label: feed.label,
      source: 'content',
      entries: (feed.entries ?? []).map((entry) => ({ key: entry.key, label: entry.label, text: entry.text })),
    };
  }

  private async records(tenantId: string, feed: DataFeedDef, query: Record<string, unknown>): Promise<DataFeedPage> {
    const type = await this.definitions.get(tenantId, 'recordType', feed.recordType ?? '');
    if (!type || !feed.fields?.length || !feed.statusIn?.length) throw notFound('Not found.');
    const parsed = parseQuery(feed, type.body, query);
    const where: RecordPredicate[] = [
      { kind: 'ofType', type: type.body.key },
      { kind: 'statusIn', values: feed.statusIn },
    ];
    if (parsed.q && feed.search?.length) where.push({ kind: 'containsAny', fields: feed.search, text: parsed.q });
    for (const [key, value] of Object.entries(parsed.filters)) where.push({ kind: 'equals', field: key, value });
    const ast: RecordQueryAst = { where, sort: sortOf(feed, type.body), limit: parsed.limit, offset: parsed.offset };
    const [rows, total] = await this.transactions.withTenant(tenantId, async (tx) => {
      const page = await this.queries.rows(tx, ast);
      const count = await this.queries.count(tx, { where });
      return [page, count] as const;
    });
    const fields = feed.fields.map((key) => {
      const field = type.body.fields.find((item) => item.key === key)!;
      return { key, label: field.label, type: field.type };
    });
    return {
      key: feed.key,
      label: feed.label,
      source: 'records',
      fields,
      total,
      items: rows.map((row) => ({
        id: row.id,
        number: row.number,
        status: row.status,
        values: shown(row.data, feed.fields!),
      })),
    };
  }
}

function shown(data: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of fields) {
    const value = data[key];
    if (value === undefined || (typeof value === 'string' && value.startsWith(SEALED))) continue;
    values[key] = value;
  }
  return values;
}

function sortOf(feed: DataFeedDef, type: RecordTypeDef): RecordSort {
  if (!feed.sort) return { kind: 'newest' };
  const field = type.fields.find((item) => item.key === feed.sort!.field);
  const numeric = field?.type === 'number' || field?.type === 'money';
  return { kind: 'field', field: feed.sort.field, as: numeric ? 'numeric' : 'text', dir: feed.sort.direction };
}

function parseQuery(feed: DataFeedDef, type: RecordTypeDef, query: Record<string, unknown>): {
  q?: string;
  limit: number;
  offset: number;
  filters: Record<string, string | number | boolean>;
} {
  const allowed = new Set(feed.allowFilters ?? []);
  const filters: Record<string, string | number | boolean> = {};
  let q: string | undefined;
  let limit = DEFAULT_LIMIT;
  let offset = 0;
  for (const [key, raw] of Object.entries(query)) {
    if (key === 'q') {
      if (!feed.search?.length) refuse(key);
      const text = one(raw, key);
      if (text.length > MAX_SEARCH) fail(key, `is longer than ${MAX_SEARCH} characters`);
      if (text) q = text;
      continue;
    }
    if (key === 'limit') {
      limit = whole(one(raw, key), key, 1, MAX_LIMIT);
      continue;
    }
    if (key === 'offset') {
      offset = whole(one(raw, key), key, 0, MAX_OFFSET);
      continue;
    }
    if (key.startsWith('filter.')) {
      const field = key.slice('filter.'.length);
      if (!allowed.has(field)) refuse(key);
      const def = type.fields.find((item) => item.key === field);
      if (!def) refuse(key);
      filters[field] = filterValue(def, one(raw, key), key);
      continue;
    }
    refuse(key);
  }
  return { q, limit, offset, filters };
}

function filterValue(field: FieldDef, raw: string, path: string): string | number | boolean {
  if (field.type === 'number' || field.type === 'money') {
    const n = Number(raw);
    if (!Number.isFinite(n)) fail(path, 'must be a number');
    return n;
  }
  if (field.type === 'boolean') {
    if (raw !== 'true' && raw !== 'false') fail(path, 'must be true or false');
    return raw === 'true';
  }
  return raw;
}

function one(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be one value');
  return value;
}

function whole(value: string, path: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) fail(path, 'must be a whole number');
  const n = Number(value);
  if (n < min || n > max) fail(path, `must be from ${min} to ${max}`);
  return n;
}

function refuse(path: string): never {
  fail(path, 'is not allowed');
}

function fail(path: string, message: string): never {
  throw validationFailed('This feed does not accept that query.', [{ path: `/${path}`, message }]);
}
