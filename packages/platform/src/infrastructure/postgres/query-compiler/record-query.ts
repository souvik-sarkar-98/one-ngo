import { fieldExpr, sqlKey, typePredicate } from './index-expressions.js';
import type { Period, RecordAggregateAst, RecordGroup, RecordPredicate, RecordQueryAst, RecordSort } from '../../../runtime/records/ports/record-query.js';

/**
 * The PostgreSQL compiler of the record-query AST: clauses over the record
 * alias `r` for app_record_ids, app_record_count and app_record_agg, whose
 * values travel in one jsonb array ($1). Only definition keys (checked by
 * `sqlKey`) and fixed text reach the clauses. Field expressions come from
 * index-expressions so the managed indexes apply. The functions accept only
 * this grammar (migration 016): a new clause shape needs a migration too.
 */
export interface CompiledRecordQuery {
  where: string;
  order: string;
  args: unknown[];
  limit: number;
  offset: number;
}

export interface CompiledAggregate {
  select: string;
  where: string;
  group: string | null;
  args: unknown[];
}

class Params {
  constructor(readonly args: unknown[] = []) {}

  private slot(v: unknown): number {
    return this.args.push(v) - 1;
  }

  text(v: string): string {
    return `($1->>${this.slot(String(v))})`;
  }

  numeric(v: number | string): string {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError('A record query number must be finite.');
    return `(($1->>${this.slot(v)})::numeric)`;
  }

  uuid(v: string): string {
    return `($1->>${this.slot(String(v))})::uuid`;
  }

  jsonb(v: string | number | boolean): string {
    return `($1->${this.slot(v)})`;
  }

  texts(v: string[]): string {
    return `array(select jsonb_array_elements_text($1->${this.slot(v.map(String))}))`;
  }

  numerics(v: number[]): string {
    return `array(select x::numeric from jsonb_array_elements_text($1->${this.slot(v)}) x)`;
  }
}

