import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ONBOARDING_STEPS, OrganisationOnboardingService } from '../src/application/organisations/onboarding-service.js';
import { buildServer } from '@onengo/server/http/server.js';
import { wireSequences } from '../src/composition/infrastructure.js';
import { postgresOnboardingStore } from '../src/infrastructure/postgres/stores/onboarding-store.js';
import type { OrganisationLifecycle } from '../src/domain/organisations/ports/organisation-directory.js';
import { ownerCapabilities } from '../src/infrastructure/postgres/tenant-directory.js';
import { MemoryLogger } from '@onengo/kernel/observability';
import { transactions } from '../src/infrastructure/postgres/tx.js';
import { loadModulePackage } from '../src/runtime/definitions/package-loader.js';
import type { OrganisationOperations } from '../src/application/organisations/control-plane.js';
import { organisationOperations } from '../src/composition/organisations.js';
import { createPlatform, MODULES_DIR, PATHS } from '../src/platform.js';
import { admin, createWorld, currentFiscalYear, expectCode, type TestWorld } from './helpers.js';

const OPERATOR = 'ops@onengo.test';
const root = join(import.meta.dirname, '..');

let w: TestWorld;
let ops: OrganisationOperations;
let owner: OrganisationLifecycle;

beforeAll(async () => {
  w = await createWorld();
  ops = organisationOperations(w.platform, PATHS);
  owner = ownerCapabilities(w.platform.db).organisations;
});
afterAll(() => w.close());

function request(code: string, over: Record<string, unknown> = {}) {
  return {
    requestId: `ONB-${code}`,
    organisation: {
      code,
      displayName: 'Helping Hands',
      legalName: 'Helping Hands Charitable Trust',
      contact: { email: 'Office@HelpingHands.org', phone: '+91 80 4000 1234', website: 'https://helpinghands.org' },
      address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', postalCode: '560001', country: 'in' },
      timezone: 'Asia/Kolkata',
      defaultLanguage: 'en',
      region: 'asia-south1',
      registrations: [
        { type: '80G', number: 'aaatc1234f/80g/2024', issuingAuthority: 'Income Tax Department', issuedOn: '2024-04-01' },
        { type: '12a', number: 'AAATC1234FE20214' },
      ],
    },
    administrator: { name: 'Meera Rao', email: `meera@${code}.org` },
    modules: ['donations'],
    financialYear: { startMonth: 4, current: currentFiscalYear() },
    receiptPrefix: 'HH',
    ...over,
  };
}

const withOrganisation = (base: ReturnType<typeof request>, changes: Record<string, unknown>) => ({ ...base, organisation: { ...base.organisation, ...changes } });

async function tenantsWithKey(key: string): Promise<number> {
  const [row] = await w.platform.db.asSystem((tx) => tx.query<{ n: number }>(`select count(*)::int as n from tenant where key = $1`, [key]));
  return row!.n;
}

const inviteTokenFor = (email: string) => {
  const mail = [...w.mail.sent].reverse().find((m) => m.to === email && /invited/.test(m.subject));
  return mail ? new URL(/https:\S+/.exec(mail.text ?? '')![0]).searchParams.get('token')! : undefined;
};

/** A service whose steps can be interrupted right after one is recorded. */
function interruptedAfter(step: string, crash: 'fail' | 'stop') {
  const wrapped: OrganisationLifecycle = { ...owner };
  let armed = true;
  const interrupt = () => {
    if (armed) {
      armed = false;
      throw new Error('interrupted');
    }
  };
  wrapped.recordStep = async (...args) => {
    await owner.recordStep(...args);
    if (args[2] === step) interrupt();
  };
  wrapped.createTenant = async (...args) => {
    const id = await owner.createTenant(...args);
    if (step === 'tenant') interrupt();
    return id;
  };
  // A stopped process records nothing: the request stays in `provisioning`.
  if (crash === 'stop') wrapped.recordFailure = async () => undefined;
  const modules = async (key: string) => (key === 'donations' ? (await loadModulePackage(join(MODULES_DIR, key), w.platform.schemas)).manifest : undefined);
  return new OrganisationOnboardingService(transactions(w.platform.db), postgresOnboardingStore(wireSequences()), wrapped, w.platform.definitions, w.platform.identity, w.platform.ledger, modules, new MemoryLogger());
}

