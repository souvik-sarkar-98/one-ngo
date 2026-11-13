import { expect, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { accounts, org, password } from '../accounts.js';
import { anonymousApi, memberApi, runTag } from '../api.js';
import { label } from '../catalogue.js';
import { signIn } from '../sign-in.js';

/**
 * Role matrix journey. Roles belong to the organisation and change, so every
 * check here gives one seeded member (NOACCESS, whose own role grants nothing)
 * a throwaway role, notes what its permissions show, changes them, and checks
 * the same member's next request. Role permissions apply when the role is saved
 * (`PUT /api/admin/roles/:key`); definition permissions apply when the Builder publishes.
 */

/** The throwaway record type: organisation visibility, one workflow with an approval step, one action. */
export const T = 'e2e-rbac';
/** The throwaway record type with visibility "only their own and shared". */
export const S = 'e2e-rbac-shared';
export const PAGE_IN = 'e2e-rbac-in';
export const PAGE_OUT = 'e2e-rbac-out';
/** The fixed role API keys are bound to. A role used by a key can never be deleted, so one role is reused and left with no permissions. */
export const KEY_ROLE = 'e2e-rbac-keyed';

/** Permissions written in the throwaway definitions; no seeded role holds any of them. */
export const P = {
  secret: 'e2e-rbac:secret',
  alt: 'e2e-rbac:secret-alt',
  lock: 'e2e-rbac:lock',
  widget: 'e2e-rbac:widget',
  stampAlt: 'e2e-rbac:stamp-alt',
} as const;

export const rec = (type: string, what: string) => `record:${type}:${what}`;

export const perm = {
  read: rec(T, 'read'),
  create: rec(T, 'create'),
  update: rec(T, 'update'),
  import: rec(T, 'import'),
  export: rec(T, 'export'),
  bulk: rec(T, 'bulk'),
  stamp: rec(T, 'action:e2eStamp'),
  finish: rec(T, 'transition:finish'),
  submit: rec(T, 'transition:submit'),
  sharedRead: rec(S, 'read'),
  sharedCreate: rec(S, 'create'),
  sharedUpdate: rec(S, 'update'),
  sharedReadAll: rec(S, 'read:all'),
  sharedShare: rec(S, 'share'),
} as const;

/** What the seeded Viewer role holds (functional-test-data.md), given to the throwaway role where a case is about Viewer access. */
export const viewerLike = ['record:donor:read', 'record:donation:read', 'people:read'];

export const names = {
  type: 'E2E RBAC item',
  types: 'E2E RBAC items',
  shared: 'E2E shared item',
  shareds: 'E2E shared items',
  secret: 'Secret note',
  score: 'Score',
  locked: 'Locked note',
  stamp: 'Stamp item',
  finish: 'Finish item',
  submit: 'Submit for sign-off',
  pageIn: 'E2E RBAC page',
  pageOut: 'E2E RBAC closed page',
  openWidget: 'E2E items counted',
  guardedWidget: 'E2E guarded count',
} as const;

// ------------------------------------------------------------------ pacing

const authHits: number[] = [];
const AUTH_BUDGET = 20;

/**
 * Sign-in, refresh and organisation lookups share a limit of 30 a minute per address.
 * Each sign-in and each reload is counted here, and the next one waits when the minute is used up.
 */
export async function paceAuth(cost = 1): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (authHits.length && now - authHits[0]! > 60_000) authHits.shift();
    if (authHits.length + cost <= AUTH_BUDGET) break;
    await new Promise((resolve) => setTimeout(resolve, 60_000 - (now - authHits[0]!) + 250));
  }
  for (let i = 0; i < cost; i++) authHits.push(Date.now());
}

export async function apiAs(email: string): Promise<APIRequestContext> {
  await paceAuth();
  return memberApi(email);
}

/** The same session's next request on screen: the page reloads and restores the session from its refresh cookie. */
export async function nextRequest(page: Page, path?: string): Promise<void> {
  await paceAuth(3);
  if (path) await page.goto(path);
  else await page.reload();
  await expect(page.locator('.shell')).toBeVisible();
}

export async function signInAs(page: Page, email: string, name: string): Promise<void> {
  await paceAuth(3);
  await signIn(page, email, name);
}

/** A browser context with the project's address and window, for a second person or a signed-out visitor. */
export async function newContext(browser: Browser, info: TestInfo): Promise<BrowserContext> {
  const use = info.project.use;
  return browser.newContext({ baseURL: use.baseURL, viewport: use.viewport ?? { width: 1280, height: 900 } });
}

// -------------------------------------------------------------- responses

