import { describe, expect, it } from 'vitest';
import type { Me } from '../models';
import { auditParams, jobsParams, jobsPushes, parseAuditAddress, parseJobsAddress, readFlag, writeFlag } from './address';
import { ApiKeysSession } from './api-keys';
import { adminHome, mayOpen, mayOpenBuilder, mayPublishLook } from './areas';
import { AuditSession } from './audit';
import { ConnectorSession } from './connectors';
import { JobsSession, failedCsv } from './jobs';
import { RoleMembersSession } from './roles';
import { identityChange, identityValues, monthOptions, settingsChange, settingsValues, sizeText, storagePercent } from './settings';
import { fakeAddress, memoryAdmin } from './testing';

const caps = (c: Partial<Me['capabilities']>): Me['capabilities'] => ({ configure: false, publish: false, scripts: false, money: false, ...c });
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('Theme and Layout in the Builder', () => {
  it('publish with config:publish or admin:settings, as the server accepts', () => {
    expect(mayPublishLook(caps({ publish: true }))).toBe(true);
    expect(mayPublishLook(caps({ settings: true }))).toBe(true);
    expect(mayPublishLook(caps({ configure: true }))).toBe(false);
    expect(mayPublishLook(caps({ people: true, scripts: true }))).toBe(false);
    expect(mayPublishLook(undefined)).toBe(false);
  });

  it('open with only admin:settings, and nothing else in the Builder does', () => {
    const settings = caps({ settings: true });
    for (const url of ['/builder/theme', '/builder/layout', '/builder/theme?x=1', '/builder/layout/']) expect(mayOpenBuilder(url, settings), url).toBe(true);
    for (const url of ['/builder', '/builder?kind=recordType', '/builder/access', '/builder/modules', '/builder/translations', '/builder/recordType/donation', '/builder/theme/extra', '/builder/themes']) {
      expect(mayOpenBuilder(url, settings), url).toBe(false);
    }
  });

  it('open everywhere in the Builder with config:read, and for no one without a session', () => {
    for (const url of ['/builder', '/builder/theme', '/builder/layout', '/builder/access', '/builder/modules', '/builder/script/x']) {
      expect(mayOpenBuilder(url, caps({ configure: true })), url).toBe(true);
    }
    expect(mayOpenBuilder('/builder/theme', caps({ people: true }))).toBe(false);
    expect(mayOpenBuilder('/builder/theme', undefined)).toBe(false);
  });

  it('match mayOpen for the same two areas when the person cannot configure', () => {
    for (const c of [caps({}), caps({ settings: true }), caps({ people: true })]) {
      for (const area of ['theme', 'layout'] as const) expect(mayOpenBuilder(`/builder/${area}`, c), area).toBe(mayOpen(area, c));
    }
  });
});

describe('Administration home', () => {
  it('shows only the areas the capabilities allow', () => {
    const ids = (c: Me['capabilities']) => {
      const h = adminHome(c);
      return [...h.organisation, ...h.people, ...h.integrations, ...h.activity].map((a) => a.id);
    };
    expect(ids(caps({ people: true }))).toEqual(['people', 'roles']);
    expect(ids(caps({ roles: true }))).toEqual(['roles']);
    expect(ids(caps({ apiKeys: true, audit: true }))).toEqual(['apiKeys', 'audit']);
    expect(ids(caps({ settings: true }))).toEqual(['identity', 'profile', 'registrations', 'settings']);
    expect(ids(caps({ people: true, roles: true, connectors: true, apiKeys: true, jobs: true, audit: true, settings: true }))).toEqual([
      'identity',
      'profile',
      'registrations',
      'settings',
      'people',
      'roles',
      'connectors',
      'apiKeys',
      'jobs',
      'audit',
    ]);
    expect(ids(caps({ peopleDirectory: true }))).toEqual([]);
    expect(mayOpen('roles', caps({ people: true }))).toBe(true);
    expect(mayOpen('jobs', undefined)).toBe(false);
  });

  it('names areas as the wireframe does', () => {
    const h = adminHome(caps({ jobs: true, settings: true }));
    expect(h.organisation.map((a) => [a.label, a.link])).toEqual([
      ['Identity', '/admin/organisation/identity'],
      ['Profile', '/admin/organisation/profile'],
      ['Registrations', '/admin/organisation/registrations'],
      ['Settings', '/admin/organisation/settings'],
    ]);
    expect(h.activity.map((a) => [a.label, a.link])).toEqual([['Background jobs', '/admin/jobs']]);
    expect(mayOpen('theme', caps({ settings: true }))).toBe(true);
    expect(mayOpen('layout', caps({ jobs: true }))).toBe(false);
  });
});