describe('onboarding input', () => {
  it('reports every problem by field before anything is written', async () => {
    const bad = {
      ...request('Asha'),
      password: 'Secret-123456',
      organisation: {
        ...request('x').organisation,
        code: 'asha',
        legalName: '',
        timezone: 'Mars/Olympus',
        defaultLanguage: 'xx',
        contact: { email: 'not-an-email' },
        registrations: [
          { type: '80g', number: 'A1', issuedOn: '2024-02-30' },
          { type: '80g', number: 'b2', issuedOn: '2024-04-01', expiresOn: '2023-04-01' },
          { type: '12a', number: 'X9' },
          { type: '12A', number: 'x9' },
        ],
      },
      modules: ['donations', 'payroll', '../etc'],
      financialYear: { startMonth: 4, current: '2026' },
      receiptPrefix: 'HH/26',
    };
    const err = await expectCode(ops.onboarding.onboard(OPERATOR, bad), 'validation_failed');
    const paths = (err as unknown as { issues: { path: string }[] }).issues.map((i) => i.path).sort();
    expect(paths).toEqual(
      [
        'financialYear.current',
        'modules[1]',
        'modules[2]',
        'organisation.code',
        'organisation.contact.email',
        'organisation.defaultLanguage',
        'organisation.legalName',
        'organisation.registrations[0].issuedOn',
        'organisation.registrations[1].expiresOn',
        'organisation.registrations[3].number',
        'organisation.timezone',
        'password',
        'receiptPrefix',
      ].sort(),
    );
    expect(JSON.stringify(err)).not.toMatch(/X9|B2|A1/i);
    expect(await tenantsWithKey('asha')).toBe(1);
  });

  it('refuses reserved and malformed codes, and a receipt prefix without receipts', async () => {
    for (const code of ['api', 'a', '9lives', 'double--dash', 'trailing-', 'Has Space']) {
      const err = await expectCode(ops.onboarding.validate(request(code)), 'validation_failed');
      expect((err as unknown as { issues: { path: string }[] }).issues.map((i) => i.path)).toContain('organisation.code');
    }
    const err = await expectCode(ops.onboarding.validate(request('no-receipts', { modules: [] })), 'validation_failed');
    expect((err as unknown as { issues: { path: string }[] }).issues.map((i) => i.path)).toEqual(['receiptPrefix']);
  });

  it('checks without writing in validation-only mode', async () => {
    const outcome = await ops.onboarding.onboard(OPERATOR, request('validonly'), { validateOnly: true });
    expect(outcome).toMatchObject({ status: 'valid', code: 'validonly', organisationId: null });
    expect(await tenantsWithKey('validonly')).toBe(0);
    expect(await owner.onboarding('ONB-validonly')).toBeUndefined();
  });

  it('needs an operator identity', async () => {
    await expectCode(ops.onboarding.onboard('', request('nooperator')), 'validation_failed');
    await expectCode(ops.lifecycle.suspend(' ', 'asha', 'x'), 'validation_failed');
  });
});