export async function expectStatus(res: APIResponse, status: number | number[], what: string): Promise<Record<string, any>> {
  const text = await res.text();
  const allowed = Array.isArray(status) ? status : [status];
  expect(allowed, `${what}: ${res.status()} ${text.slice(0, 400)}`).toContain(res.status());
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { text };
  }
}

export const ok = (res: APIResponse, what: string) => expectStatus(res, [200, 201, 202, 204], what);

/** The server refuses: hiding on screen is never the only check (FT-SEC-009). */
export const refused = (res: APIResponse, what: string, statuses: number[] = [403]) => expectStatus(res, statuses, what);

// ------------------------------------------------------------ definitions

export interface RuntimeField {
  key: string;
  masked?: true;
  readOnly?: true;
}
export interface RuntimeDefs {
  recordTypes: { key: string; canCreate: boolean; canUpdate: boolean; fields: RuntimeField[] }[];
  actions: Record<string, { key: string; allowed: boolean }[]>;
  workflowSets: Record<string, { key: string; transitions: { key: string; allowed: boolean }[] }[]>;
  pages: { key: string; widgets: { label?: string; type: string }[] }[];
}

export async function runtime(api: APIRequestContext): Promise<RuntimeDefs> {
  return (await ok(await api.get('/api/runtime/definitions'), 'runtime definitions')) as RuntimeDefs;
}

export function runtimeType(defs: RuntimeDefs, key: string) {
  return defs.recordTypes.find((t) => t.key === key);
}

export function runtimeAction(defs: RuntimeDefs, type: string, key: string) {
  return defs.actions[type]?.find((a) => a.key === key);
}

export function runtimeStep(defs: RuntimeDefs, type: string, key: string) {
  return defs.workflowSets[type]?.flatMap((w) => w.transitions).find((t) => t.key === key);
}

export async function publishDefinition(admin: APIRequestContext, kind: string, body: { key: string } & Record<string, unknown>): Promise<void> {
  await ok(await admin.put(`/api/builder/definitions/${kind}/${body.key}/draft`, { data: body }), `draft ${kind} ${body.key}`);
  await ok(await admin.post(`/api/builder/definitions/${kind}/${body.key}/publish`), `publish ${kind} ${body.key}`);
}

export function recordTypeBody(fields: { secret?: string; lock?: string } = {}) {
  return {
    key: T,
    label: names.type,
    pluralLabel: names.types,
    titleField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, searchable: true },
      { key: 'code', label: 'Code', type: 'text', unique: true, pattern: '[A-Z]{3}[0-9]{3}', patternMessage: 'Use three capitals and three digits.' },
      { key: 'secret', label: names.secret, type: 'text', readPermission: fields.secret ?? P.secret },
      { key: 'score', label: names.score, type: 'number', readPermission: P.secret },
      { key: 'locked', label: names.locked, type: 'text', editPermission: fields.lock ?? P.lock },
      { key: 'note', label: 'Note', type: 'text' },
    ],
  };
}

export function actionBody(permission?: string) {
  return {
    key: 'e2eStamp',
    recordType: T,
    label: names.stamp,
    placement: ['panel', 'row'],
    when: "status == 'open'",
    ...(permission ? { permission } : {}),
    steps: [{ type: 'setFields', values: { note: "'stamped'" } }],
  };
}

function workflowBody(approverId: string) {
  return {
    key: T,
    recordType: T,
    initial: 'open',
    states: [
      { key: 'open', label: 'Open' },
      { key: 'done', label: 'Done', final: true, locked: true },
    ],
    transitions: [
      { key: 'finish', label: names.finish, from: ['open'], to: 'done' },
      { key: 'submit', label: names.submit, from: ['open'], to: 'done', approval: { users: [approverId] } },
    ],
  };
}

function sharedBody() {
  return {
    key: S,
    label: names.shared,
    pluralLabel: names.shareds,
    titleField: 'name',
    visibility: 'restricted',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, searchable: true },
      { key: 'note', label: 'Note', type: 'text' },
    ],
  };
}

function pagesBodies(inRole: string, outRole: string) {
  return [
    {
      key: PAGE_IN,
      label: names.pageIn,
      audience: [inRole],
      widgets: [
        { type: 'stat', label: names.openWidget, recordType: T, measure: 'count' },
        { type: 'stat', label: names.guardedWidget, permission: P.widget, recordType: T, measure: 'count' },
      ],
    },
    { key: PAGE_OUT, label: names.pageOut, audience: [outRole], widgets: [{ type: 'groups' }] },
  ];
}

/**
 * Publishes the throwaway definitions as this run needs them. The keys are fixed so runs do not
 * pile up record types; each run publishes the same bodies again, which also undoes a run that stopped halfway.
 */
