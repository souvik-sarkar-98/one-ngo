import {
  accessElements,
  applyExtensionPatch,
  compileExpression,
  explicitPermissions,
  ExpressionError,
  generatedPermissions,
  isKnownPermission,
  permissionMatches,
  type PermissionDefs,
} from '../server';
import type { AuthGateway, SignInResult } from '../auth/http-auth';
import { localCheck, valueTypeOf } from '../builder/expression-catalogue';
import type { AccessGateway, AccessMapElement, CatalogueEntry, CatalogueGroup, ModuleRow, RoleView } from '../builder/http-access';
import type { BuilderGateway, Usage } from '../builder/http-builder';
import type { EditorGateway } from '../builder/http-editor';
import { ENGLISH, LOCALES } from '../i18n/i18n';
import type { InboxGateway } from '../inbox/http-inbox';
import type {
  ApprovalItem,
  ApprovalQueryBody,
  ApprovalRow,
  BuilderDetail,
  CatalogueItem,
  DefinitionKind,
  FieldFilter,
  PageDef,
  PendingApproval,
  Receipt,
  RecordQueryBody,
  RecordTypeBody,
  RecordView,
  RuntimeRecordType,
  RuntimeWorkflow,
  SaveResult,
  WorkflowBody,
} from '../models';
import type { AggregateRequest, PagesGateway, Pin } from '../pages';
import type { PeopleGateway } from '../people/people';
import { PICK_LIMIT } from '../records/record/references';
import type { RecordsGateway } from '../records/gateway/gateway';
import type { Share, SharesGateway } from '../records/sharing/sharing';
import { sampleSeed, type SampleApproval, type SampleSeed } from './sample-data';

export { sampleSeed, type SampleSeed } from './sample-data';

interface Stored {
  record: RecordView;
  owner: string;
}

interface StoredDefinition {
  kind: DefinitionKind;
  key: string;
  owner: 'base' | 'tenant';
  moduleKey: string | null;
  baseVersion: number | null;
  base: Record<string, unknown> | null;
  patch: unknown;
  history: { version: number; status: 'published' | 'superseded'; body: Record<string, unknown>; published_at: string }[];
  draft: { version: number; body: Record<string, unknown> } | null;
}

export interface MemoryGateways {
  records: RecordsGateway;
  auth: AuthGateway;
  inbox: InboxGateway;
  builder: BuilderGateway;
  people: PeopleGateway;
  editor: EditorGateway;
  shares: SharesGateway;
  pages: PagesGateway;
  access: AccessGateway;
  /** Every call made, in order, for tests that check what was asked. */
  calls: { port: 'records' | 'auth' | 'inbox' | 'builder' | 'people' | 'editor' | 'shares' | 'pages' | 'access'; op: string; args: unknown[] }[];
  /** The stored record as it is now. */
  record(id: string): RecordView | undefined;
  /** Who is signed in; `null` after signing out. */
  signedIn(): string | null;
}

/** Errors are thrown as the server reports them: a code, a message, and per-field issues. */
const fail = (code: string, message: string, issues: { path: string; message: string }[] = []) => ({ code, message, issues });
const clone = <T>(v: T): T => structuredClone(v);
const blank = (v: unknown) => v === undefined || v === null || v === '';

/** A few of the server's definition checks: the key, a record type's fields and title, a workflow's states. */
function definitionErrors(kind: string, key: string, body: Record<string, unknown>): { path: string; message: string }[] {
  const errors: { path: string; message: string }[] = [];
  if (body['key'] !== key) errors.push({ path: '/key', message: 'The key in the body must match the address.' });
  if (kind === 'recordType') {
    const fields = Array.isArray(body['fields']) ? (body['fields'] as { key?: unknown }[]) : [];
    if (!fields.length) errors.push({ path: '/fields', message: 'A record type needs at least one field.' });
    if (body['titleField'] && !fields.some((f) => f.key === body['titleField'])) errors.push({ path: '/titleField', message: `There is no field '${String(body['titleField'])}'.` });
  }
  if (kind === 'workflow') {
    const states = Array.isArray(body['states']) ? (body['states'] as { key?: unknown }[]) : [];
    if (!states.some((s) => s.key === body['initial'])) errors.push({ path: '/initial', message: `There is no state '${String(body['initial'])}'.` });
  }
  return errors;
}

/** What changes, one line per top-level property, as the server words changes it has no special wording for. */
function changeLines(before: Record<string, unknown> | undefined, after: Record<string, unknown>): string[] {
  if (!before) return [`Creates '${String(after['label'] ?? after['key'])}'`];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => `Changes '${k}'`);
}