describe('provisioning', () => {
  const input = request('helpinghands');
  let tenantId = '';

  it('creates one active organisation with its profile, modules, financial year and administrator', async () => {
    const outcome = await ops.onboarding.onboard(OPERATOR, input);
    expect(outcome).toMatchObject({ requestId: 'ONB-helpinghands', code: 'helpinghands', status: 'active', step: 'active', invitation: 'sent', failure: null });
    tenantId = outcome.organisationId!;
    const ctx = w.as(tenantId);
    const view = await w.platform.organisation.view(ctx);
    expect(view).toMatchObject({
      code: 'helpinghands',
      displayName: 'Helping Hands',
      legalName: 'Helping Hands Charitable Trust',
      contact: { email: 'office@helpinghands.org', phone: '+91 80 4000 1234', website: 'https://helpinghands.org' },
      address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', postalCode: '560001', country: 'IN' },
      timezone: 'Asia/Kolkata',
    });
    expect(view.registrations.map((r) => [r.type, r.number, r.issuedOn])).toEqual([
      ['12a', 'AAATC1234FE20214', null],
      ['80g', 'AAATC1234F/80G/2024', '2024-04-01'],
    ]);
    const facts = await w.platform.db.withTenant(tenantId, async (tx) => ({
      modules: await tx.query<{ module_key: string }>(`select module_key from tenant_module where enabled`),
      roles: (await tx.query<{ key: string }>(`select key from role order by key`)).map((r) => r.key),
      accounts: (await tx.query<{ code: string }>(`select code from ledger_account order by code`)).map((r) => r.code),
      series: await tx.query<{ key: string; prefix: string }>(`select key, prefix from receipt_series`),
      years: await tx.query<{ key: string; status: string; starts_on: string }>(`select key, status, starts_on::text from fiscal_period`),
      startMonth: await tx.query<{ value: unknown }>(`select value from tenant_setting where key = 'finance.financialYearStartMonth'`),
      definitions: await tx.query<{ n: number }>(`select count(*)::int as n from definition where tenant_id = app_tenant() and module_key = 'donations' and status = 'published'`),
    }));
    expect(facts.modules).toEqual([{ module_key: 'donations' }]);
    expect(facts.roles).toEqual(['admin', 'finance', 'viewer']);
    expect(facts.accounts).toEqual(['BANK', 'CASH', 'DONATION_INCOME']);
    expect(facts.series).toEqual([{ key: 'donation-receipt', prefix: 'HH' }]);
    expect(facts.years).toEqual([{ key: currentFiscalYear(), status: 'open', starts_on: `${currentFiscalYear().slice(0, 4)}-04-01` }]);
    expect(facts.startMonth).toEqual([{ value: 4 }]);
    expect(facts.definitions[0]!.n).toBeGreaterThan(5);
    const members = await w.platform.people.list(ctx);
    expect(members.items.map((m) => [m.email, m.displayName, m.roles, m.status])).toEqual([['meera@helpinghands.org', 'Meera Rao', ['admin'], 'invited']]);
  });

  it('invites the administrator once, and the invitation leads to a sign-in to the new organisation', async () => {
    const token = inviteTokenFor('meera@helpinghands.org');
    expect(token).toBeTruthy();
    expect(w.mail.sent.filter((m) => m.to === 'meera@helpinghands.org')).toHaveLength(1);
    expect(w.mail.sent.find((m) => m.to === 'meera@helpinghands.org')!.subject).toBe('You have been invited to Helping Hands');
    await expect(w.platform.identity.completePasswordToken({ token: token!, password: 'A long new passphrase 42' })).resolves.toEqual({ tenantKey: 'helpinghands' });
    const pair = await w.platform.identity.loginWithPassword({ tenantKey: 'helpinghands', email: 'meera@helpinghands.org', password: 'A long new passphrase 42' });
    expect(pair.tenantId).toBe(tenantId);
  });

  it('returns the same organisation when the same request runs again, and refuses changed contents', async () => {
    const sent = w.mail.sent.length;
    const again = await ops.onboarding.onboard(OPERATOR, input);
    expect(again).toMatchObject({ organisationId: tenantId, status: 'active', invitation: 'sent' });
    expect(await tenantsWithKey('helpinghands')).toBe(1);
    expect(w.mail.sent.length).toBe(sent);
    await expectCode(ops.onboarding.onboard(OPERATOR, withOrganisation(input, { displayName: 'Other Hands' })), 'conflict');
  });

  it('refuses the same code in another request', async () => {
    const err = await expectCode(ops.onboarding.onboard(OPERATOR, { ...input, requestId: 'ONB-other' }), 'validation_failed');
    expect((err as unknown as { issues: { path: string }[] }).issues).toEqual([{ path: 'organisation.code', message: expect.stringMatching(/already uses this code/) }]);
  });

  it('keeps only what later steps need in the stored request', async () => {
    const stored = (await owner.onboarding('ONB-helpinghands'))!.input as { organisation: { registrations: unknown[]; contact: { email: unknown } } };
    expect(stored.organisation.registrations).toEqual([]);
    expect(stored.organisation.contact.email).toBeNull();
    expect(JSON.stringify(stored)).not.toContain('AAATC1234F');
  });

  it('opens a calendar financial year for an organisation whose year starts in January', async () => {
    const year = String(new Date().getUTCFullYear());
    const outcome = await ops.onboarding.onboard(OPERATOR, request('calendar-year', { financialYear: { startMonth: 1, current: year }, modules: [], receiptPrefix: null }));
    expect(outcome.status).toBe('active');
    const years = await w.platform.db.withTenant(outcome.organisationId!, (tx) => tx.query<{ key: string; starts_on: string }>(`select key, starts_on::text from fiscal_period`));
    expect(years).toEqual([{ key: year, starts_on: `${year}-01-01` }]);
    const settings = await w.platform.administration.settings(w.as(outcome.organisationId!));
    expect(settings).toMatchObject({ financialYearStartMonth: 1, financialYearFixed: true, code: 'calendar-year', legalName: 'Helping Hands Charitable Trust' });
  });
});