describe('Administration addresses', () => {
  it('jobs: chip (All by default) and job; opening a job pushes', () => {
    const a = parseJobsAddress((n) => ({ status: 'failed', job: 'j2' })[n] ?? null);
    expect(a).toEqual({ status: 'failed', job: 'j2', show: 30 });
    expect(parseJobsAddress((n) => ({ status: 'nope' })[n] ?? null).status).toBe('all');
    expect(jobsParams({ status: 'all', show: 30 })).toEqual({ status: null, job: null, show: null });
    expect(jobsPushes({ ...a, job: undefined }, a)).toBe(true);
    expect(jobsPushes(a, { ...a, job: undefined })).toBe(false);
    expect(jobsPushes(a, { ...a, status: 'all' })).toBe(false);
  });

  it('audit: person, area, record type and date; invalid values dropped', () => {
    const a = parseAuditAddress((n) => ({ person: 'api:Website form', area: 'people', dateFrom: '2026-10-24', dateTo: 'x', recordType: 'donation' })[n] ?? null);
    expect(a).toEqual({ person: 'api:Website form', area: 'people', recordType: 'donation', date: { from: '2026-10-24' }, show: 30 });
    expect(parseAuditAddress((n) => ({ area: 'nowhere' })[n] ?? null).area).toBeUndefined();
    expect(auditParams({ show: 30 })).toEqual({ person: null, area: null, recordType: null, dateFrom: null, dateTo: null, show: null });
  });

  it('bare flags such as ?add and ?create', () => {
    expect(readFlag((n) => (n === 'add' ? '' : null), 'add')).toBe(true);
    expect(writeFlag('create', false)).toEqual({ create: null });
  });
});

describe('role membership', () => {
  it('lists members, adds several people and removes one', async () => {
    const m = memoryAdmin();
    const addr = fakeAddress();
    const s = new RoleMembersSession(m.gateway, 'viewer', addr.nav);
    await s.load();
    expect(s.state.value.page!.items.map((p) => p.userId)).toEqual(['u-deepak', 'u-meena']);
    s.openAdd();
    expect(addr.urls.at(-1)).toEqual({ params: { add: '' }, replace: false });
    const offered = await s.candidates().search('a');
    expect(offered.map((o) => o.id)).not.toContain('u-meena');
    expect(offered.map((o) => o.id)).not.toContain('u-deepak');
    s.pick({ id: 'u-ravi', label: 'Ravi Kumar' });
    s.pick({ id: 'u-farhan', label: 'Farhan Ali' });
    expect(await s.add()).toEqual({ ok: true, message: '2 added to Viewer.' });
    expect(addr.params()).not.toHaveProperty('add');
    expect(s.state.value.page!.items).toHaveLength(4);
    expect(await s.remove('u-ravi')).toEqual({ ok: true, message: 'Ravi Kumar no longer has Viewer.' });
    expect(s.state.value.page!.items).toHaveLength(3);
  });

  it('shows the lock-out refusal when the last person who can manage roles would lose it', async () => {
    const m = memoryAdmin();
    const s = new RoleMembersSession(m.gateway, 'admin', fakeAddress().nav);
    await s.load();
    expect(await s.remove('u-asha')).toEqual({ ok: false, message: 'This would leave nobody who can manage roles.' });
    expect(s.state.value.page!.items).toHaveLength(1);
  });
});

