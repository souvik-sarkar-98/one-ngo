import { depth, oneOf, range, text, type ParamReader, type Params, type Range } from '../address';

/** A panel opened by a bare parameter, as `?add` on a role or `?create` on API keys. Opening it pushes; closing it replaces that entry. */
export const readFlag = (get: ParamReader, name: string): boolean => get(name) !== null;
export const writeFlag = (name: string, on: boolean): Params => ({ [name]: on ? '' : null });

export const JOB_CHIPS = ['running', 'failed', 'all'] as const;
export type JobChip = (typeof JOB_CHIPS)[number];
export const ADMIN_PAGE = 30;
const MAX_SHOW = 300;

/** `/admin/jobs?status=&job=`: the chip (All when absent) and the job whose result is open. */
export interface JobsAddress {
  status: JobChip;
  job?: string;
  show: number;
}

const JOB_CHIP = oneOf(JOB_CHIPS);
const ID = text();
const SHOW = depth(ADMIN_PAGE, MAX_SHOW);

export function parseJobsAddress(get: ParamReader): JobsAddress {
  const job = ID.read(get, 'job');
  return { status: JOB_CHIP.read(get, 'status') ?? 'all', ...(job && { job }), show: SHOW.read(get, 'show') ?? ADMIN_PAGE };
}

export function jobsParams(a: JobsAddress): Params {
  return { status: a.status === 'all' ? null : a.status, ...ID.write('job', a.job), ...SHOW.write('show', a.show) };
}

/** Opening a job pushes; closing it, and the chip and depth, replace. */
export const jobsPushes = (a: JobsAddress, b: JobsAddress) => !a.job && !!b.job;

export const AUDIT_AREAS = ['records', 'people', 'roles', 'setup', 'connectors', 'apiKeys', 'money', 'files', 'organisation'] as const;

/** `/admin/audit` plus filter parameters: person (a user id or api:<name>), area, record type and date. */
export interface AuditAddress {
  person?: string;
  area?: string;
  recordType?: string;
  date?: Range;
  show: number;
}

export const AUDIT_FILTERS = ['person', 'area', 'recordType', 'date'] as const;
const AREA = oneOf(AUDIT_AREAS);
const DATE = range('date');

export function parseAuditAddress(get: ParamReader): AuditAddress {
  const person = ID.read(get, 'person');
  const area = AREA.read(get, 'area');
  const recordType = ID.read(get, 'recordType');
  const date = DATE.read(get, 'date');
  return { ...(person && { person }), ...(area && { area }), ...(recordType && { recordType }), ...(date && { date }), show: SHOW.read(get, 'show') ?? ADMIN_PAGE };
}

export function auditParams(a: AuditAddress): Params {
  return { ...ID.write('person', a.person), ...ID.write('area', a.area), ...ID.write('recordType', a.recordType), ...DATE.write('date', a.date), ...SHOW.write('show', a.show) };
}

export const auditKey = (a: AuditAddress) => JSON.stringify([a.person, a.area, a.recordType, a.date]);
export const jobsKey = (a: JobsAddress) => a.status;