describe('resuming interrupted provisioning', () => {
  const steps = ONBOARDING_STEPS.filter((s) => s !== 'requested' && s !== 'active');

  it.each(steps.map((s, i) => [s, i]))('after %s, whether the run failed or the process stopped', async (step, i) => {
    for (const crash of ['fail', 'stop'] as const) {
      const code = `resume-${i}-${crash}`;
      const input = request(code, { modules: ['donations'] });
      const first = await interruptedAfter(step, crash).onboard(OPERATOR, input);
      expect(first.status, `${step} ${crash}`).not.toBe('active');
      expect(await w.platform.identity.loginWithPassword({ tenantKey: code, email: `meera@${code}.org`, password: 'x' }).catch((e: Error) => e.name)).toBe('AuthError');
      if (crash === 'fail') expect(first.failure).toEqual({ code: 'internal', message: expect.stringMatching(/Retry the request/) });
      const second = crash === 'fail' ? await ops.onboarding.retry(OPERATOR, input.requestId) : await ops.onboarding.onboard(OPERATOR, input);
      expect(second, `${step} ${crash}`).toMatchObject({ status: 'active', step: 'active', invitation: 'sent', failure: null });
      expect(await tenantsWithKey(code)).toBe(1);
      const members = await w.platform.db.withTenant(second.organisationId!, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from tenant_member`));
      expect(members[0]!.n).toBe(1);
      const profiles = await w.platform.db.withTenant(second.organisationId!, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from record where type_key = 'person'`));
      expect(profiles[0]!.n).toBe(0);
    }
  });
});

