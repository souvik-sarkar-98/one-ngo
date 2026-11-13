import { expect, type APIRequestContext, type Browser, type Page, type TestInfo } from '@playwright/test';
import { runTag } from '../api.js';
import { label } from '../catalogue.js';

/** The role the new module's approval step names. Riverbank has no Approver role, so the journeys add it and remove it. */
export const approverRole = { key: 'e2e-approver', label: 'Approver' } as const;

/** Lets the requester (FIN) create, edit and step the new module's records. */
export const requesterRole = { key: 'e2e-requester', label: 'Grant requester (E2E)' } as const;

/** Seeded members that hold no Approver role. They are given it for the run and lose it afterwards. */
export const approvers = {
  one: { email: 'privacy@riverbank.example', name: 'Privacy Officer' },
  two: { email: 'script@riverbank.example', name: 'Script Author' },
} as const;

/** The same key the Builder makes from a name (`apps/onengo/web/src/app/core/fields/fields.ts`). */
export function toKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const key = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join('');
  if (!key) return '';
  return /^[a-z]/.test(key) ? key.slice(0, 63) : `f${key}`.slice(0, 63);
}

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Named {
  name: string;
  key: string;
}

export interface ModuleNames {
  suffix: string;
  grant: Named & { label: string; plural: string };
  programme: Named & { label: string; plural: string };
  grantList: Named;
  programmeList: Named;
  group: Named;
  workflow: Named;
  template: Named;
  automation: Named;
  page: Named;
  submit: { key: string; label: string };
  award: { key: string; label: string };
}

const named = (name: string): Named => ({ name, key: toKey(name) });

/** One module's names. The workflow key starts `grantFlow`, which is how the approval journey finds a published one. */
export function moduleNames(suffix = runTag('wf').split('-')[1]!.toLowerCase()): ModuleNames {
  return {
    suffix,
    grant: { ...named(`Grant ${suffix}`), label: `Grant ${suffix}`, plural: `Grants ${suffix}` },
    programme: { ...named(`Programme ${suffix}`), label: `Programme ${suffix}`, plural: `Programmes ${suffix}` },
    grantList: named(`Grants ${suffix}`),
    programmeList: named(`Programmes ${suffix}`),
    group: named(`Grant desk ${suffix}`),
    workflow: named(`Grant flow ${suffix}`),
    template: named(`Grant decided ${suffix}`),
    automation: named(`Grant approved ${suffix}`),
    page: named(`Grant overview ${suffix}`),
    submit: { key: 'submit', label: 'Submit' },
    award: { key: 'awardGrant', label: 'Award grant' },
  };
}

type Body = Record<string, unknown>;

export function programmeBody(n: ModuleNames): Body {
  return {
    key: n.programme.key,
    label: n.programme.label,
    pluralLabel: n.programme.plural,
    description: 'Programmes that grants are given under.',
    titleField: 'name',
    fields: [{ key: 'name', label: 'Name', type: 'text', required: true, maxLength: 200, searchable: true }],
  };
}

export function grantBody(n: ModuleNames): Body {
  return {
    key: n.grant.key,
    label: n.grant.label,
    pluralLabel: n.grant.plural,
    description: 'Grant requests that need two approvals before they are awarded.',
    titleField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 200, searchable: true },
      { key: 'amount', label: 'Amount', type: 'number', min: 0 },
      {
        key: 'priority',
        label: 'Priority',
        type: 'choice',
        choices: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
        ],
      },
      { key: 'programme', label: 'Programme', type: 'reference', referenceType: n.programme.key },
      { key: 'notes', label: 'Notes', type: 'longText' },
    ],
  };
}

export function grantListBody(n: ModuleNames, listLabel = n.grantList.name): Body {
  const fields = ['name', 'amount', 'priority', 'programme', 'notes'];
  return {
    key: n.grantList.key,
    recordType: n.grant.key,
    label: listLabel,
    pageSize: 20,
    layout: 'table',
    columns: ['name', 'priority', 'amount'],
    compactColumns: ['name', 'priority'],
    chips: [{ id: 'all', label: 'All' }],
    defaultChip: 'all',
    filters: ['priority'],
    row: { title: 'name', subtitle: ['priority'] },
    detail: { sections: [{ id: 'grant', label: 'Grant', fields }] },
    create: { fields },
    edit: { fields },
  };
}