export async function publishThrowawayDefinitions(admin: APIRequestContext, opts: { approverId: string; pageRole?: string; outsiderRole?: string }): Promise<void> {
  await publishDefinition(admin, 'recordType', recordTypeBody());
  await publishDefinition(admin, 'recordType', sharedBody());
  await publishDefinition(admin, 'workflow', workflowBody(opts.approverId));
  await publishDefinition(admin, 'action', actionBody());
  if (opts.pageRole && opts.outsiderRole) for (const page of pagesBodies(opts.pageRole, opts.outsiderRole)) await publishDefinition(admin, 'page', page);
}

// ---------------------------------------------------------------- records

export interface RecordView {
  id: string;
  type: string;
  status: string | null;
  version: number;
  data: Record<string, unknown>;
}

export async function createRecord(api: APIRequestContext, type: string, data: Record<string, unknown>): Promise<RecordView> {
  const body = await ok(await api.post(`/api/records/${type}`, { data }), `create ${type}`);
  return body.record as RecordView;
}

export async function readRecord(api: APIRequestContext, type: string, id: string): Promise<RecordView> {
  return (await ok(await api.get(`/api/records/${type}/${id}`), `read ${type} ${id}`)) as RecordView;
}

export async function query(api: APIRequestContext, type: string, body: Record<string, unknown> = {}): Promise<{ items: RecordView[]; total: number }> {
  return (await ok(await api.post(`/api/records/${type}/query`, { data: body }), `query ${type}`)) as { items: RecordView[]; total: number };
}