describe('the primary administrator', () => {
  it('reuses an existing account, adding it only to the new organisation', async () => {
    const { userId } = await w.platform.people.add(w.as(w.ngoA), { email: 'ravi@shared.org', displayName: 'Ravi Kumar', roles: ['finance'] });
    await w.platform.identity.setPassword(userId, 'Ravi has a long passphrase 7');
    const outcome = await ops.onboarding.onboard(OPERATOR, request('second-home', { administrator: { name: 'Someone Else', email: 'RAVI@shared.org' } }));
    expect(outcome.status).toBe('active');
    const there = await w.platform.people.list(w.as(outcome.organisationId!));
    expect(there.items.map((m) => [m.userId, m.displayName, m.roles])).toEqual([[userId, 'Someone Else', ['admin']]]);
    expect((await w.platform.people.member(w.as(w.ngoA), userId)).roles).toEqual(['finance']);
    await expectCode(w.platform.people.member(w.as(w.ngoB), userId), 'not_found');
    // Their own password still signs them in to both.
    for (const tenantKey of ['asha', 'second-home']) {
      await expect(w.platform.identity.loginWithPassword({ tenantKey, email: 'ravi@shared.org', password: 'Ravi has a long passphrase 7' })).resolves.toBeTruthy();
    }
  });

  it('is invited only after the organisation is active and committed', async () => {
    const seen: string[] = [];
    const send = vi.spyOn(w.mail, 'send').mockImplementation(async (message) => {
      seen.push((await owner.organisation('after-commit'))?.status ?? 'missing');
      w.mail.sent.push(message);
    });
    try {
      expect((await ops.onboarding.onboard(OPERATOR, request('after-commit'))).invitation).toBe('sent');
    } finally {
      send.mockRestore();
    }
    expect(seen).toEqual(['active']);
  });

  it('records a failed invitation, and a retry sends it without another organisation or administrator', async () => {
    const invite = vi.spyOn(w.platform.identity, 'inviteMember').mockRejectedValueOnce(new Error('mail relay down'));
    const first = await ops.onboarding.onboard(OPERATOR, request('flaky-mail'));
    invite.mockRestore();
    expect(first).toMatchObject({ status: 'active', invitation: 'failed' });
    expect(inviteTokenFor('meera@flaky-mail.org')).toBeUndefined();
    const second = await ops.onboarding.retry(OPERATOR, 'ONB-flaky-mail');
    expect(second).toMatchObject({ organisationId: first.organisationId, status: 'active', invitation: 'sent' });
    expect(inviteTokenFor('meera@flaky-mail.org')).toBeTruthy();
    expect(await tenantsWithKey('flaky-mail')).toBe(1);
    expect((await w.platform.people.list(w.as(first.organisationId!))).total).toBe(1);
  });
});