const KM_PER_DEGREE = 111.32;
const COLUMNS = { number: 'number', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at' } as const;
const DATE_COLUMNS = { createdAt: 'r.created_at', updatedAt: 'r.updated_at' } as const;
const NEWEST = 'created_at desc, id desc';

const unknownNode = (node: { kind: string }): never => {
  throw new TypeError(`Unknown record query node '${node.kind}'.`);
};

/** Great-circle distance in km between a location field and a point. */
function distanceKm(key: string, lat: string, lng: string): string {
  const la = fieldExpr(key, 'lat');
  const ln = fieldExpr(key, 'lng');
  return `(12742 * asin(sqrt(least(1, power(sin(radians(${la} - ${lat}) / 2), 2) + cos(radians(${lat})) * cos(radians(${la})) * power(sin(radians(${ln} - ${lng}) / 2), 2)))))`;
}

/** Records shared, unexpired, with the person or one of their roles. */
const sharedWith = (person: string, roles: string[], b: Params) =>
  `exists (select 1 from record_share s where s.tenant_id = app_tenant() and s.record_id = r.id and (s.expires_at is null or s.expires_at > now()) and ((s.principal_kind = 'user' and s.principal = ${b.text(person)}) or (s.principal_kind = 'role' and s.principal = any(${b.texts(roles)}))))`;

const likeText = (text: string) => `%${text.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

function predicate(p: RecordPredicate, b: Params): string {
  switch (p.kind) {
    case 'ofType':
      return typePredicate(p.type);
    case 'visibleTo': {
      const me = b.text(p.person);
      const clauses = [`r.created_by = ${me}`, `r.owner_id = ${me}`, sharedWith(p.person, p.roles, b)];
      if (p.approvableSteps.length) {
        clauses.push(
          `exists (select 1 from approval_request a where a.tenant_id = app_tenant() and a.record_id = r.id and a.status = 'pending' and a.transition_key = any(${b.texts(p.approvableSteps)}))`,
        );
      }
      return `(${clauses.join(' or ')})`;
    }
    case 'sharedWith': {
      const me = b.text(p.person);
      return `(${sharedWith(p.person, p.roles, b)} and r.created_by is distinct from ${me} and r.owner_id is distinct from ${me})`;
    }
    case 'ownedBy':
      return `owner_id = ${b.text(p.person)}`;
    case 'idIn':
      return `id::text = any(${b.texts(p.ids)})`;
    case 'idIs':
      return `id = ${b.uuid(p.id)}`;
    case 'idIsNot':
      return `id <> ${b.uuid(p.id)}`;
    case 'numberIs':
      return `lower(number) = lower(${b.text(p.number)})`;
    case 'statusIn':
      return `status = any(${b.texts(p.values)})`;
    case 'workflowIn': {
      if (!p.primary) return `${fieldExpr(p.workflow, 'state')} = any(${b.texts(p.states)})`;
      const follows = p.orNone ? `(workflow_key = ${sqlKey(p.workflow)} or workflow_key is null)` : `workflow_key = ${sqlKey(p.workflow)}`;
      return `${follows} and status = any(${b.texts(p.states)})`;
    }
    case 'search':
      return `search_text ilike ${b.text(likeText(p.text))}`;
    case 'containsAny': {
      if (!p.fields.length) throw new TypeError('A containsAny predicate names no field.');
      const pattern = b.text(likeText(p.text));
      return `(${p.fields.map((field) => `${fieldExpr(field, 'lower')} ilike ${pattern}`).join(' or ')})`;
    }
    case 'equals':
      return `data -> ${sqlKey(p.field)} = ${b.jsonb(p.value)}`;
    case 'oneOf':
      switch (p.as) {
        case 'multi':
          return `(data -> ${sqlKey(p.field)}) ?| ${b.texts(p.values.map(String))}`;
        case 'numeric':
          return `${fieldExpr(p.field, 'numeric')} = any(${b.numerics(p.values.map(Number))})`;
        case 'text':
          return `${fieldExpr(p.field, 'text')} = any(${b.texts(p.values.map(String))})`;
        default:
          return unknownNode({ kind: `oneOf ${String((p as { as: unknown }).as)}` });
      }
    case 'range': {
      const expr = fieldExpr(p.field, p.as === 'numeric' ? 'numeric' : 'text');
      const bound = (v: string | number) => (p.as === 'numeric' ? b.numeric(Number(v)) : b.text(String(v)));
      const parts = [];
      if (p.from !== undefined) parts.push(`${expr} >= ${bound(p.from)}`);
      if (p.to !== undefined) parts.push(`${expr} <= ${bound(p.to)}`);
      if (!parts.length) throw new TypeError(`The range on '${p.field}' has no bound.`);
      return parts.join(' and ');
    }
    case 'near': {
      const dLat = p.km / KM_PER_DEGREE;
      const dLng = p.km / (KM_PER_DEGREE * Math.max(Math.cos((p.lat * Math.PI) / 180), 0.01));
      return [
        `${fieldExpr(p.field, 'lat')} between ${b.numeric(p.lat - dLat)} and ${b.numeric(p.lat + dLat)}`,
        `${fieldExpr(p.field, 'lng')} between ${b.numeric(p.lng - dLng)} and ${b.numeric(p.lng + dLng)}`,
        `${distanceKm(p.field, b.numeric(p.lat), b.numeric(p.lng))} <= ${b.numeric(p.km)}`,
      ].join(' and ');
    }
    case 'matches':
      return p.as === 'numeric' ? `${fieldExpr(p.field, 'numeric')} = ${b.numeric(p.value)}` : `${fieldExpr(p.field, 'lower')} = lower(${b.text(p.value)})`;
    default:
      return unknownNode(p);
  }
}

function order(s: RecordSort, b: Params): string {
  let expr: string;
  switch (s.kind) {
    case 'newest':
      return NEWEST;
    case 'id':
      return 'id';
    case 'column':
      if (!Object.hasOwn(COLUMNS, s.column)) return unknownNode({ kind: `column ${String(s.column)}` });
      expr = COLUMNS[s.column];
      break;
    case 'field':
      expr = fieldExpr(s.field, s.as === 'numeric' ? 'numeric' : 'text');
      break;
    case 'distance':
      expr = distanceKm(s.field, b.numeric(s.lat), b.numeric(s.lng));
      break;
    default:
      return unknownNode(s);
  }
  return `${expr} ${s.dir === 'asc' ? 'asc' : 'desc'} nulls last, ${NEWEST}`;
}

/** The query `ast` asks for, with the statements the functions run (`idsSql`, `countSql`) for query plans. */
export function compileRecordQuery(ast: RecordQueryAst): CompiledRecordQuery & { idsSql: string; countSql: string } {
  const b = new Params();
  const where = ast.where.map((p) => predicate(p, b)).join(' and ');
  const orderSql = order(ast.sort, b);
  return {
    where,
    order: orderSql,
    args: b.args,
    limit: ast.limit,
    offset: ast.offset,
    idsSql: `select r.id from record r where r.tenant_id = app_tenant() and (${where}) order by ${orderSql} limit $2 offset $3`,
    countSql: `select count(*)::int from record r where r.tenant_id = app_tenant() and (${where})`,
  };
}

/** The condition of `ast` alone, for counts and aggregates. */
export function compileWhere(ast: Pick<RecordQueryAst, 'where'>): Pick<CompiledRecordQuery, 'where' | 'args'> {
  const b = new Params();
  return { where: ast.where.map((p) => predicate(p, b)).join(' and '), args: b.args };
}

/** `q` with more conditions, binding their values after its own, on the page given (in `q`'s order unless a sort is given). */
export function narrowQuery(q: CompiledRecordQuery, where: RecordPredicate[], page: { sort?: RecordSort; limit: number; offset: number }): CompiledRecordQuery {
  const b = new Params([...q.args]);
  const extra = where.map((p) => predicate(p, b));
  return { where: [q.where, ...extra].join(' and '), order: page.sort ? order(page.sort, b) : q.order, args: b.args, limit: page.limit, offset: page.offset };
}

/**
 * The same labels as the domain's `fiscalYearKey`, computed by the database so a report can group by
 * year. It has to stay SQL in infrastructure; test/infrastructure-parity.test.ts proves every start
 * month and date gives the label `fiscalYearKey` does.
 */
export function fiscalYearExpr(date: string, startMonth: number | undefined): string {
  if (!Number.isInteger(startMonth) || startMonth! < 1 || startMonth! > 12) throw new TypeError('A financial year needs its start month (1-12).');
  return startMonth === 1
    ? `to_char(${date}, 'YYYY')`
    : `to_char(${date} - interval '${startMonth! - 1} months', 'YYYY') || '-' || to_char(${date} + interval '${13 - startMonth!} months', 'YY')`;
}

const PERIODS: Record<Period, (date: string, startMonth: number | undefined) => string> = {
  day: (date) => `to_char(${date}, 'YYYY-MM-DD')`,
  week: (date) => `to_char(date_trunc('week', ${date}), 'YYYY-MM-DD')`,
  month: (date) => `to_char(${date}, 'YYYY-MM')`,
  financialYear: fiscalYearExpr,
};

function groupExpr(g: RecordGroup): string {
  switch (g.kind) {
    case 'status':
      return 'r.status';
    case 'field':
      return fieldExpr(g.field, 'text');
    case 'period': {
      if (!Object.hasOwn(PERIODS, g.period)) return unknownNode({ kind: `period ${String(g.period)}` });
      let date: string;
      if ('column' in g.date) {
        if (!Object.hasOwn(DATE_COLUMNS, g.date.column)) return unknownNode({ kind: `date column ${String(g.date.column)}` });
        date = `(${DATE_COLUMNS[g.date.column]} at time zone 'Asia/Kolkata')::date`;
      } else date = `(${fieldExpr(g.date.field, 'text')})::date`;
      return PERIODS[g.period](date, g.fiscalYearStartMonth);
    }
    default:
      return unknownNode(g);
  }
}

/** The select, condition and grouping app_record_agg runs for `agg` over the records `q` matches: `v` the value, `k` the group. */
export function compileAggregate(q: Pick<CompiledRecordQuery, 'where' | 'args'>, agg: RecordAggregateAst): CompiledAggregate {
  let measure: string;
  switch (agg.measure.kind) {
    case 'count':
      measure = 'count(*)';
      break;
    case 'sum':
      measure = `coalesce(sum(${fieldExpr(agg.measure.field, 'numeric')}), 0)`;
      break;
    default:
      return unknownNode(agg.measure);
  }
  const expr = agg.group ? groupExpr(agg.group) : null;
  return expr
    ? { select: `${expr} as k, ${measure} as v`, where: `${q.where} and ${expr} is not null`, group: '1', args: q.args }
    : { select: `${measure} as v`, where: q.where, group: null, args: q.args };
}

/** The select of totals of number or money fields, `s<i>` for the field at index i. */
export function compileSums(fields: string[]): string {
  return fields.map((k, i) => `coalesce(sum(${fieldExpr(k, 'numeric')}), 0) as s${i}`).join(', ');
}