export function programmeListBody(n: ModuleNames): Body {
  return {
    key: n.programmeList.key,
    recordType: n.programme.key,
    label: n.programmeList.name,
    pageSize: 20,
    layout: 'table',
    columns: ['name'],
    compactColumns: ['name'],
    chips: [{ id: 'all', label: 'All' }],
    defaultChip: 'all',
    row: { title: 'name', subtitle: [] },
    detail: {
      sections: [
        { id: 'programme', label: 'Programme', fields: ['name'] },
        { id: 'grants', label: 'Grants', related: { recordType: n.grant.key, field: 'programme' } },
      ],
    },
    create: { fields: ['name'] },
    edit: { fields: ['name'] },
  };
}

export function groupBody(n: ModuleNames): Body {
  return { key: n.group.key, label: n.group.name, order: 900, recordTypes: [n.grant.key, n.programme.key] };
}

const states = [
  { key: 'draft', label: 'Draft' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'approved', label: 'Approved', final: true },
];

/** The workflow before the approval step is added: Approved cannot be reached yet. */
export function workflowBase(n: ModuleNames): Body {
  return {
    key: n.workflow.key,
    recordType: n.grant.key,
    initial: 'draft',
    states,
    transitions: [{ key: n.submit.key, label: n.submit.label, from: ['draft'], to: 'submitted' }],
  };
}

export function awardStep(n: ModuleNames, count = 2): Body {
  return { key: n.award.key, label: n.award.label, from: ['submitted'], to: 'approved', approval: { roles: [approverRole.key], count } };
}

/** Two steps: Submit, then Award grant, which waits for two approvals from the Approver role. */
export function workflowFull(n: ModuleNames, count = 2): Body {
  const base = workflowBase(n);
  return { ...base, transitions: [...(base['transitions'] as Body[]), awardStep(n, count)] };
}

export function templateBody(n: ModuleNames): Body {
  return {
    key: n.template.key,
    label: n.template.name,
    subject: 'Grant {{ record.name }} was approved',
    body: 'Your grant request {{ record.name }} has both approvals and is now awarded.',
  };
}

export function automationBody(n: ModuleNames): Body {
  return {
    key: n.automation.key,
    label: n.automation.name,
    recordType: n.grant.key,
    trigger: { event: 'statusChanged', to: 'approved' },
    actions: [{ type: 'notify', template: n.template.key, to: { creator: true }, channels: ['inApp'] }],
  };
}

export const pageWidgets = {
  stat: 'Grants',
  chart: 'Grants by priority',
  list: 'Latest grants',
  links: 'Grant links',
} as const;

export function pageBody(n: ModuleNames): Body {
  return {
    key: n.page.key,
    label: n.page.name,
    widgets: [
      { type: 'stat', label: pageWidgets.stat, recordType: n.grant.key, measure: 'count' },
      { type: 'chart', label: pageWidgets.chart, recordType: n.grant.key, measure: 'count', groupBy: { field: 'priority' }, chart: 'bar' },
      { type: 'list', label: pageWidgets.list, listView: n.grantList.key, limit: 5 },
      { type: 'links', label: pageWidgets.links, items: [{ label: 'All grants', to: `/records/${n.grant.key}` }] },
      { type: 'groups' },
    ],
  };
}

// ------------------------------------------------------------------ definitions API

export interface DefinitionDetail {
  published: { version: number; body: Body } | null;
  draft: { version: number; body: Body } | null;
}

export async function definitionDetail(api: APIRequestContext, kind: string, key: string): Promise<DefinitionDetail | null> {
  const res = await api.get(`/api/builder/definitions/${kind}/${key}`);
  if (res.status() === 404) return null;
  expect(res.status(), `GET ${kind} ${key}`).toBe(200);
  return (await res.json()) as DefinitionDetail;
}

export async function checkBody(api: APIRequestContext, kind: string, key: string, body: Body): Promise<{ errors: { path: string; message: string }[]; warnings: { path: string; message: string }[] }> {
  const res = await api.post(`/api/builder/definitions/${kind}/${key}/check`, { data: body });
  expect(res.status(), `check ${kind} ${key}`).toBe(200);
  return (await res.json()) as { errors: { path: string; message: string }[]; warnings: { path: string; message: string }[] };
}