describe('lifecycle', () => {
  const code = 'lifecycle-ngo';
  let tenantId = '';
  const email = `meera@${code}.org`;
  const password = 'Lifecycle passphrase 2026';
  const signIn = () => w.platform.identity.loginWithPassword({ tenantKey: code, email, password });

  beforeAll(async () => {
    tenantId = (await ops.onboarding.onboard(OPERATOR, request(code))).organisationId!;
    await w.platform.identity.completePasswordToken({ token: inviteTokenFor(email)!, password });
  });

  let suspendedSession = { refreshToken: '' };
  let crmKey = '';

  it('suspends: sessions end, API keys stop, sign-in is refused, and no data is deleted', async () => {
    const pair = await signIn();
    suspendedSession = pair;
    const key = await w.platform.apiKeys.create(w.as(tenantId), { name: 'crm', role: 'viewer' });
    crmKey = key.token;
    await expect(w.platform.apiKeys.authenticate(key.token)).resolves.toMatchObject({ tenantId });
    await expect(w.platform.identity.authenticate(pair.accessToken)).resolves.toMatchObject({ tenantId });
    const records = await w.platform.db.asSystem((tx) => tx.query<{ n: number }>(`select count(*)::int as n from definition where tenant_id = $1`, [tenantId]));

    const status = await ops.lifecycle.suspend(OPERATOR, code, 'Unpaid invoice INV-7');
    expect(status.organisation).toMatchObject({ code, status: 'suspended' });
    w.platform.identity.forgetActors();
    await expect(w.platform.identity.authenticate(pair.accessToken)).rejects.toThrow('Your access has been removed.');
    await expect(w.platform.identity.refresh(pair.refreshToken)).rejects.toThrow();
    await expect(w.platform.apiKeys.authenticate(key.token)).rejects.toThrow('This API key is not valid.');
    await expect(signIn()).rejects.toThrow('Sign-in failed');
    const after = await w.platform.db.asSystem((tx) => tx.query<{ n: number }>(`select count(*)::int as n from definition where tenant_id = $1`, [tenantId]));
    expect(after).toEqual(records);
    await expectCode(ops.lifecycle.suspend(OPERATOR, code, 'again'), 'conflict');
  });

  it('reactivates: valid credentials work again, ended sessions and revoked keys do not', async () => {
    const revoked = await w.platform.apiKeys.create(w.as(tenantId), { name: 'old', role: 'viewer' });
    await w.platform.apiKeys.revoke(w.as(tenantId), revoked.id);
    await ops.lifecycle.reactivate(OPERATOR, code);
    await expect(w.platform.identity.refresh(suspendedSession.refreshToken)).rejects.toThrow();
    const pair = await signIn();
    await expect(w.platform.identity.authenticate(pair.accessToken)).resolves.toMatchObject({ tenantId });
    await expect(w.platform.apiKeys.authenticate(crmKey)).resolves.toMatchObject({ tenantId });
    await expect(w.platform.apiKeys.authenticate(revoked.token)).rejects.toThrow('This API key is not valid.');
  });

  it('closes a suspended organisation for good, keeping its data', async () => {
    await expectCode(ops.lifecycle.close(OPERATOR, code, 'Left the platform'), 'conflict');
    await ops.lifecycle.suspend(OPERATOR, code, 'Closing');
    await expectCode(ops.lifecycle.close(OPERATOR, code), 'validation_failed');
    expect((await ops.lifecycle.close(OPERATOR, code, 'Left the platform')).organisation).toMatchObject({ status: 'closed' });
    await expect(signIn()).rejects.toThrow('Sign-in failed');
    await expectCode(ops.lifecycle.reactivate(OPERATOR, code), 'conflict');
    const kept = await w.platform.db.asSystem((tx) => tx.query<{ n: number }>(`select count(*)::int as n from tenant_member where tenant_id = $1`, [tenantId]));
    expect(kept[0]!.n).toBe(1);
  });

  it('shows status with every operator action and provisioning step, also in the organisation’s own audit', async () => {
    const status = await ops.lifecycle.status({ code });
    expect(status.onboarding).toMatchObject({ requestId: `ONB-${code}`, state: 'active', step: 'active', invitation: 'sent', requestedBy: OPERATOR });
    const actions = status.history.map((h) => h.action).reverse();
    expect(actions.slice(0, 3)).toEqual(['onboarding.requested', 'onboarding.step', 'onboarding.step']);
    expect(actions.filter((a) => a === 'onboarding.step')).toHaveLength(ONBOARDING_STEPS.length - 2);
    expect(actions.slice(-6)).toEqual([
      'organisation.activated',
      'onboarding.invitation.sent',
      'organisation.suspended',
      'organisation.reactivated',
      'organisation.suspended',
      'organisation.closed',
    ]);
    expect(status.history.every((h) => h.operator === OPERATOR)).toBe(true);
    expect(JSON.stringify(status)).not.toContain('AAATC1234F');
    const audit = await w.platform.db.asSystem((tx) =>
      tx.query<{ action: string; actor_id: string }>(`select action, actor_id from audit_event where tenant_id = $1 and entity = 'tenant' and action like 'organisation.%' order by id`, [tenantId]),
    );
    expect(audit.filter((a) => a.actor_id.startsWith('system:operator:')).map((a) => a.action)).toEqual([
      'organisation.activated',
      'organisation.suspended',
      'organisation.reactivated',
      'organisation.suspended',
      'organisation.closed',
    ]);
    await expectCode(ops.lifecycle.status({ code: 'no-such-ngo' }), 'not_found');
  });

  it('refuses sign-in while provisioning or after provisioning failed', async () => {
    for (const crash of ['stop', 'fail'] as const) {
      const c = `half-done-${crash}`;
      const outcome = await interruptedAfter('administrator', crash).onboard(OPERATOR, request(c));
      expect(outcome.status).toBe(crash === 'stop' ? 'provisioning' : 'provisioning_failed');
      const [user] = await w.platform.db.asSystem((tx) => tx.query<{ id: string }>(`select id from app_user where email = $1`, [`meera@${c}.org`]));
      await w.platform.identity.setPassword(user!.id, 'Half done passphrase 99');
      await expect(w.platform.identity.loginWithPassword({ tenantKey: c, email: `meera@${c}.org`, password: 'Half done passphrase 99' })).rejects.toThrow('Sign-in failed');
      expect(inviteTokenFor(`meera@${c}.org`)).toBeUndefined();
    }
  });
});

