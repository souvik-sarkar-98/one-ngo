import type { RecordQuery as RuntimeRecordQuery } from '../../runtime/records/record-service.js';

/** A filtered, sorted and paged list of records, as a person asks for it. */
export type RecordQuery = RuntimeRecordQuery;

/** `{ workflowKey: [state, …] }` from a request body, or nothing. */
export function statesOf(v: unknown): Record<string, string[]> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, s]) => Array.isArray(s)).map(([k, s]) => [k, (s as unknown[]).map(String)]));
}

/** A list query from a request body, keeping only known parts. */
export function recordQueryOf(body: unknown): RecordQuery {
  const b = (body && typeof body === 'object' ? body : {}) as RecordQuery;
  return {
    statusIn: Array.isArray(b.statusIn) ? b.statusIn.map(String).slice(0, 50) : undefined,
    owner: b.owner === 'me' ? 'me' : undefined,
    sharedWithMe: b.sharedWithMe === true ? true : undefined,
    search: typeof b.search === 'string' ? b.search.slice(0, 200) : undefined,
    filters: b.filters && typeof b.filters === 'object' ? b.filters : undefined,
    states: statesOf(b.states),
    sort:
      b.sort && typeof b.sort.field === 'string'
        ? {
            field: b.sort.field,
            dir: b.sort.dir === 'asc' ? 'asc' : 'desc',
            from: b.sort.from && typeof b.sort.from === 'object' ? { lat: Number(b.sort.from.lat), lng: Number(b.sort.from.lng) } : undefined,
          }
        : undefined,
    sum: Array.isArray(b.sum) ? b.sum.map(String).slice(0, 10) : undefined,
    limit: Number(b.limit) || undefined,
    offset: Number(b.offset) || undefined,
  };
}