export async function publishDefinition(api: APIRequestContext, kind: string, body: Body): Promise<void> {
  const key = String(body['key']);
  const draft = await api.put(`/api/builder/definitions/${kind}/${key}/draft`, { data: body });
  expect(draft.status(), `draft ${kind} ${key}: ${await draft.text()}`).toBe(200);
  const publish = await api.post(`/api/builder/definitions/${kind}/${key}/publish`, { data: {} });
  expect(publish.status(), `publish ${kind} ${key}: ${await publish.text()}`).toBe(200);
}

/** The whole module through the definitions API, in the order the definitions depend on each other. */
export async function publishModule(api: APIRequestContext, n: ModuleNames): Promise<void> {
  await publishDefinition(api, 'recordType', programmeBody(n));
  await publishDefinition(api, 'recordType', grantBody(n));
  await publishDefinition(api, 'listView', programmeListBody(n));
  await publishDefinition(api, 'listView', grantListBody(n));
  await publishDefinition(api, 'recordGroup', groupBody(n));
  await publishDefinition(api, 'workflow', workflowFull(n));
  await publishDefinition(api, 'template', templateBody(n));
  await publishDefinition(api, 'automation', automationBody(n));
  await publishDefinition(api, 'page', pageBody(n));
}

/** The newest module FT-E2E-06 published whose Award grant step still needs two approvals from the Approver role. */
export async function findPublishedModule(api: APIRequestContext): Promise<ModuleNames | null> {
  const res = await api.get('/api/builder/catalogue');
  expect(res.status()).toBe(200);
  const items = (await res.json()) as { kind: string; key: string; publishedVersion: number | null }[];
  const flows = items
    .filter((i) => i.kind === 'workflow' && i.publishedVersion && /^grantFlow[A-Za-z0-9]+$/.test(i.key))
    .map((i) => i.key)
    .sort()
    .reverse();
  for (const key of flows) {
    const n = moduleNames(key.slice('grantFlow'.length).toLowerCase());
    if (n.workflow.key !== key) continue;
    const wf = await api.get(`/api/definitions/workflow/${key}`);
    if (wf.status() !== 200) continue;
    const answer = (await wf.json()) as Body & { body?: Body };
    const body = answer.body ?? answer;
    const award = ((body['transitions'] as Body[] | undefined) ?? []).find((t) => t['key'] === n.award.key);
    const approval = award?.['approval'] as { roles?: string[]; count?: number } | undefined;
    const type = await api.get(`/api/definitions/recordType/${n.grant.key}`);
    if (approval?.count === 2 && approval.roles?.includes(approverRole.key) && type.status() === 200) return n;
  }
  return null;
}

// ------------------------------------------------------------------ roles and people

export async function userId(admin: APIRequestContext, email: string): Promise<string> {
  const res = await admin.get('/api/admin/people', { params: { q: email, limit: '10', offset: '0' } });
  expect(res.status()).toBe(200);
  const person = ((await res.json()) as { items: { userId: string; email: string }[] }).items.find((p) => p.email === email);
  expect(person, `member ${email}`).toBeTruthy();
  return person!.userId;
}

/** Roles given for the run, and to whom, so they can be taken away again. */
export interface RoleGrants {
  roles: string[];
  members: { role: string; userId: string }[];
}

export async function grantRole(admin: APIRequestContext, grants: RoleGrants, role: { key: string; label: string }, permissions: string[], emails: string[]): Promise<void> {
  const existing = await admin.get(`/api/admin/roles/${role.key}`);
  if (existing.status() === 200) {
    const saved = await admin.put(`/api/admin/roles/${role.key}`, { data: { permissions } });
    expect(saved.status(), await saved.text()).toBe(200);
  } else {
    const created = await admin.post('/api/admin/roles', { data: { key: role.key, label: role.label, permissions } });
    expect(created.status(), await created.text()).toBeLessThan(300);
  }
  if (!grants.roles.includes(role.key)) grants.roles.push(role.key);
  const ids = await Promise.all(emails.map((e) => userId(admin, e)));
  const added = await admin.post(`/api/admin/roles/${role.key}/members`, { data: { userIds: ids } });
  expect(added.status(), await added.text()).toBeLessThan(300);
  for (const id of ids) grants.members.push({ role: role.key, userId: id });
}