describe('operator authority and isolation', () => {
  it('keeps the runtime role out of onboarding requests, the platform audit and the organisation status', async () => {
    for (const statement of [
      `select * from organisation_onboarding`,
      `select * from platform_audit`,
      `update tenant set status = 'active'`,
      `update tenant set legal_name = 'x'`,
      `insert into platform_audit (operator, action) values ('me', 'x')`,
    ]) {
      await expect(w.platform.db.withTenant(w.ngoA, (tx) => tx.query(statement)), statement).rejects.toThrow(/permission denied/);
    }
  });

  it('keeps the platform audit append-only even for the owner', async () => {
    await expect(w.platform.db.asSystem((tx) => tx.query(`delete from platform_audit`))).rejects.toThrow(/cannot be changed or deleted/);
    await expect(w.platform.db.asSystem((tx) => tx.query(`update tenant set key = 'renamed' where id = $1`, [w.ngoA]))).rejects.toThrow(/cannot change/);
  });

  it('offers no route for operator actions, so no tenant credential can reach them', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    try {
      await app.ready();
      const routes = app.printRoutes({ commonPrefix: false });
      expect(routes).not.toMatch(/onboard|provision|lifecycle|operator/i);
      expect(routes.split('\n').filter((l) => /organisation/.test(l)).join('\n')).not.toMatch(/suspend|reactivate|close|status|retry/);
      for (const [method, url] of [
        ['POST', '/api/auth/organisations/asha'],
        ['POST', '/api/admin/organisations'],
        ['POST', '/api/admin/organisation/suspend'],
        ['PUT', '/api/admin/organisation/status'],
      ] as const) {
        const res = await app.inject({ method, url, headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(admin) }, payload: { status: 'active' } });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it('builds the operator services only behind the operator API, never at main process start', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
      });
    const users = files(join(root, 'src'))
      .filter((p) => /organisationOperations\(|OrganisationOnboardingService|OrganisationLifecycleService/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(root, p).split(sep).join('/'))
      .sort();
    expect(users).toEqual([
      'src/api/operator.ts',
      'src/application/organisations/control-plane.ts',
      'src/application/organisations/lifecycle-service.ts',
      'src/application/organisations/onboarding-service.ts',
      'src/composition/organisations.ts',
    ]);
    const platformSource = readFileSync(join(root, 'src/platform.ts'), 'utf8');
    const createPlatformBody = platformSource.slice(platformSource.indexOf('export async function createPlatform'));
    expect(createPlatformBody).not.toMatch(/organisationOperations|Onboarding|provisionTenant/);
    for (const entry of ['main.ts', 'deploy.ts']) {
      expect(readFileSync(join(root, '..', '..', 'apps/onengo/server/src', entry), 'utf8'), entry).not.toMatch(/organisationOperations|onboard|provisionTenant/i);
    }
    expect(readFileSync(join(root, '..', '..', 'packages/common/build-app.ts'), 'utf8')).not.toContain('organisation-cli');
    const scripts = (JSON.parse(readFileSync(join(root, '..', '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(Object.keys(scripts).filter((name) => name.startsWith('organisation:'))).toEqual([]);
  });

  it('creates and changes no organisation when the platform starts', async () => {
    const count = () => w.platform.db.asSystem((tx) => tx.query<{ t: number; o: number; a: number }>(
      `select (select count(*) from tenant)::int as t, (select count(*) from organisation_onboarding)::int as o, (select count(*) from platform_audit)::int as a`,
    ));
    const before = await count();
    await createPlatform(w.platform.db, { tokenSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32), logger: new MemoryLogger() });
    expect(await count()).toEqual(before);
  });
});