/** A unique value for the throwaway Code field: three capitals and three digits. */
export function code(): string {
  const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  return `${letters}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
}

export const base64url = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

// ------------------------------------------------------------ people and roles

export interface MemberView {
  userId: string;
  displayName: string;
  email: string;
  status: string;
  twoStep: string;
  roles: string[];
}

export async function member(admin: APIRequestContext, email: string): Promise<MemberView> {
  const page = await ok(await admin.get(`/api/admin/people?q=${encodeURIComponent(email)}`), `find ${email}`);
  const found = (page.items as MemberView[]).find((m) => m.email.toLowerCase() === email.toLowerCase());
  expect(found, `${email} is a member`).toBeTruthy();
  return found!;
}

export async function memberById(admin: APIRequestContext, userId: string): Promise<MemberView> {
  return (await ok(await admin.get(`/api/admin/people/${userId}`), `member ${userId}`)) as MemberView;
}

export async function setMemberRoles(admin: APIRequestContext, userId: string, roles: string[]): Promise<void> {
  await ok(await admin.put(`/api/admin/people/${userId}/roles`, { data: { roles } }), `roles of ${userId}`);
}

export async function createRole(admin: APIRequestContext, key: string, labelText: string, permissions: string[], requireTwoStep = false): Promise<void> {
  await ok(await admin.post('/api/admin/roles', { data: { key, label: labelText, permissions, requireTwoStep } }), `create role ${key}`);
}

/** Saves what the role allows. Role permissions apply on save; there is no role draft to publish yet (DEF-05). */
export async function publishRole(admin: APIRequestContext, key: string, change: { permissions?: string[]; requireTwoStep?: boolean }): Promise<void> {
  await ok(await admin.put(`/api/admin/roles/${key}`, { data: change }), `save role ${key}`);
}

export async function rolePermissions(admin: APIRequestContext, key: string): Promise<{ permissions: string[]; requireTwoStep: boolean; label: string }> {
  return (await ok(await admin.get(`/api/admin/roles/${key}`), `role ${key}`)) as { permissions: string[]; requireTwoStep: boolean; label: string };
}

/** The fixed key role, created once and kept with no permissions between runs. */
export async function ensureKeyRole(admin: APIRequestContext): Promise<void> {
  const res = await admin.get(`/api/admin/roles/${KEY_ROLE}`);
  if (res.status() === 404) await createRole(admin, KEY_ROLE, 'E2E RBAC API key role', []);
  else await publishRole(admin, KEY_ROLE, { permissions: [] });
}

/** Adds someone who has never signed in and is not invited, so no mail is sent. */
export async function addPerson(admin: APIRequestContext, tag: string, suffix: string): Promise<MemberView> {
  const email = `${tag}-${suffix}@riverbank.example`;
  const added = await ok(await admin.post('/api/admin/people', { data: { email, displayName: `E2E ${tag} ${suffix}`, roles: [], invite: false } }), `add ${email}`);
  return memberById(admin, added.userId as string);
}

/** Signs in through the API without expecting success, for refused sign-ins. */
export async function tryLogin(email: string): Promise<APIResponse> {
  await paceAuth();
  const anon = await anonymousApi();
  const res = await anon.post('/api/auth/login', { data: { tenant: org, email, password } });
  await res.body();
  await anon.dispose();
  return res;
}

// --------------------------------------------------------------- the world

/** The member whose access the journey changes. Their seeded role grants nothing, so the throwaway role decides everything they see. */
export const subjectAccount = accounts.noAccess;

export interface World {
  tag: string;
  admin: APIRequestContext;
  /** The subject's own API session, kept for the whole file. */
  api: APIRequestContext;
  context: BrowserContext;
  /** The subject's signed-in page, kept for the whole file. */
  page: Page;
  subjectId: string;
  directoryId: string;
  /** The subject's throwaway role. */
  role: { key: string; label: string };
  /** Saves the throwaway role's permissions; the subject's next request follows them. */
  allow(permissions: string[]): Promise<void>;
  /** Roles this file created; deleted on close. */
  created: string[];
  close(): Promise<void>;
}

export interface WorldOptions {
  permissions: string[];
  /** Also publish the two throwaway pages with this audience (FT-HOME-010, FT-HOME-011). */
  pages?: boolean;
}

/**
 * Creates the throwaway role, gives it to the subject next to their seeded role,
 * publishes the throwaway definitions and signs the subject in on one page that
 * the whole file keeps. `close` restores the subject's roles and deletes the roles
 * it created, even after a failure.
 */
export async function openWorld(browser: Browser, info: TestInfo, opts: WorldOptions): Promise<World> {
  const tag = runTag('rbac');
  const admin = await apiAs(accounts.admin.email);
  const subject = await member(admin, subjectAccount.email);
  const directory = await member(admin, accounts.directory.email);
  const before = subject.roles.filter((r) => !r.startsWith('rbac-'));
  const role = { key: tag, label: `E2E RBAC member ${tag}` };
  const created: string[] = [];
  let context: BrowserContext | undefined;
  let api: APIRequestContext | undefined;

  const close = async () => {
    const errors: unknown[] = [];
    const attempt = async (step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (e) {
        errors.push(e);
      }
    };
    await attempt(() => setMemberRoles(admin, subject.userId, before.length ? before : ['noaccess']));
    for (const key of created.reverse()) {
      await attempt(async () => {
        const members = await ok(await admin.get(`/api/admin/roles/${key}/members`), `members of ${key}`);
        for (const m of members.items as MemberView[]) await admin.delete(`/api/admin/roles/${key}/members/${m.userId}`);
        const gone = await admin.delete(`/api/admin/roles/${key}`);
        if (gone.status() !== 204) await publishRole(admin, key, { permissions: [], requireTwoStep: false });
      });
    }
    await attempt(() => api?.dispose() ?? Promise.resolve());
    await attempt(() => context?.close() ?? Promise.resolve());
    await attempt(() => admin.dispose());
    if (errors.length) console.warn(`RBAC clean-up for ${tag} hit ${errors.length} problem(s)`, errors);
  };

  try {
    await createRole(admin, role.key, role.label, opts.permissions);
    created.push(role.key);
    let outsider = '';
    if (opts.pages) {
      outsider = `${tag}-out`;
      await createRole(admin, outsider, `E2E RBAC outsider ${tag}`, []);
      created.push(outsider);
    }
    await publishThrowawayDefinitions(admin, { approverId: directory.userId, ...(opts.pages ? { pageRole: role.key, outsiderRole: outsider } : {}) });
    await setMemberRoles(admin, subject.userId, [...before, role.key]);
    context = await newContext(browser, info);
    const page = await context.newPage();
    await signInAs(page, subjectAccount.email, subjectAccount.name);
    api = await apiAs(subjectAccount.email);
    return {
      tag,
      admin,
      api,
      context,
      page,
      subjectId: subject.userId,
      directoryId: directory.userId,
      role,
      created,
      allow: (permissions) => publishRole(admin, role.key, { permissions }),
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

// ----------------------------------------------------------------- screen

/** The checkbox for one permission in a record type row of the role grid. */
export function gridRow(page: Page, typePlural: string) {
  return page.locator('table.role-grid tr').filter({ has: page.getByRole('rowheader', { name: typePlural, exact: true }) });
}

/** The access map row for one element and the permission it requires now. */
export function accessRow(page: Page, element: string, permission: string) {
  return page.locator('table.access-table tr').filter({ hasText: element }).filter({ hasText: permission });
}

/** Opens a record in the list's panel. */
export async function openRecord(page: Page, type: string, id: string): Promise<void> {
  await page.goto(`/records/${type}?id=${id}`);
}

export function recordButton(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

export const records = {
  newButton: (page: Page, typeLabel: string) => page.getByRole('button', { name: label('ui.records.new', { type: typeLabel.toLowerCase() }), exact: true }),
  typeLink: (page: Page, plural: string) => page.getByRole('link', { name: plural }),
};