/** Takes the roles away again and deletes them once nobody holds them. */
export async function revokeRoles(admin: APIRequestContext, grants: RoleGrants): Promise<void> {
  for (const m of grants.members) await admin.delete(`/api/admin/roles/${m.role}/members/${m.userId}`);
  for (const key of grants.roles) {
    const res = await admin.get(`/api/admin/roles/${key}`);
    if (res.status() === 200 && ((await res.json()) as { members: number }).members === 0) await admin.delete(`/api/admin/roles/${key}`);
  }
  grants.members = [];
  grants.roles = [];
}

export function modulePermissions(n: ModuleNames): { requester: string[]; approver: string[] } {
  return {
    requester: [`record:${n.grant.key}:*`, `record:${n.programme.key}:*`],
    approver: [`record:${n.grant.key}:read`, `record:${n.programme.key}:read`],
  };
}

// ------------------------------------------------------------------ records and approvals API

export interface GrantRecord {
  id: string;
  status: string | null;
  version: number;
  data: Record<string, unknown>;
}

export async function createGrant(api: APIRequestContext, n: ModuleNames, name: string): Promise<GrantRecord> {
  const res = await api.post(`/api/records/${n.grant.key}`, { data: { name, amount: 25000, priority: 'high' } });
  expect(res.status(), `create ${n.grant.key}: ${await res.text()}`).toBe(201);
  return ((await res.json()) as { record: GrantRecord }).record;
}

export async function grant(api: APIRequestContext, n: ModuleNames, id: string): Promise<GrantRecord> {
  const res = await api.get(`/api/records/${n.grant.key}/${id}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as GrantRecord;
}

export async function runStep(api: APIRequestContext, n: ModuleNames, record: GrantRecord, step: string): Promise<{ record: GrantRecord; approvalRequestId?: string }> {
  const res = await api.post(`/api/records/${n.grant.key}/${record.id}/transitions/${step}`, { data: { expectedVersion: record.version } });
  expect(res.status(), `${step} on ${record.id}: ${await res.text()}`).toBe(200);
  return (await res.json()) as { record: GrantRecord; approvalRequestId?: string };
}

/** A grant created and submitted by the requester, with Award grant sent for approval. */
export async function grantWaitingForApproval(api: APIRequestContext, n: ModuleNames, name: string): Promise<{ record: GrantRecord; requestId: string }> {
  const created = await createGrant(api, n, name);
  const submitted = await runStep(api, n, created, n.submit.key);
  const sent = await runStep(api, n, submitted.record, n.award.key);
  expect(sent.approvalRequestId).toBeTruthy();
  return { record: sent.record, requestId: sent.approvalRequestId! };
}

export async function pendingApproval(api: APIRequestContext, n: ModuleNames, id: string): Promise<{ id: string; approvalsGiven: number; approvalsNeeded: number; canDecide: boolean } | null> {
  const res = await api.get(`/api/records/${n.grant.key}/${id}/approval`);
  expect(res.status()).toBe(200);
  const text = await res.text();
  return text ? (JSON.parse(text) as { id: string; approvalsGiven: number; approvalsNeeded: number; canDecide: boolean } | null) : null;
}

export async function decide(api: APIRequestContext, requestId: string, decision: 'approve' | 'reject'): Promise<{ status: number; message: string }> {
  const res = await api.post(`/api/approvals/${requestId}/decision`, { data: { decision } });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as { message?: string; status?: string }) : {};
  return { status: res.status(), message: body.message ?? body.status ?? '' };
}

export async function withdraw(api: APIRequestContext, requestId: string): Promise<{ status: number; message: string }> {
  const res = await api.post(`/api/approvals/${requestId}/withdraw`);
  const text = await res.text();
  return { status: res.status(), message: text ? ((JSON.parse(text) as { message?: string }).message ?? '') : '' };
}

export async function waitingCount(api: APIRequestContext): Promise<number> {
  const res = await api.get('/api/approvals/count');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { waiting: number }).waiting;
}

/** The Inbox badge text for a count (`badgeText` in `packages/web-kit/src/logic/links.ts`). */
export const badgeText = (count: number): string => (count <= 0 ? '' : count > 99 ? '99+' : String(count));

// ------------------------------------------------------------------ pages and the Builder screen

/** A page in its own context, so several people can be signed in during one journey. */
export async function newPage(browser: Browser, testInfo: TestInfo, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport });
  return context.newPage();
}

const kindTitle: Record<string, string> = {
  recordType: 'ui.builder.kinds.recordType',
  listView: 'ui.builder.home.lists',
  recordGroup: 'ui.builder.kinds.recordGroup',
  workflow: 'ui.builder.kinds.workflow',
  template: 'ui.builder.kinds.template',
  automation: 'ui.builder.kinds.automation',
  page: 'ui.builder.kinds.page',
};

/**
 * Moves inside the signed-in app without reloading it. A reload refreshes the
 * session, and many quick reloads in the Builder reach the sign-in rate limit (DEF-32).
 */
export async function navigate(page: Page, path: string): Promise<void> {
  if (!page.url().startsWith('http')) {
    await page.goto(path);
    return;
  }
  await page.evaluate((to) => {
    history.pushState(null, '', to);
    dispatchEvent(new PopStateEvent('popstate', { state: null }));
  }, path);
  await page.waitForURL((u) => u.pathname === new URL(path, u).pathname);
}

export async function openKind(page: Page, kind: string): Promise<void> {
  await navigate(page, `/builder?kind=${kind}`);
  await expect(page.getByRole('heading', { level: 1, name: label(kindTitle[kind]!), exact: true })).toBeVisible();
}

/** "+ New" on a kind's page: name, then a ready-made record type or the record type it belongs to. Returns the key. */
export async function newDefinition(page: Page, kind: string, name: string, opts: { recordType?: string; starter?: string } = {}): Promise<string> {
  await openKind(page, kind);
  await page.getByRole('button', { name: label(`ui.builder.home.new.${kind}`), exact: true }).click();
  await expect(page.getByRole('dialog', { name: label('ui.builder.catalogue.newTitle', { kind: label(`ui.builder.kind.${kind}`) }) })).toBeVisible();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel(label('ui.builder.name'), { exact: true }).fill(name);
  const key = toKey(name);
  await expect(sheet.getByText(label('ui.builder.keyHint', { key }), { exact: true })).toBeVisible();
  if (opts.starter) {
    await sheet.getByLabel(label('ui.builder.catalogue.readyMade')).selectOption({ label: label(`ui.builder.starters.${opts.starter}`) });
    await expect(sheet.getByRole('heading', { name: label('ui.builder.catalogue.startFrom', { name: label(`ui.builder.starters.${opts.starter}`) }) })).toBeVisible();
  }
  if (opts.recordType) await sheet.getByLabel(label('ui.builder.workflow.recordType'), { exact: true }).selectOption(opts.recordType);
  await sheet.getByRole('button', { name: label('ui.common.create'), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/builder/${kind}/${key}(\\?|$)`));
  await expect(page.locator('.builder-foot')).toBeVisible();
  return key;
}