describe('API keys', () => {
  it('shows the secret once in the panel and never writes it to the address', async () => {
    const m = memoryAdmin();
    const addr = fakeAddress({ create: '' });
    const s = new ApiKeysSession(m.gateway, addr.nav);
    await s.load();
    expect(await s.create({ name: '', role: '' })).toMatchObject({ ok: false, issues: { name: 'Name is required.', role: 'Acts as role is required.' } });
    expect(await s.create({ name: 'Volunteer app', role: 'viewer' })).toEqual({ ok: true, message: '' });
    expect(s.state.value.created).toEqual({ name: 'Volunteer app', role: 'viewer', feed: null, token: 'k2.sk_secret_value_123' });
    expect(s.state.value.keys.map((k) => k.name)).toContain('Volunteer app');
    expect(JSON.stringify(s.state.value.keys)).not.toContain('sk_secret');
    expect(addr.params()).toEqual({});
    expect(JSON.stringify(addr.urls)).not.toContain('sk_secret');
    s.dismissSecret();
    expect(s.state.value.created).toBeNull();
  });

  it('revokes after confirming in the panel', async () => {
    const m = memoryAdmin();
    const s = new ApiKeysSession(m.gateway, fakeAddress().nav);
    await s.load();
    s.askRevoke('k1');
    expect(s.state.value.revoking?.name).toBe('Website form');
    expect(await s.confirmRevoke()).toEqual({ ok: true, message: 'Website form revoked.' });
    expect(s.state.value.keys[0]!.revokedAt).not.toBeNull();
    s.askRevoke('k1');
    expect(s.state.value.revoking).toBeNull();
  });
});