/** The Indian financial year of an ISO date, e.g. 2026-27. */
function financialYear(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const start = Number(iso.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

function formatNumber(format: string, seq: number, iso: string): string {
  return format.replace('{fy}', financialYear(iso)).replace(/\{seq(?::(\d+))?\}/, (_, w: string | undefined) => String(seq).padStart(Number(w ?? 1), '0'));
}

function valueOf(r: RecordView, key: string): unknown {
  if (key === 'number' || key === 'status' || key === 'createdAt' || key === 'updatedAt') return r[key];
  return r.data[key];
}

function compare(a: unknown, b: unknown): number {
  if (blank(a) && blank(b)) return 0;
  if (blank(a)) return 1;
  if (blank(b)) return -1;
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
}

function filterHolds(v: unknown, f: FieldFilter): boolean {
  if (f.in && !f.in.map(String).includes(String(v ?? ''))) return false;
  if (f.eq !== undefined && !((v ?? null) === f.eq || (f.eq === false && blank(v)))) return false;
  if (!blank(f.from) && (blank(v) || compare(v, f.from) < 0)) return false;
  if (!blank(f.to) && (blank(v) || compare(v, f.to) > 0)) return false;
  return true;
}

/**
 * Every gateway port over in-memory sample data, for tests, previews and
 * demos. It keeps the server's observable rules that the screens rely on:
 * filters, search, sort and paging; record numbers; version conflicts;
 * required step fields; approvals; receipts; drafts and publishing. Time is a
 * fixed clock, so the same calls always give the same answers.
 */
export function memoryGateway(seed: SampleSeed = sampleSeed()): MemoryGateways {
  const s = clone(seed);
  const records = new Map<string, Stored>(s.records.map((r) => [r.record.id, r]));
  const receipts = new Map<string, Receipt[]>(Object.entries(s.receipts));
  const approvals: SampleApproval[] = s.approvals;
  const notifications = s.notifications;
  const calls: MemoryGateways['calls'] = [];
  const sequences = new Map<string, number>();
  for (const { record } of records.values()) if (record.number) sequences.set(record.type, (sequences.get(record.type) ?? 0) + 1);
  let receiptNo = [...receipts.values()].flat().length;
  let ids = records.size;
  let me: string | null = s.me;
  let locale = s.locale;
  let tick = 0;

  const now = () => new Date(Date.parse(s.now) + tick++ * 60_000).toISOString();
  const log = (port: MemoryGateways['calls'][number]['port'], op: string, args: unknown[]) => calls.push({ port, op, args: clone(args) });
  const user = (id: string | null) => s.users.find((u) => u.id === id);
  const signedIn = () => {
    if (!me) throw fail('unauthenticated', 'Sign in to continue.');
    return me;
  };
  const recordType = (key: string): RuntimeRecordType => {
    const t = s.definitions.recordTypes.find((x) => x.key === key);
    if (!t) throw fail('not_found', `There is no record type '${key}'.`);
    return t;
  };
  const workflowsOf = (type: string): RuntimeWorkflow[] => s.definitions.workflowSets?.[type] ?? (s.definitions.workflows[type] ? [s.definitions.workflows[type]!] : []);
  const stored = (type: string, id: string): Stored => {
    const r = records.get(id);
    if (!r || r.record.type !== type) throw fail('not_found', 'This record does not exist or you cannot see it.');
    return r;
  };
  const checkVersion = (r: RecordView, expected: number) => {
    if (r.version !== expected) throw fail('conflict', 'Someone else changed this record. Its latest version is shown; make your change again.');
  };
  /** Empty fields among `keys` that must be filled; `all` treats every listed field as required, as a step's fields are. */
  const requiredIssues = (type: RuntimeRecordType, data: Record<string, unknown>, keys: string[], all = false) =>
    keys
      .map((k) => type.fields.find((f) => f.key === k))
      .filter((f) => !!f && (all || f.required) && !f.calculated && f.type !== 'boolean' && blank(data[f.key]))
      .map((f) => ({ path: `/${f!.key}`, message: `${f!.label} is required.` }));
  const copyReferences = (type: RuntimeRecordType, data: Record<string, unknown>, changed: Record<string, unknown>) => {
    for (const f of type.fields) {
      if (!f.copyFrom || !(f.copyFrom.reference in changed)) continue;
      const picked = records.get(String(data[f.copyFrom.reference] ?? ''));
      data[f.key] = picked ? (picked.record.data[f.copyFrom.field] ?? null) : null;
    }
  };
  const issueReceipt = (r: RecordView, at: string): Receipt => {
    receiptNo++;
    const rc: Receipt = {
      id: `receipt-${receiptNo}`,
      number: `RCPT/${financialYear(at)}/${String(receiptNo).padStart(5, '0')}`,
      amount: Number(r.data['amount'] ?? 0).toFixed(2),
      date: at.slice(0, 10),
      status: 'issued',
      voidReason: null,
    };
    receipts.set(r.id, [...(receipts.get(r.id) ?? []), rc]);
    return rc;
  };
  const applyStep = (r: Stored, wf: RuntimeWorkflow, step: string, data: Record<string, unknown>): SaveResult => {
    const t = wf.transitions.find((x) => x.key === step)!;
    const at = now();
    const record = r.record;
    record.data = { ...record.data, ...data };
    copyReferences(recordType(record.type), record.data, data);
    if (record.workflow === wf.key || (!record.workflow && wf.role !== 'parallel')) record.status = t.to;
    else record.states = { ...(record.states ?? {}), [wf.key]: t.to };
    record.version++;
    record.updatedAt = at;
    const issued = s.receiptSteps[record.type]?.includes(step) ? [issueReceipt(record, at)] : [];
    return { record: clone(record), receipts: clone(issued), journalEntryIds: [] };
  };
  const shareRows: (Share & { recordId: string })[] = [];
  let shareNo = 0;
  const roles = () => s.roles ?? [...new Set(s.users.flatMap((u) => u.roles))].map((key) => ({ key, label: key, permissions: [] as string[] }));
  const liveShare = (x: Share) => !x.expiresAt || x.expiresAt > s.now;
  const mayShare = (r: Stored) => r.owner === me || !!user(me)?.roles.includes('admin');
  const sharedWithMe = (r: Stored) =>
    r.owner !== me &&
    shareRows.some((x) => x.recordId === r.record.id && liveShare(x) && (x.principalKind === 'user' ? x.principal === me : !!user(me)?.roles.includes(x.principal)));
  const view = (r: Stored): RecordView => (recordType(r.record.type).visibility === 'restricted' && mayShare(r) ? { ...r.record, canShare: true } : r.record);
  const managed = (type: string, id: string): Stored => {
    const r = stored(type, id);
    if (!mayShare(r)) throw fail('forbidden', 'Only its creator or people allowed to share can share this record.');
    return r;
  };
  const pendingFor = (id: string) => approvals.find((a) => a.recordId === id && a.status === 'pending');
  const decidedBy = new Map<string, Set<string>>();
  const decideApproval = (approvalId: string, decision: 'approve' | 'reject'): { status: string; message?: string } => {
    const a = approvals.find((x) => x.id === approvalId);
    if (!a || a.status !== 'pending') return { status: 'stale', message: 'This request has already been decided.' };
    if (a.requestedBy === signedIn()) throw fail('forbidden', 'You cannot decide on your own request.');
    if (decidedBy.get(a.id)?.has(signedIn())) return { status: 'stale', message: 'You have already decided on this request.' };
    decidedBy.set(a.id, new Set([...(decidedBy.get(a.id) ?? []), signedIn()]));
    if (decision === 'reject') {
      a.status = 'rejected';
      return { status: 'rejected' };
    }
    a.approvalsGiven++;
    if (a.approvalsGiven < a.approvalsNeeded) return { status: 'pending' };
    a.status = 'approved';
    const r = records.get(a.recordId)!;
    const wf = workflowsOf(a.recordType).find((w) => w.transitions.some((x) => x.key === a.transition))!;
    applyStep(r, wf, a.transition, a.data);
    return { status: 'approved' };
  };

  const recordsPort: RecordsGateway = {
    async query(type, body: RecordQueryBody) {
      log('records', 'query', [type, body]);
      const t = recordType(type);
      const searchable = t.fields.filter((f) => !f.sensitive).map((f) => f.key);
      const q = body.search?.trim().toLowerCase();
      const matched = [...records.values()]
        .filter((x) => {
          const { record: r, owner } = x;
          if (r.type !== type) return false;
          if (body.statusIn?.length && !body.statusIn.includes(r.status ?? '')) return false;
          if (body.owner === 'me' && owner !== me) return false;
          if (body.sharedWithMe && !sharedWithMe(x)) return false;
          if (q && ![r.number, ...searchable.map((k) => r.data[k])].some((v) => !blank(v) && String(v).toLowerCase().includes(q))) return false;
          return Object.entries(body.filters ?? {}).every(([k, f]) => filterHolds(valueOf(r, k), f));
        })
        .map(view);
      const sort = body.sort ?? { field: 'createdAt', dir: 'desc' as const };
      matched.sort((a, b) => {
        const c = compare(valueOf(a, sort.field), valueOf(b, sort.field));
        return (sort.dir === 'desc' && !blank(valueOf(a, sort.field)) && !blank(valueOf(b, sort.field)) ? -c : c) || a.id.localeCompare(b.id);
      });
      const offset = body.offset ?? 0;
      const items = matched.slice(offset, offset + (body.limit ?? 20));
      const sums = body.sum?.length
        ? Object.fromEntries(body.sum.map((k) => [k, matched.reduce((n, r) => n + (typeof r.data[k] === 'number' ? (r.data[k] as number) : 0), 0)]))
        : undefined;
      return clone({ items, total: matched.length, ...(sums ? { sums } : {}) });
    },
    async get(type, id) {
      log('records', 'get', [type, id]);
      return clone(view(stored(type, id)));
    },
    async create(type, data) {
      log('records', 'create', [type, data]);
      const t = recordType(type);
      if (!t.canCreate) throw fail('forbidden', 'You cannot create these records.');
      const issues = requiredIssues(t, data, t.fields.map((f) => f.key));
      if (issues.length) throw fail('invalid', 'Some fields need attention.', issues);
      const at = now();
      const wf = s.definitions.workflows[type];
      const seq = (sequences.get(type) ?? 0) + 1;
      sequences.set(type, seq);
      const record: RecordView = {
        id: `${type}-${++ids}`,
        type,
        number: t.numbering ? formatNumber(t.numbering.format, seq, at) : null,
        status: wf?.initial ?? null,
        ...(wf ? { workflow: wf.key } : {}),
        version: 1,
        schemaVersion: t.version,
        data: { ...data },
        createdAt: at,
        updatedAt: at,
      };
      copyReferences(t, record.data, data);
      records.set(record.id, { record, owner: signedIn() });
      return { record: clone(record), receipts: [], journalEntryIds: [] };
    },
    async update(type, id, data, expectedVersion) {
      log('records', 'update', [type, id, data, expectedVersion]);
      const t = recordType(type);
      const r = stored(type, id);
      checkVersion(r.record, expectedVersion);
      const state = workflowsOf(type)[0]?.states.find((x) => x.key === r.record.status);
      if (state?.locked || state?.final) throw fail('locked', 'This record can no longer be changed.');
      const next = { ...r.record.data, ...data };
      const issues = requiredIssues(t, next, Object.keys(data));
      if (issues.length) throw fail('invalid', 'Some fields need attention.', issues);
      copyReferences(t, next, data);
      r.record.data = next;
      r.record.version++;
      r.record.updatedAt = now();
      return { record: clone(r.record), receipts: [], journalEntryIds: [] };
    },
    async transition(type, id, step, data, expectedVersion) {
      log('records', 'transition', [type, id, step, data, expectedVersion]);
      const t = recordType(type);
      const r = stored(type, id);
      checkVersion(r.record, expectedVersion);
      const wf = workflowsOf(type).find((w) => w.transitions.some((x) => x.key === step));
      const tr = wf?.transitions.find((x) => x.key === step);
      const current = wf && (wf.key === r.record.workflow || wf.role !== 'parallel') ? r.record.status : r.record.states?.[wf?.key ?? ''];
      if (!wf || !tr || !current || !tr.from.includes(current)) throw fail('invalid_transition', `'${tr?.label ?? step}' is not possible now.`);
      if (!tr.allowed) throw fail('forbidden', `You cannot '${tr.label}' this record.`);
      const issues = requiredIssues(t, { ...r.record.data, ...data }, tr.requiredFields ?? [], true);
      if (issues.length) throw fail('invalid', 'Some fields need attention.', issues);
      if (tr.approval) {
        if (pendingFor(id)) throw fail('pending_approval', 'This record is already waiting for an approval.');
        const approval: SampleApproval = {
          id: `approval-${approvals.length + 1}`,
          recordType: type,
          recordId: id,
          transition: step,
          requestedBy: signedIn(),
          approvalsNeeded: tr.approval.count ?? 1,
          approvalsGiven: 0,
          status: 'pending',
          data: clone(data),
          createdAt: now(),
        };
        approvals.push(approval);
        return { record: clone(r.record), receipts: [], journalEntryIds: [], approvalRequestId: approval.id };
      }
      return applyStep(r, wf, step, data);
    },
    async runAction(type, id, key, input, expectedVersion) {
      log('records', 'runAction', [type, id, key, input, expectedVersion]);
      const r = stored(type, id);
      const action = s.definitions.actions?.[type]?.find((a) => a.key === key);
      if (!action) throw fail('not_found', `Unknown action '${key}'.`);
      if (!action.allowed) throw fail('forbidden', `You cannot run '${action.label}'.`);
      checkVersion(r.record, expectedVersion);
      const issues = (action.form?.fields ?? [])
        .filter((f) => f.required && f.type !== 'boolean' && blank(input[f.key]))
        .map((f) => ({ path: `/${f.key}`, message: `${f.label} is required.` }));
      if (issues.length) throw fail('invalid', 'Some fields are not valid.', issues);
      let open: string | undefined;
      if (action.steps.some((x) => x.type === 'openReceipt')) {
        const latest = (receipts.get(id) ?? []).filter((x) => x.status === 'issued').at(-1);
        if (!latest) throw fail('rule_violation', 'This record has no receipt to print yet.');
        open = `/print/receipt/${latest.id}`;
      }
      return { record: clone(r.record), message: `${action.label}: done.`, ...(open ? { open } : {}) };
    },
    async receipts(type, id) {
      log('records', 'receipts', [type, id]);
      stored(type, id);
      return clone(receipts.get(id) ?? []);
    },
    async createReceiptLink(receiptId) {
      log('records', 'createReceiptLink', [receiptId]);
      return { path: `/r/${receiptId}` };
    },
    async revokeReceiptLink(receiptId) {
      log('records', 'revokeReceiptLink', [receiptId]);
    },
    async printReceipt(receiptId) {
      log('records', 'printReceipt', [receiptId]);
      const [recordId, rc] = [...receipts.entries()].flatMap(([rid, list]) => list.filter((x) => x.id === receiptId).map((x) => [rid, x] as const))[0] ?? [];
      const r = recordId ? records.get(recordId) : undefined;
      if (!rc || !r) throw fail('not_found', 'Receipt not found.');
      const t = recordType(r.record.type);
      return clone({
        receipt: { ...rc, seriesKey: r.record.type, recordId: r.record.id },
        series: { key: r.record.type, label: `${t.label} receipt`, prefix: 'RCPT' },
        record: r.record,
        recordType: { key: t.key, label: t.label, titleField: t.titleField ?? null },
        organisation: { name: s.tenant.name },
        issuer: {
          displayName: s.tenant.name,
          legalName: s.tenant.name,
          contact: { email: 'office@demo.test', phone: null, website: null },
          address: { line1: '12 MG Road', line2: null, city: 'Pune', state: 'MH', postalCode: '411001', country: 'IN' },
          registrations: [{ type: '80g', number: 'AAATD1234F', issuingAuthority: 'Income Tax Department' }],
          logoUrl: null,
          signatory: null,
          signatoryImageUrl: null,
        },
        issuerSource: 'issued' as const,
        publicLink: null,
      });
    },
    async pendingApproval(type, id) {
      log('records', 'pendingApproval', [type, id]);
      stored(type, id);
      const a = pendingFor(id);
      if (!a) return null;
      const p: PendingApproval = {
        id: a.id,
        transition: a.transition,
        requestedBy: user(a.requestedBy)?.displayName ?? a.requestedBy,
        approvalsGiven: a.approvalsGiven,
        approvalsNeeded: a.approvalsNeeded,
        canDecide: a.requestedBy !== me,
      };
      return p;
    },
    async decide(approvalId, decision) {
      log('records', 'decide', [approvalId, decision]);
      return decideApproval(approvalId, decision);
    },
  };

  const token = (id: string): SignInResult => {
    me = id;
    return { accessToken: `memory.${id}`, expiresIn: 900 };
  };
  const byEmail = (tenant: string, email: string) => (tenant === s.tenant.key ? s.users.find((u) => u.email === email.trim().toLowerCase()) : undefined);
  let resetPassword: { userId: string; token: string } | null = null;

  const authPort: AuthGateway = {
    async me() {
      log('auth', 'me', []);
      const u = user(signedIn())!;
      const admin = u.roles.includes('admin');
      return {
        userId: u.id,
        displayName: u.displayName,
        email: u.email,
        twoStepEnabled: false,
        tenant: clone(s.tenant),
        roles: [...u.roles],
        permissions: admin ? ['*'] : ['record:donor:read', 'record:donation:read', 'record:donation:update'],
        capabilities: { configure: admin, publish: admin, scripts: false, money: true },
      };
    },
    async definitions() {
      log('auth', 'definitions', []);
      signedIn();
      return clone({ ...s.definitions, locale });
    },
    async login(input) {
      log('auth', 'login', [{ ...input, password: '***' }]);
      const u = byEmail(input.tenant, input.email);
      if (!u || u.password !== input.password) throw fail('invalid_credentials', 'That email and password do not match.');
      return token(u.id);
    },
    async requestCode(tenant, email) {
      log('auth', 'requestCode', [tenant, email]);
    },
    async verifyCode(input) {
      log('auth', 'verifyCode', [input]);
      const u = byEmail(input.tenant, input.email);
      if (!u || input.code !== '123456') throw fail('invalid_code', 'That code is not right or has expired.');
      return token(u.id);
    },
    async completeTwoStep(ticket, totpCode) {
      log('auth', 'completeTwoStep', [ticket, totpCode]);
      throw fail('invalid_ticket', 'Two-step sign-in is not set up in the sample organisation.');
    },
    async logout() {
      log('auth', 'logout', []);
      me = null;
    },
    async providers(tenant) {
      log('auth', 'providers', [tenant]);
      return [];
    },
    async requestPasswordReset(tenant, email) {
      log('auth', 'requestPasswordReset', [tenant, email]);
      const u = byEmail(tenant, email);
      resetPassword = u ? { userId: u.id, token: `reset.${u.id}` } : null;
    },
    async passwordTokenUsable(checked) {
      log('auth', 'passwordTokenUsable', [checked]);
      return !!resetPassword && resetPassword.token === checked;
    },
    async completePasswordReset(resetToken, password) {
      log('auth', 'completePasswordReset', [resetToken, '***']);
      if (!resetPassword || resetPassword.token !== resetToken) throw fail('invalid_token', 'This link has expired. Ask for a new one.');
      if (password.length < 10) throw fail('invalid', 'Use at least 10 characters.', [{ path: '/password', message: 'Use at least 10 characters.' }]);
      user(resetPassword.userId)!.password = password;
      resetPassword = null;
    },
    async messages(requested) {
      log('auth', 'messages', [requested]);
      signedIn();
      const l = requested ?? locale;
      return { locale: l, messages: { ...ENGLISH, ...(l === 'en' ? {} : (s.messages[l] ?? {})) } };
    },
    async setLocale(next) {
      log('auth', 'setLocale', [next]);
      signedIn();
      if (!(LOCALES as readonly string[]).includes(next) && !s.messages[next]) throw fail('invalid', `'${next}' is not a language this organisation offers.`);
      locale = next;
      return { locale };
    },
  };

  /** Requests the signed-in person may still decide: pending, asked by someone else, not yet decided by them. */
  const waitingFor = (who: string) => approvals.filter((a) => a.status === 'pending' && a.requestedBy !== who && !decidedBy.get(a.id)?.has(who));
  const approvalRow = (a: SampleApproval): ApprovalRow => {
    const r = records.get(a.recordId)!.record;
    const t = recordType(a.recordType);
    const wf = workflowsOf(a.recordType).find((w) => w.transitions.some((x) => x.key === a.transition))!;
    const step = wf.transitions.find((x) => x.key === a.transition)!;
    const status = wf.key === r.workflow || wf.role !== 'parallel' ? r.status : r.states?.[wf.key];
    const label = (key: string | null | undefined) => wf.states.find((x) => x.key === key)?.label ?? key ?? '';
    const title = t.titleField ? r.data[t.titleField] : undefined;
    return {
      id: a.id,
      recordId: a.recordId,
      recordType: a.recordType,
      recordTypeLabel: t.label,
      recordNumber: r.number,
      recordTitle: blank(title) ? (r.number ?? r.id) : String(title),
      step: a.transition,
      stepLabel: step.label,
      fromStatusLabel: label(status),
      toStatusLabel: label(step.to),
      requestedBy: a.requestedBy,
      requestedByName: user(a.requestedBy)?.displayName ?? null,
      requestedAt: a.createdAt,
      approvalsGiven: a.approvalsGiven,
      approvalsNeeded: a.approvalsNeeded,
    };
  };
  const approvalSortValue = (row: ApprovalRow, field: string): string =>
    field === 'record' ? (row.recordNumber ?? row.recordTitle) : field === 'type' ? row.recordTypeLabel : field === 'step' ? row.stepLabel : field === 'requestedBy' ? (row.requestedByName ?? row.requestedBy) : '';

  const inboxPort: InboxGateway = {
    async queryApprovals(body: ApprovalQueryBody) {
      log('inbox', 'queryApprovals', [body]);
      const q = body.search?.trim().toLowerCase();
      const f = body.filters ?? {};
      const sort = body.sort ?? { field: 'waiting', dir: 'desc' as const };
      const rows = waitingFor(signedIn())
        .map(approvalRow)
        .filter((r) => !q || [r.recordNumber, r.recordTitle].some((v) => v?.toLowerCase().includes(q)))
        .filter((r) => (!f.type?.length || f.type.includes(r.recordType)) && (!f.step?.length || f.step.includes(r.step)) && (!f.requestedBy?.length || f.requestedBy.includes(r.requestedBy)))
        .sort((a, b) => {
          // Waiting descending puts the oldest request first.
          const c = sort.field === 'waiting' ? b.requestedAt.localeCompare(a.requestedAt) : approvalSortValue(a, sort.field).localeCompare(approvalSortValue(b, sort.field));
          return (sort.dir === 'desc' ? -c : c) || a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id);
        });
      const offset = body.offset ?? 0;
      return clone({ items: rows.slice(offset, offset + (body.limit ?? 50)), total: rows.length });
    },
    async countApprovals() {
      log('inbox', 'countApprovals', []);
      return { waiting: waitingFor(signedIn()).length };
    },
    async approvals() {
      log('inbox', 'approvals', []);
      const who = signedIn();
      return waitingFor(who)
        .map((a): ApprovalItem => {
          const r = records.get(a.recordId)?.record;
          return {
            id: a.id,
            recordId: a.recordId,
            recordType: a.recordType,
            recordNumber: r?.number ?? null,
            transitionLabel: workflowsOf(a.recordType).flatMap((w) => w.transitions).find((x) => x.key === a.transition)?.label ?? a.transition,
            requestedByName: user(a.requestedBy)?.displayName ?? null,
            approvalsNeeded: a.approvalsNeeded,
            approvalsGiven: a.approvalsGiven,
            createdAt: a.createdAt,
          };
        });
    },
    async decide(approvalId, decision, comment) {
      log('inbox', 'decide', [approvalId, decision, comment]);
      return decideApproval(approvalId, decision);
    },
    async notifications(query = {}) {
      log('inbox', 'notifications', [query]);
      const who = signedIn();
      const mine = notifications
        .filter((n) => n.userId === who && (!query.unreadOnly || !n.readAt))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const after = query.before ? mine.findIndex((n) => n.id === query.before) + 1 : 0;
      if (query.before && after === 0) throw fail('validation_failed', 'The paging cursor is not valid.');
      return clone(mine.slice(after, after + Math.min(Math.max(query.limit ?? 50, 1), 200)).map(({ userId: _, ...n }) => n));
    },
    async markRead(notificationId) {
      log('inbox', 'markRead', [notificationId]);
      const n = notifications.find((x) => x.id === notificationId && x.userId === signedIn());
      if (!n) throw fail('not_found', 'Notification not found.');
      if (!n.readAt) n.readAt = now();
    },
    async markAllRead() {
      log('inbox', 'markAllRead', []);
      const who = signedIn();
      const at = now();
      const unread = notifications.filter((n) => n.userId === who && !n.readAt);
      for (const n of unread) n.readAt = at;
      return { marked: unread.length };
    },
  };

  const definitions = new Map<string, StoredDefinition>();
  const defKey = (kind: string, key: string) => `${kind}/${key}`;
  const shipped = (kind: DefinitionKind, key: string, body: Record<string, unknown>) =>
    definitions.set(defKey(kind, key), {
      kind,
      key,
      owner: 'base',
      moduleKey: 'donations',
      baseVersion: 1,
      base: clone(body),
      patch: null,
      history: [{ version: 1, status: 'published', body: clone(body), published_at: '2026-04-01T00:00:00.000Z' }],
      draft: null,
    });
  const bodyOf = <T extends object>(v: T): Record<string, unknown> => {
    const { version: _v, canCreate: _c, canUpdate: _u, ...rest } = v as T & { version?: unknown; canCreate?: unknown; canUpdate?: unknown };
    return clone(rest) as Record<string, unknown>;
  };
  for (const t of s.definitions.recordTypes) shipped('recordType', t.key, bodyOf(t));
  for (const wfs of Object.values(s.definitions.workflowSets ?? s.definitions.workflows)) {
    for (const w of Array.isArray(wfs) ? wfs : [wfs]) {
      const { transitions, ...rest } = bodyOf(w) as unknown as WorkflowBody;
      shipped('workflow', w.key, { ...rest, transitions: transitions.map(({ allowed: _a, ...t }: WorkflowBody['transitions'][number] & { allowed?: boolean }) => t) });
    }
  }
  const definition = (kind: string, key: string) => {
    const d = definitions.get(defKey(kind, key));
    if (!d) throw fail('not_found', 'This definition does not exist yet.');
    return d;
  };
  const published = (d: StoredDefinition) => d.history.find((h) => h.status === 'published') ?? null;
  const latestVersion = (d: StoredDefinition) => Math.max(0, d.draft?.version ?? 0, ...d.history.map((h) => h.version));
  const canPublish = (kind: string) => {
    const u = user(signedIn())!;
    if (!u.roles.includes('admin') || kind === 'script') throw fail('forbidden', 'You cannot publish this kind of definition.');
  };
  /** Puts a newly published record type or workflow into what the app loads. */
  const goLive = (d: StoredDefinition, body: Record<string, unknown>, version: number) => {
    if (d.kind === 'recordType') {
      const live: RuntimeRecordType = { ...(body as unknown as RecordTypeBody), version, canCreate: true, canUpdate: true };
      s.definitions.recordTypes = [...s.definitions.recordTypes.filter((t) => t.key !== d.key), live];
    } else if (d.kind === 'workflow') {
      const w = body as unknown as WorkflowBody;
      const live: RuntimeWorkflow = { ...w, transitions: w.transitions.map((t) => ({ ...t, allowed: true })) };
      if (w.role !== 'parallel') s.definitions.workflows = { ...s.definitions.workflows, [w.recordType]: live };
      const set = (s.definitions.workflowSets?.[w.recordType] ?? []).filter((x) => x.key !== w.key);
      s.definitions.workflowSets = { ...(s.definitions.workflowSets ?? {}), [w.recordType]: w.role === 'parallel' ? [...set, live] : [live, ...set] };
    }
  };
  const publishBody = (d: StoredDefinition, body: Record<string, unknown>, version = latestVersion(d) + 1) => {
    for (const h of d.history) if (h.status === 'published') h.status = 'superseded';
    d.history.unshift({ version, status: 'published', body: clone(body), published_at: now() });
    d.draft = null;
    goLive(d, body, version);
  };

  const builderPort: BuilderGateway = {
    async catalogue() {
      log('builder', 'catalogue', []);
      return [...definitions.values()].map(
        (d): CatalogueItem => ({
          kind: d.kind,
          key: d.key,
          label: (d.draft?.body['label'] ?? published(d)?.body['label'] ?? null) as string | null,
          publishedVersion: published(d)?.version ?? null,
          draftVersion: d.draft?.version ?? null,
          owner: d.owner,
          moduleKey: d.moduleKey,
        }),
      );
    },
    async detail(kind, key) {
      log('builder', 'detail', [kind, key]);
      const d = definition(kind, key);
      const p = published(d);
      const out: BuilderDetail = {
        kind: d.kind,
        key: d.key,
        published: p ? { version: p.version, owner: d.owner, baseVersion: d.baseVersion, body: clone(p.body) } : null,
        draft: clone(d.draft),
        history: d.history.map((h) => ({ version: h.version, status: h.status, base_version: d.baseVersion, published_at: h.published_at })),
        shipped: d.owner === 'base' && d.base ? { baseVersion: d.baseVersion ?? 1, base: clone(d.base), patch: clone(d.patch) } : null,
      };
      return out;
    },
    async saveDraft(kind, key, body) {
      log('builder', 'saveDraft', [kind, key, body]);
      signedIn();
      const k = kind as DefinitionKind;
      if ((body as { key?: unknown }).key !== key) throw fail('validation_failed', 'The key in the body must match the address.');
      if (definitions.get(defKey(k, key))?.owner === 'base') throw fail('definition_invalid', 'Shipped definitions are changed through extension patches.');
      const d =
        definitions.get(defKey(k, key)) ??
        (definitions.set(defKey(k, key), { kind: k, key, owner: 'tenant', moduleKey: null, baseVersion: null, base: null, patch: null, history: [], draft: null }).get(defKey(k, key)) as StoredDefinition);
      d.draft = { version: d.draft?.version ?? latestVersion(d) + 1, body: clone(body as Record<string, unknown>) };
    },
    async publish(kind, key) {
      log('builder', 'publish', [kind, key]);
      canPublish(kind);
      const d = definition(kind, key);
      if (!d.draft) throw fail('no_draft', 'There is no draft to publish.');
      publishBody(d, d.draft.body, d.draft.version);
    },
    async discard(kind, key) {
      log('builder', 'discard', [kind, key]);
      const d = definition(kind, key);
      d.draft = null;
      if (!d.history.length) definitions.delete(defKey(kind, key));
    },
    async rollback(kind, key, version) {
      log('builder', 'rollback', [kind, key, version]);
      canPublish(kind);
      const d = definition(kind, key);
      const old = d.history.find((h) => h.version === version);
      if (!old) throw fail('not_found', `There is no version ${version}.`);
      publishBody(d, old.body);
    },
    async savePatch(kind, key, patch) {
      log('builder', 'savePatch', [kind, key, patch]);
      canPublish(kind);
      const d = definition(kind, key);
      if (d.owner !== 'base' || !d.base) throw fail('invalid', 'Only shipped definitions are changed with a patch.');
      d.patch = clone(patch);
      publishBody(d, applyExtensionPatch(d.base, patch));
    },
    async check(kind, key, body) {
      log('builder', 'check', [kind, key, body]);
      const d = definitions.get(defKey(kind, key));
      const sent = body as Record<string, unknown> | undefined;
      const target =
        sent && 'patch' in sent && d?.base
          ? (applyExtensionPatch(d.base, sent['patch']) as Record<string, unknown>)
          : sent && Object.keys(sent).length
            ? sent
            : (d?.draft?.body ?? (d && published(d)?.body));
      if (!target) throw fail('not_found', 'There is no draft to check.');
      return { errors: definitionErrors(kind, key, target), warnings: [] };
    },
    async changes(kind, key, against) {
      log('builder', 'changes', [kind, key, against]);
      const d = definition(kind, key);
      const p = published(d);
      const before = against === 'module' ? d.base : p?.body;
      const after = against === 'module' ? p?.body : (d.draft?.body ?? p?.body);
      if (against === 'module' && !d.base) throw fail('not_found', 'This definition does not come from a module.');
      return {
        against,
        from: against === 'module' ? { version: d.baseVersion ?? 1, module: true } : p ? { version: p.version, module: false } : null,
        to: { version: against === 'module' ? (p?.version ?? null) : (d.draft?.version ?? p?.version ?? null), draft: against === 'published' && !!d.draft },
        lines: changeLines(before ?? undefined, after ?? {}),
        warnings: [],
      };
    },
    async publishedRecordType(key) {
      log('builder', 'publishedRecordType', [key]);
      const p = published(definition('recordType', key));
      if (!p) throw fail('not_found', 'This record type is not published.');
      return { body: clone(p.body) as unknown as RecordTypeBody };
    },
    async checkExpression(request) {
      log('builder', 'checkExpression', [request]);
      signedIn();
      const p = request.recordType ? definitions.get(defKey('recordType', request.recordType)) : undefined;
      const body = p && published(p)?.body;
      if (request.recordType && !body) throw fail('not_found', `Record type '${request.recordType}' is not published.`);
      const subject = { recordType: (body as unknown as RecordTypeBody) ?? null, workflows: request.recordType ? workflowsOf(request.recordType).map((w) => w.key) : [] };
      return localCheck(request.source, subject, request.context, request.input);
    },
    async tryExpression(request) {
      log('builder', 'tryExpression', [request]);
      const u = user(signedIn())!;
      const person = { id: u.id, roles: [...u.roles] };
      let scope: Record<string, unknown>;
      if (request.recordId) {
        const r = records.get(request.recordId)?.record;
        if (!r || (request.recordType && r.type !== request.recordType)) throw fail('not_found', 'Record not found.');
        scope = { record: { ...r.data, id: r.id, number: r.number }, previous: {}, status: r.status, previousStatus: null, workflow: r.workflow ?? null, states: { ...r.states, ...(r.workflow ? { [r.workflow]: r.status } : {}) }, user: person, input: {} };
      } else {
        const x = request.sample ?? {};
        scope = { record: x.record ?? {}, previous: x.previous ?? {}, status: x.status ?? null, previousStatus: x.previousStatus ?? null, workflow: x.workflow ?? null, states: x.states ?? {}, user: person, input: x.input ?? {} };
      }
      try {
        const value = compileExpression(request.source).evaluate(scope);
        return { ok: true, value, resultType: valueTypeOf(value) };
      } catch (e) {
        if (e instanceof ExpressionError) return { ok: false, error: e.message, position: e.position };
        throw e;
      }
    },
    async usages(kind, key, field) {
      log('builder', 'usages', [kind, key, field]);
      const out: Usage[] = [];
      if (kind !== 'recordType') return out;
      for (const d of definitions.values()) {
        const body = published(d)?.body;
        if (!body || body['recordType'] !== key) continue;
        const label = typeof body['label'] === 'string' ? body['label'] : null;
        if (!field) out.push({ kind: d.kind, key: d.key, label, path: '/recordType', what: d.kind });
        else for (const prop of ['columns', 'filters']) if ((body[prop] as string[] | undefined)?.includes(field)) out.push({ kind: d.kind, key: d.key, label, path: `/${prop}`, what: prop });
      }
      return out;
    },
    async nextNumber(sequence, reset) {
      log('builder', 'nextNumber', [sequence, reset]);
      const fy = financialYear(now());
      return { next: (sequences.get(sequence) ?? 0) + 1, fy, period: reset === 'never' ? 'all' : fy };
    },
  };

  const peoplePort: PeopleGateway = {
    async pick(q) {
      log('people', 'pick', [q]);
      signedIn();
      const text = q.trim().toLowerCase();
      return s.users
        .filter((u) => (u.status ?? 'active') === 'active' && (!text || `${u.displayName} ${u.email}`.toLowerCase().includes(text)))
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .slice(0, PICK_LIMIT)
        .map((u) => ({ id: u.id, name: u.displayName, email: u.email }));
    },
  };

  const editorPort: EditorGateway = {
    async schema(kind) {
      log('editor', 'schema', [kind]);
      const schema = s.schemas?.[kind];
      if (!schema) throw fail('not_found', 'Unknown definition kind.');
      return clone(schema);
    },
    async permissionSuggestions(q) {
      log('editor', 'permissionSuggestions', [q]);
      const text = q.trim().toLowerCase();
      return s.definitions.recordTypes
        .flatMap((type) => ['read', 'create', 'update', 'sensitive'].map((op) => `record:${type.key}:${op}`))
        .filter((p) => !text || p.includes(text))
        .map((permission) => ({ permission, label: permission, source: 'generated' as const, usedIn: [], roles: 0 }));
    },
    async roles() {
      log('editor', 'roles', []);
      return [...new Set(s.users.flatMap((u) => u.roles))].map((key) => ({ key, label: key }));
    },
    async indexWarnings(type) {
      log('editor', 'indexWarnings', [type]);
      recordType(type);
      return { pending: [], notIndexed: [] };
    },
    async connectors() {
      log('editor', 'connectors', []);
      return [];
    },
  };

  const sharesPort: SharesGateway = {
    async list(type, id) {
      log('shares', 'list', [type, id]);
      const r = managed(type, id);
      return clone(shareRows.filter((x) => x.recordId === r.record.id).map(({ recordId: _, ...share }) => share));
    },
    async share(type, id, input) {
      log('shares', 'share', [type, id, input]);
      const r = managed(type, id);
      if (recordType(type).visibility !== 'restricted') throw fail('rule_violation', `${recordType(type).label} records are visible to everyone who may see them, so they are not shared.`);
      const issues: { path: string; message: string }[] = [];
      const person = input.principalKind === 'user' ? s.users.find((u) => u.id === input.principal && (u.status ?? 'active') === 'active') : undefined;
      const role = input.principalKind === 'role' ? roles().find((x) => x.key === input.principal) : undefined;
      if (input.principalKind !== 'user' && input.principalKind !== 'role') issues.push({ path: '/principalKind', message: 'must be user or role' });
      else if (!person && !role) issues.push({ path: '/principal', message: input.principalKind === 'user' ? 'is not a member of this organisation' : 'is not a role of this organisation' });
      if (input.access !== 'read' && input.access !== 'edit') issues.push({ path: '/access', message: 'must be read or edit' });
      const end = input.expiresAt ? Date.parse(`${input.expiresAt}T00:00:00Z`) + 86_400_000 : null;
      if (end !== null && (Number.isNaN(end) || new Date(end).toISOString() <= s.now)) issues.push({ path: '/expiresAt', message: 'must be in the future' });
      if (issues.length) throw fail('invalid', 'The share is not valid.', issues);
      const expiresAt = end === null ? null : new Date(end).toISOString();
      const existing = shareRows.find((x) => x.recordId === r.record.id && x.principalKind === input.principalKind && x.principal === input.principal);
      if (existing) Object.assign(existing, { access: input.access, expiresAt });
      const row = existing ?? {
        id: `share-${++shareNo}`,
        recordId: r.record.id,
        principalKind: input.principalKind,
        principal: input.principal,
        name: person?.displayName ?? role!.label,
        access: input.access,
        createdBy: signedIn(),
        createdAt: now(),
        expiresAt,
      };
      if (!existing) shareRows.push(row);
      const { recordId: _, ...share } = row;
      return clone(share);
    },
    async remove(type, id, shareId) {
      log('shares', 'remove', [type, id, shareId]);
      const r = managed(type, id);
      const at = shareRows.findIndex((x) => x.recordId === r.record.id && x.id === shareId);
      if (at < 0) throw fail('not_found', 'Share not found.');
      shareRows.splice(at, 1);
    },
    async candidates(type, id, q) {
      log('shares', 'candidates', [type, id, q]);
      managed(type, id);
      const text = q.trim().toLowerCase();
      const hit = (...values: string[]) => !text || values.some((v) => v.toLowerCase().includes(text));
      const grants = (keys: string[]) => keys.flatMap((k) => roles().find((r) => r.key === k)?.permissions ?? []);
      const allows = (permissions: string[]) => ({
        canSee: permissions.some((p) => permissionMatches(p, `record:${type}:read`)),
        canEdit: permissions.some((p) => permissionMatches(p, `record:${type}:update`)),
      });
      return [
        ...s.users
          .filter((u) => u.id !== me && (u.status ?? 'active') === 'active' && hit(u.displayName, u.email))
          .slice(0, 8)
          .map((u) => ({ principalKind: 'user' as const, principal: u.id, name: u.displayName, email: u.email, ...allows(grants(u.roles)) })),
        ...roles()
          .filter((x) => hit(x.label, x.key))
          .slice(0, 8)
          .map((x) => ({ principalKind: 'role' as const, principal: x.key, name: x.label, ...allows(x.permissions ?? []) })),
      ];
    },
  };

  const pinRows: (Pin & { userId: string })[] = [];
  let pinNo = 0;
  const myPins = () => pinRows.filter((p) => p.userId === signedIn()).sort((a, b) => a.position - b.position);
  const myPin = (id: string) => {
    const p = pinRows.find((x) => x.id === id && x.userId === signedIn());
    if (!p) throw fail('not_found', 'Pin not found.');
    return p;
  };
  const pinLabelOf = (label: unknown) => {
    const v = typeof label === 'string' ? label.trim() : '';
    if (!v || v.length > 80) throw fail('validation_failed', 'The pin is not valid.', [{ path: '/label', message: v ? 'Use at most 80 characters.' : 'Give the pin a name.' }]);
    return v;
  };
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const bucketOf = (r: RecordView, groupBy: NonNullable<AggregateRequest['groupBy']>, t: RuntimeRecordType): { key: string; label: string } | null => {
    if ('field' in groupBy) {
      const v = valueOf(r, groupBy.field);
      if (blank(v)) return null;
      const label = t.fields.find((f) => f.key === groupBy.field)?.choices?.find((c) => c.value === v)?.label;
      return { key: String(v), label: label ?? String(v) };
    }
    const iso = String(valueOf(r, groupBy.dateField) ?? '');
    if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
    const date = iso.slice(0, 10);
    switch (groupBy.period) {
      case 'day':
        return { key: date, label: date };
      case 'week': {
        const d = new Date(`${date}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
        const monday = d.toISOString().slice(0, 10);
        return { key: monday, label: monday };
      }
      case 'month':
        return { key: date.slice(0, 7), label: `${MONTH_NAMES[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}` };
      default:
        return { key: financialYear(date), label: financialYear(date) };
    }
  };

  const pagesPort: PagesGateway = {
    async aggregate(type, body) {
      log('pages', 'aggregate', [type, body]);
      const t = recordType(type);
      if (body.measure === 'sum' && !t.fields.some((f) => f.key === body.field && (f.type === 'number' || f.type === 'money'))) {
        throw fail('validation_failed', 'Choose a number or money field to total.');
      }
      const amount = (r: RecordView) => (body.measure === 'count' ? 1 : typeof r.data[body.field!] === 'number' ? (r.data[body.field!] as number) : 0);
      const matched = [...records.values()]
        .filter((x) => {
          const { record: r, owner } = x;
          if (r.type !== type) return false;
          if (body.statusIn?.length && !body.statusIn.includes(r.status ?? '')) return false;
          if (body.owner === 'me' && owner !== me) return false;
          if (body.sharedWithMe && !sharedWithMe(x)) return false;
          return Object.entries(body.filters ?? {}).every(([k, f]) => filterHolds(valueOf(r, k), f));
        })
        .map((x) => x.record);
      if (!body.groupBy) return { value: matched.reduce((n, r) => n + amount(r), 0) };
      const buckets = new Map<string, { key: string; label: string; value: number }>();
      for (const r of matched) {
        const b = bucketOf(r, body.groupBy, t);
        if (!b) continue;
        const entry = buckets.get(b.key) ?? { ...b, value: 0 };
        entry.value += amount(r);
        buckets.set(b.key, entry);
      }
      return { buckets: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)) };
    },
    async pins() {
      log('pages', 'pins', []);
      return clone(myPins().map(({ userId: _, ...p }) => p));
    },
    async addPin(input) {
      log('pages', 'addPin', [input]);
      const label = pinLabelOf(input.label);
      const type = /^\/records\/([A-Za-z][\w-]*)(\?[^#\s]*)?$/.exec(input.address)?.[1];
      if (!type) throw fail('validation_failed', 'The pin is not valid.', [{ path: '/address', message: 'Only record lists of this app can be pinned.' }]);
      recordType(type);
      if (myPins().length >= 20) throw fail('validation_failed', 'You can pin up to 20 lists. Unpin one first.');
      const row = { id: `pin-${++pinNo}`, userId: signedIn(), label, listView: input.listView, address: input.address, position: (myPins().at(-1)?.position ?? -1) + 1 };
      pinRows.push(row);
      const { userId: _, ...p } = row;
      return clone(p);
    },
    async renamePin(id, label) {
      log('pages', 'renamePin', [id, label]);
      const p = myPin(id);
      p.label = pinLabelOf(label);
      const { userId: _, ...out } = p;
      return clone(out);
    },
    async orderPins(ids) {
      log('pages', 'orderPins', [ids]);
      const mine = myPins();
      const order = [...new Set(ids)].filter((id) => mine.some((p) => p.id === id));
      [...order, ...mine.map((p) => p.id).filter((id) => !order.includes(id))].forEach((id, position) => (myPin(id).position = position));
      return clone(myPins().map(({ userId: _, ...p }) => p));
    },
    async removePin(id) {
      log('pages', 'removePin', [id]);
      pinRows.splice(pinRows.indexOf(myPin(id)), 1);
    },
    async homePage() {
      log('pages', 'homePage', []);
      const d = definitions.get(defKey('page', 'home'));
      return clone((d?.draft?.body ?? (d && published(d)?.body) ?? null) as PageDef | null);
    },
    async saveHomeDraft(body) {
      log('pages', 'saveHomeDraft', [body]);
      if (!user(signedIn())?.roles.includes('admin')) throw fail('forbidden', 'You cannot change the Home page.');
      await builderPort.saveDraft('page', 'home', body);
    },
  };

  const roleRows: Omit<RoleView, 'members'>[] = roles().map((r: NonNullable<SampleSeed['roles']>[number]) => ({
    key: r.key,
    label: r.label,
    permissions: r.permissions ?? (r.key === 'admin' ? ['*'] : []),
    requireTwoStep: r.requireTwoStep ?? false,
    customised: false,
  }));
  const roleView = (r: Omit<RoleView, 'members'>): RoleView => ({ ...clone(r), members: s.users.filter((u) => u.roles.includes(r.key)).length });
  const roleRow = (key: string) => {
    const r = roleRows.find((x) => x.key === key);
    if (!r) throw fail('not_found', `Role '${key}' does not exist.`);
    return r;
  };
  const publishedBodies = (kind: DefinitionKind) =>
    [...definitions.values()].filter((d) => d.kind === kind).flatMap((d) => (published(d) ? [published(d)!.body] : []));
  /** Published definitions, with the sample's list views and pages where the Builder holds none. */
  const accessDefs = (): PermissionDefs =>
    ({
      recordTypes: publishedBodies('recordType'),
      workflows: publishedBodies('workflow'),
      listViews: [...publishedBodies('listView'), ...Object.values(s.definitions.listViews ?? {}).filter((v) => !definitions.has(defKey('listView', v.key)))],
      actions: publishedBodies('action'),
      pages: [...publishedBodies('page'), ...(s.definitions.pages ?? []).filter((p) => !definitions.has(defKey('page', p.key)))],
    }) as unknown as PermissionDefs;
  const modules: ModuleRow[] = [
    {
      key: 'donations',
      label: 'Donations',
      description: 'Donors, donations and receipts',
      version: '0.2.3',
      installedVersion: '0.2.0',
      enabled: true,
      dependsOn: [],
      definitions: [
        { kind: 'recordType', key: 'donor' },
        { kind: 'recordType', key: 'donation' },
        { kind: 'workflow', key: 'donation' },
        { kind: 'listView', key: 'donations' },
      ],
      updateAvailable: true,
    },
    {
      key: 'programmes',
      label: 'Programmes',
      description: 'Beneficiaries and visits',
      version: '0.1.0',
      installedVersion: null,
      enabled: false,
      dependsOn: [],
      definitions: [
        { kind: 'recordType', key: 'beneficiary' },
        { kind: 'recordType', key: 'visit' },
        { kind: 'listView', key: 'visits' },
      ],
      updateAvailable: false,
    },
  ];
  const moduleRow = (key: string) => {
    const m = modules.find((x) => x.key === key);
    if (!m) throw fail('not_found', `Unknown module '${key}'.`);
    return m;
  };

  const accessPort: AccessGateway = {
    async roles() {
      log('access', 'roles', []);
      signedIn();
      return roleRows.map(roleView);
    },
    async role(key) {
      log('access', 'role', [key]);
      return roleView(roleRow(key));
    },
    async createRole(input) {
      log('access', 'createRole', [input]);
      if (!input.key || !/^[a-z][a-z0-9_-]{0,40}$/.test(input.key)) throw fail('validation_failed', 'Role key must start with a lowercase letter.', [{ path: 'key', message: 'Use lowercase letters, digits, - or _.' }]);
      if (roleRows.some((r) => r.key === input.key)) throw fail('conflict', `A role with the key '${input.key}' already exists.`);
      const row = { key: input.key, label: input.label?.trim() || input.key, permissions: input.permissions ?? [], requireTwoStep: !!input.requireTwoStep, customised: true };
      roleRows.push(row);
      return roleView(row);
    },
    async saveRole(key, input) {
      log('access', 'saveRole', [key, input]);
      const r = roleRow(key);
      if (input.label !== undefined && !input.label.trim()) throw fail('validation_failed', 'Give the role a name of at most 80 characters.', [{ path: 'label', message: 'Required, at most 80 characters.' }]);
      Object.assign(r, {
        ...(input.label !== undefined && { label: input.label.trim() }),
        ...(input.permissions && { permissions: [...new Set(input.permissions)] }),
        ...(input.requireTwoStep !== undefined && { requireTwoStep: input.requireTwoStep }),
        customised: true,
      });
      return roleView(r);
    },
    async deleteRole(key) {
      log('access', 'deleteRole', [key]);
      const r = roleView(roleRow(key));
      if (r.members) throw fail('conflict', `'${r.label}' still has ${r.members} members. Move them to another role first.`);
      roleRows.splice(roleRows.findIndex((x) => x.key === key), 1);
    },
    async permissionCatalogue() {
      log('access', 'permissionCatalogue', []);
      const defs = accessDefs();
      const groups: CatalogueGroup[] = [];
      const entries: CatalogueEntry[] = [];
      const add = (group: string, permission: string, label: string) => {
        if (!entries.some((e) => e.permission === permission)) entries.push({ permission, label, group });
      };
      for (const type of defs.recordTypes) {
        const g = `record:${type.key}`;
        const plural = type.pluralLabel ?? type.label;
        groups.push({ key: g, label: plural, kind: 'recordType' });
        for (const [op, label] of [['read', 'See'], ['create', 'Add'], ['update', 'Edit'], ['sensitive', 'See sensitive details of'], ['import', 'Import'], ['export', 'Export'], ['bulk', 'Change many']]) {
          add(g, `${g}:${op}`, `${label} ${plural.toLowerCase()}`);
        }
        for (const w of defs.workflows.filter((x) => x.recordType === type.key)) for (const tr of w.transitions) add(g, tr.permission ?? `${g}:transition:${tr.key}`, `Step: ${tr.label}`);
        for (const a of defs.actions.filter((x) => x.recordType === type.key)) add(g, a.permission ?? `${g}:action:${a.key}`, `Action: ${a.label}`);
      }
      groups.push({ key: 'money', label: 'Money', kind: 'money' });
      add('money', 'money:accounts:read', 'See money accounts');
      groups.push({ key: 'setup', label: 'Setup', kind: 'setup' });
      for (const [p, label] of [['config:read', 'See the setup'], ['config:publish', 'Change and publish the setup'], ['people:read', 'See people'], ['members:manage', 'Manage people'], ['admin:roles', 'Manage roles']]) add('setup', p!, label!);
      const used = (['recordType', 'workflow', 'listView', 'action', 'page'] as const).flatMap((kind) =>
        (kind === 'recordType' ? defs.recordTypes : kind === 'workflow' ? defs.workflows : kind === 'listView' ? defs.listViews : kind === 'action' ? defs.actions : defs.pages).flatMap((b) =>
          explicitPermissions(kind, b as never),
        ),
      );
      const others = [...new Set(used.map((u) => u.permission))].filter((p) => !entries.some((e) => e.permission === p)).sort();
      if (others.length) groups.push({ key: 'used', label: 'Used in definitions', kind: 'used' });
      for (const p of others) add('used', p, 'Used in definitions');
      return { groups, entries };
    },
    async accessMap(query = {}) {
      log('access', 'accessMap', [query]);
      signedIn();
      const role = query.role ? roleRow(query.role) : undefined;
      const defs = accessDefs();
      const generated = generatedPermissions(defs);
      const grants = roleRows.flatMap((r) => r.permissions);
      const audiences = new Map(defs.pages.map((p) => [p.key, p.audience ?? []]));
      const elements = accessElements(defs).map((e): AccessMapElement => {
        const audience = e.definition?.kind === 'page' ? audiences.get(e.definition.key) : undefined;
        const holders = audience?.length ? roleRows.filter((r) => audience.includes(r.key)) : roleRows;
        const holding = e.permission ? holders.filter((r) => r.permissions.some((g) => permissionMatches(g, e.permission!))) : holders;
        const warnings = e.permission && !isKnownPermission(e.permission, generated, grants) ? [`No role has '${e.permission}' yet.`] : [];
        return { ...(e as AccessMapElement), roles: holding.map((r) => r.key), warnings, ...(role ? { visible: holding.includes(role) } : {}) };
      });
      return clone({ elements, ...(role ? { role: { key: role.key, label: role.label, summary: '' } } : {}) });
    },
    async modules() {
      log('access', 'modules', []);
      return clone(modules);
    },
    async enableModule(key) {
      log('access', 'enableModule', [key]);
      Object.assign(moduleRow(key), { enabled: true, updateAvailable: false, installedVersion: moduleRow(key).version });
    },
    async disableModule(key) {
      log('access', 'disableModule', [key]);
      moduleRow(key).enabled = false;
    },
    async moduleUpdate(key) {
      log('access', 'moduleUpdate', [key]);
      const m = moduleRow(key);
      return { key, label: m.label, installedVersion: m.installedVersion, version: m.version, enabled: m.enabled, definitions: [], conflicts: [], canUpdate: true };
    },
  };

  return {
    records: recordsPort,
    auth: authPort,
    inbox: inboxPort,
    builder: builderPort,
    people: peoplePort,
    editor: editorPort,
    shares: sharesPort,
    pages: pagesPort,
    access: accessPort,
    calls,
    record: (id) => clone(records.get(id)?.record),
    signedIn: () => me,
  };
}
