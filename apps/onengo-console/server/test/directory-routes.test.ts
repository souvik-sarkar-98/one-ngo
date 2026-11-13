import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOperatorServer } from '../src/http/server.js';
import { refusedOwnChange } from '../src/operators/directory.js';
import { SESSION_COOKIE } from '../src/operators/security.js';

const OPERATOR = '10000000-0000-4000-8000-000000000001';
const session = (actions: string[]) => ({
  id: '20000000-0000-4000-8000-000000000002', token: 't', operatorId: OPERATOR,
  issuer: 'https://id.example/', subject: 'ops-1', display: 'Ops', authTime: new Date().toISOString(), amr: ['mfa'],
  actions, csrf: 'csrf-1',
});
const STEP_UP = '30000000-0000-4000-8000-000000000003';
const account = { id: '40000000-0000-4000-8000-000000000004', displayName: 'Ada', status: 'active', actions: ['status'], identities: [] };

function server(actions = ['operators', 'audit'], stepUpOk = true) {
  const store = { session: vi.fn().mockResolvedValue(session(actions)), consumeStepUp: vi.fn().mockResolvedValue(stepUpOk) };
  const directory = {
    list: vi.fn().mockResolvedValue({ operators: [account] }),
    get: vi.fn().mockResolvedValue(account),
    create: vi.fn().mockResolvedValue(account),
    saveGrants: vi.fn().mockResolvedValue(account),
    relink: vi.fn().mockResolvedValue(account),
    disable: vi.fn().mockResolvedValue(account),
    activity: vi.fn().mockResolvedValue({ entries: [] }),
    activityCsv: vi.fn().mockResolvedValue('at,operator\n'),
    listOrganisations: vi.fn().mockResolvedValue({ organisations: [] }),
  };
  const app = buildOperatorServer({
    store: store as never, directory: directory as never,
    provider: { config: { issuer: 'https://id.example/' } } as never, control: {} as never,
  });
  return { app, store, directory };
}
const cookie = { cookie: `${SESSION_COOKIE}=t` };
const write = { ...cookie, 'x-csrf-token': 'csrf-1' };
let open: ReturnType<typeof server>['app'] | undefined;
afterEach(async () => { await open?.close(); open = undefined; });

describe('operator directory routes', () => {
  it('lists organisations only with the look-up grant', async () => {
    const granted = server(['status']);
    open = granted.app;
    expect((await granted.app.inject({ method: 'GET', url: '/op/organisations?q=river', headers: cookie })).statusCode).toBe(200);
    expect(granted.directory.listOrganisations).toHaveBeenCalledWith({ q: 'river', status: undefined });
    await granted.app.close();

    const refused = server(['audit']);
    open = refused.app;
    expect((await refused.app.inject({ method: 'GET', url: '/op/organisations', headers: cookie })).statusCode).toBe(403);
    expect(refused.directory.listOrganisations).not.toHaveBeenCalled();
  });

  it('lists operators only with the operators grant', async () => {
    const granted = server();
    open = granted.app;
    expect((await granted.app.inject({ method: 'GET', url: '/op/operators?q=ada', headers: cookie })).statusCode).toBe(200);
    expect(granted.directory.list).toHaveBeenCalledWith({ q: 'ada', status: undefined });
    await granted.app.close();

    const refused = server(['audit']);
    open = refused.app;
    expect((await refused.app.inject({ method: 'GET', url: '/op/operators', headers: cookie })).statusCode).toBe(403);
    expect(refused.directory.list).not.toHaveBeenCalled();
  });

  it('creates an operator only after a one-use step-up for that subject', async () => {
    const s = server();
    open = s.app;
    const body = { displayName: 'Ada', subject: 'ada-1', actions: ['status'], stepUpId: STEP_UP };
    expect((await s.app.inject({ method: 'POST', url: '/op/operators', headers: cookie, payload: body })).statusCode).toBe(403);
    expect(s.store.consumeStepUp).not.toHaveBeenCalled();
    expect((await s.app.inject({ method: 'POST', url: '/op/operators', headers: write, payload: body })).statusCode).toBe(200);
    expect(s.store.consumeStepUp).toHaveBeenCalledWith(STEP_UP, '20000000-0000-4000-8000-000000000002', 'operators', 'ada-1');
    expect(s.directory.create).toHaveBeenCalledWith(expect.objectContaining({ operatorId: OPERATOR }), body, 'https://id.example/', STEP_UP);
  });

  it('refuses a grant change when the step-up was already used', async () => {
    const s = server(['operators'], false);
    open = s.app;
    const res = await s.app.inject({
      method: 'PUT', url: `/op/operators/${account.id}/grants`, headers: write,
      payload: { actions: ['status'], stepUpId: STEP_UP },
    });
    expect(res.statusCode).toBe(403);
    expect(s.directory.saveGrants).not.toHaveBeenCalled();
  });

  it('reads activity with the audit grant and downloads csv', async () => {
    const granted = server();
    open = granted.app;
    expect((await granted.app.inject({ method: 'GET', url: '/op/audit?limit=20', headers: cookie })).statusCode).toBe(200);
    expect(granted.directory.activity).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
    const csv = await granted.app.inject({ method: 'GET', url: '/op/audit.csv', headers: cookie });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    await granted.app.close();

    const refused = server(['operators']);
    open = refused.app;
    expect((await refused.app.inject({ method: 'GET', url: '/op/audit', headers: cookie })).statusCode).toBe(403);
  });

  it('sends an unknown operator login to the sign-in page', async () => {
    const store = {
      consumeLogin: vi.fn().mockResolvedValue({ state: 's', nonce: 'n', verifier: 'v', nextPath: '/organisations/find' }),
      createSession: vi.fn().mockResolvedValue(undefined),
    };
    const provider = {
      config: { issuer: 'https://id.example/' },
      callback: vi.fn().mockResolvedValue({ identity: { issuer: 'https://id.example/', subject: 'ada-1' }, tokens: {} }),
    };
    open = buildOperatorServer({ store: store as never, provider: provider as never, control: {} as never });
    const res = await open.inject({ method: 'GET', url: '/op/auth/callback?code=c&state=s' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/sign-in?refused=unknown&issuer=https%3A%2F%2Fid.example%2F&subject=ada-1');
  });
});

describe('own-account protection', () => {
  it('refuses disabling yourself, relinking yourself, or dropping your own manage action', () => {
    expect(refusedOwnChange(OPERATOR, OPERATOR, 'disable')).toMatch(/refused/);
    expect(refusedOwnChange(OPERATOR, OPERATOR, 'relink')).toMatch(/refused/);
    expect(refusedOwnChange(OPERATOR, OPERATOR, 'grants', ['status'])).toMatch(/refused/);
    expect(refusedOwnChange(OPERATOR, OPERATOR, 'grants', ['operators'])).toBeUndefined();
    expect(refusedOwnChange(OPERATOR, account.id, 'disable')).toBeUndefined();
  });
});