describe('background jobs', () => {
  it('filters by chip, opens a job with its failed items, and cancels a running one', async () => {
    const m = memoryAdmin();
    let s!: JobsSession;
    const addr = fakeAddress({}, (read) => void s.fromUrl(read));
    s = new JobsSession(m.gateway, addr.nav);
    await s.fromUrl(addr.read);
    expect(s.controller.snapshot.items.map((j) => j.id)).toEqual(['j1', 'j2']);
    s.selectChip('running');
    await settle();
    expect(m.calls.filter((c) => c.op === 'jobs').at(-1)!.args[0]).toMatchObject({ status: ['queued', 'running'] });
    expect(s.controller.snapshot.items.map((j) => j.id)).toEqual(['j1']);
    s.open('j2');
    await settle();
    expect(addr.urls.at(-1)!.replace).toBe(false);
    expect(s.panel.value.failed).toHaveLength(1);
    expect(failedCsv(s.panel.value.failed)).toBe('row,record,reason\r\n31,DON/00031,Paid on cannot be before the donation date.\r\n');
    expect(await s.cancel('j1')).toEqual({ ok: true, message: 'Job cancelled.' });
    expect(await s.cancel('j2')).toEqual({ ok: false, message: 'This job has already finished.' });
  });

  it('keeps spreadsheet formulas out of the failed items file', () => {
    expect(failedCsv([{ seq: 1, status: 'failed', message: '=HYPERLINK("x")' }])).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('audit log', () => {
  it('pages newest first and filters by person, offering the people seen', async () => {
    const m = memoryAdmin();
    let s!: AuditSession;
    const addr = fakeAddress({}, (read) => void s.fromUrl(read));
    s = new AuditSession(m.gateway, addr.nav);
    await s.fromUrl(addr.read);
    expect(s.controller.snapshot.items).toHaveLength(30);
    expect(s.options([]).person.map((p) => p.label).sort()).toEqual(['Asha Shetty', 'Website form']);
    s.applyFilters({ person: 'api:Website form', dateFrom: '2026-10-24' });
    await settle();
    expect(addr.params()).toEqual({ person: 'api:Website form', dateFrom: '2026-10-24' });
    expect(addr.urls.at(-1)!.replace).toBe(true);
    expect(s.controller.snapshot.items.every((e) => e.actorId === 'api:Website form')).toBe(true);
    expect(s.pills([]).map((p) => p.label)).toEqual(['Person: Website form', 'Date: 2026-10-24 – …']);
    s.removeFilter('person');
    await settle();
    expect(addr.params()).toEqual({ dateFrom: '2026-10-24' });
  });
});

describe('connectors', () => {
  it('shows secrets as set or not set, sends only new secret values, tests and retries', async () => {
    const m = memoryAdmin();
    const addr = fakeAddress();
    const s = new ConnectorSession(m.gateway, 'crm', addr.nav);
    await s.load();
    expect(s.state.value.secrets.map((x) => [x.name, x.set, x.editing])).toEqual([['signingSecret', true, false]]);
    expect(s.fields().map((f) => f.key)).toEqual(['url', 'enabled']);
    expect((await s.save()).ok).toBe(true);
    expect(m.calls.find((c) => c.op === 'saveConnector')!.args[1]).toEqual({ enabled: true, config: { url: 'https://crm.test/in' } });
    s.editSecret('signingSecret');
    s.typeSecret('signingSecret', 'new-secret');
    await s.save();
    expect(m.calls.filter((c) => c.op === 'saveConnector').at(-1)!.args[1]).toMatchObject({ secrets: { signingSecret: 'new-secret' } });
    expect(JSON.stringify(s.state.value.view)).not.toContain('new-secret');
    await s.test();
    expect(s.state.value.testResult).toEqual({ ok: true, message: 'Test accepted (answer 200).' });
    s.setChip('failed');
    expect(s.shownDeliveries().map((d) => d.id)).toEqual(['d1']);
    s.openResult('d1');
    expect(addr.urls.at(-1)).toEqual({ params: { result: 'd1' }, replace: false });
    expect(await s.retry('d1')).toEqual({ ok: true, message: 'Sending again now.' });
    expect(await s.retry('d2')).toEqual({ ok: false, message: 'This delivery was already sent.' });
  });

  it('sets up a new connector of the chosen kind', async () => {
    const m = memoryAdmin();
    const s = new ConnectorSession(m.gateway, 'gateway', fakeAddress().nav);
    await s.load('sms');
    expect(s.state.value.isNew).toBe(true);
    expect(s.fields().map((f) => f.key)).toEqual(['url', 'method', 'body', 'contentType', 'enabled']);
    expect(await s.save()).toEqual({ ok: false, message: '' });
    expect(s.state.value.errors).toEqual({ url: 'Address (https://) is required.' });
    s.setValues({ ...s.state.value.values, url: 'https://sms.test/send' });
    expect((await s.save()).ok).toBe(true);
    expect(m.calls.filter((c) => c.op === 'saveConnector').at(-1)!.args[1]).toEqual({ kind: 'sms', enabled: false, config: { url: 'https://sms.test/send', method: 'POST', contentType: 'json' } });
  });

  it('saves an http lookup with JSON, numbers and lists as values, names its secrets and tests with its inputs', async () => {
    const m = memoryAdmin();
    const s = new ConnectorSession(m.gateway, 'ifsc', fakeAddress().nav);
    await s.load('http');
    expect(s.fields().map((f) => f.key)).toContain('emailSender');
    s.setValues({ ...s.state.value.values, mode: 'lookup', method: 'GET', url: 'https://ifsc.test/x', inputs: 'ifsc\n', responseMap: '{ "bankName": "BANK"', timeoutMs: '5000', success: '[200]' });
    expect(s.fields().map((f) => f.key)).not.toContain('emailSender');
    expect((await s.save()).ok).toBe(false);
    expect(s.state.value.errors).toEqual({ responseMap: 'Answer fields (JSON) is not valid JSON.' });
    s.setValues({ ...s.state.value.values, responseMap: '{ "bankName": "BANK" }' });
    s.setNewSecret('apiKey');
    s.addSecret();
    s.typeSecret('apiKey', 'k-1');
    expect((await s.save()).ok).toBe(true);
    expect(m.calls.filter((c) => c.op === 'saveConnector').at(-1)!.args[1]).toEqual({
      kind: 'http',
      enabled: false,
      config: { mode: 'lookup', method: 'GET', url: 'https://ifsc.test/x', contentType: 'json', inputs: ['ifsc'], responseMap: { bankName: 'BANK' }, success: [200], timeoutMs: 5000 },
      secrets: { apiKey: 'k-1' },
    });
    expect(s.testMode()).toBe('lookup');
    s.setTestInput('ifsc', 'HDFC0000001');
    await s.test();
    expect(m.calls.filter((c) => c.op === 'testConnector').at(-1)!.args[1]).toEqual({ inputs: { ifsc: 'HDFC0000001' } });
    expect(s.state.value.testResult).toEqual({ ok: true, message: 'Looked up these values.', values: [{ key: 'bankName', value: 'HDFC Bank' }] });
  });

  it('connects an account sign-in only once it is saved', async () => {
    const m = memoryAdmin();
    const s = new ConnectorSession(m.gateway, 'google', fakeAddress().nav);
    await s.load('oauth');
    expect(await s.connect()).toEqual({ ok: false, message: '' });
    s.setValues({ ...s.state.value.values, authorizationUrl: 'https://a.test/auth', tokenUrl: 'https://a.test/token', clientId: 'c1', scopes: 'mail.send\ncalendar' });
    expect((await s.save()).ok).toBe(true);
    expect(m.calls.filter((c) => c.op === 'saveConnector').at(-1)!.args[1]).toMatchObject({ config: { scopes: ['mail.send', 'calendar'] } });
    expect(s.oauthState()).toBe('Not connected');
    expect(await s.connect()).toEqual({ url: 'https://provider.test/auth?connector=google' });
  });
});

describe('organisation settings', () => {
  it('sends only what changed and checks numbers; a fixed financial year start is not sent', async () => {
    const s = await memoryAdmin().gateway.settings();
    const v = settingsValues(s);
    expect(v).toEqual({ quotaGb: '1', apiRequestsPerMinute: '120', corsOrigins: '', financialYearStartMonth: '4' });
    expect(settingsChange(s, v)).toEqual({ change: {} });
    expect(settingsChange(s, { ...v, quotaGb: '2', apiRequestsPerMinute: '60', financialYearStartMonth: '1' })).toEqual({
      change: { storageQuotaBytes: 2 * 1024 ** 3, apiRequestsPerMinute: 60, financialYearStartMonth: 1 },
    });
    expect(settingsChange({ ...s, financialYearFixed: true }, { ...v, financialYearStartMonth: '1' })).toEqual({ change: {} });
    expect(monthOptions()[0]).toEqual({ key: '1', label: 'January' });
    expect(monthOptions().map((o) => o.key)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    expect(settingsChange(s, { ...v, apiRequestsPerMinute: '1.5' })).toEqual({
      errors: { apiRequestsPerMinute: 'Enter a whole number.' },
    });
  });

  it('sends the names and language from Identity only when they changed, and names each problem', async () => {
    const s = { ...(await memoryAdmin().gateway.settings()), legalName: null };
    const v = identityValues(s);
    expect(v).toEqual({ name: 'Demo Foundation', legalName: '', defaultLanguage: 'en' });
    expect(identityChange(s, { ...v, legalName: '  Demo   Trust ', defaultLanguage: 'hi' })).toEqual({ change: { legalName: 'Demo Trust', defaultLanguage: 'hi' } });
    expect(identityChange(s, { ...v, name: ' ', legalName: ' ' })).toEqual({
      errors: { name: 'Display name is required.', legalName: 'Legal name is required.' },
    });
    expect(sizeText(s.storage.usedBytes)).toBe('412 MB');
    expect(sizeText(s.storage.quotaBytes)).toBe('1 GB');
    expect(storagePercent(s.storage)).toBe(40);
  });
});