export async function openTab(page: Page, tab: 'visual' | 'json' | 'changes' | 'history'): Promise<void> {
  const chip = page.getByRole('tab', { name: label(`ui.builder.tabs.${tab}`), exact: true });
  await chip.click();
  await expect(chip).toHaveAttribute('aria-selected', 'true');
}

/** Replaces the draft on the JSON tab, leaves the field, and waits for the draft to be saved. */
export async function writeJson(page: Page, kind: string, key: string, body: Body): Promise<void> {
  await openTab(page, 'json');
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/builder/definitions/${kind}/${key}/draft`);
  await page.getByLabel(label('ui.builder.definition'), { exact: true }).fill(JSON.stringify(body, null, 2));
  await page.getByRole('heading', { level: 1 }).click();
  expect((await saved).status()).toBe(200);
}

export async function openPublish(page: Page, title: string) {
  await page.getByRole('button', { name: label('ui.builder.publishEllipsis'), exact: true }).click();
  const sheet = page.getByRole('dialog', { name: new RegExp(`^Publish "${escapeRegExp(title)}" v\\d+$`) });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Publish… shows what changes for people first; Publish makes it live. Returns the summary lines. */
export async function publishInBuilder(page: Page, title: string): Promise<string[]> {
  const sheet = await openPublish(page, title);
  await expect(sheet.getByRole('heading', { name: label('ui.builder.whatChanges') })).toBeVisible();
  await expect(sheet.getByText(label('ui.builder.fixFirst'))).toHaveCount(0);
  const lines = (await sheet.locator('.builder-lines li').allTextContents()).map((l) => l.trim());
  await sheet.getByRole('button', { name: label('ui.builder.publish'), exact: true }).click();
  await expect(page.getByText(label('ui.builder.publishedLive'))).toBeVisible();
  return lines;
}
