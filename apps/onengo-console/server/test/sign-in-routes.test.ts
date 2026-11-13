import { afterEach, describe, expect, it, vi } from 'vitest';
import { validationFailed } from '@onengo/kernel/errors';
import { buildOperatorServer } from '../src/http/server.js';
import { SESSION_COOKIE } from '../src/operators/security.js';

const session = (actions: string[]) => ({
  id: '20000000-0000-4000-8000-000000000002', token: 't', operatorId: '10000000-0000-4000-8000-000000000001',
  issuer: 'https://id.example/', subject: 'ops-1', display: 'Ops', authTime: new Date().toISOString(), amr: ['mfa'],
  actions, csrf: 'csrf-1',
});
const STEP_UP = '30000000-0000-4000-8000-000000000003';
const view = { organisation: { code: 'asha', displayName: 'Asha', status: 'active' }, policy: {}, shared: [], own: [] };

function server(actions = ['sign_in'], stepUpOk = true) {
  const store = { session: vi.fn().mockResolvedValue(session(actions)), consumeStepUp: vi.fn().mockResolvedValue(stepUpOk) };
  const signIn = {
    get: vi.fn().mockResolvedValue(view),
    savePolicy: vi.fn().mockResolvedValue(view),
    saveProvider: vi.fn().mockResolvedValue(view),
    removeProvider: vi.fn().mockResolvedValue(view),
    setProviderPolicy: vi.fn().mockResolvedValue(view),
    testProvider: vi.fn().mockResolvedValue({ ok: true, issuer: 'https://idp.test', checks: [] }),
  };
  const app = buildOperatorServer({ store: store as never, provider: { config: { issuer: 'https://id.example/' } } as never, control: { signIn } as never });
  return { app, store, signIn };
}
const cookie = { cookie: `${SESSION_COOKIE}=t` };
const write = { ...cookie, 'x-csrf-token': 'csrf-1' };
const change = { reason: 'Moving to Entra', stepUpId: STEP_UP };
let open: ReturnType<typeof server>['app'] | undefined;
afterEach(async () => { await open?.close(); open = undefined; });

describe('console sign-in routes', () => {
  it('reads an organisation’s sign-in with the sign_in grant only', async () => {
    const granted = server();
    open = granted.app;
    const res = await granted.app.inject({ method: 'GET', url: '/op/organisations/Asha/sign-in', headers: cookie });
    expect(res.statusCode).toBe(200);
    expect(granted.signIn.get).toHaveBeenCalledWith(expect.objectContaining({ operatorId: '10000000-0000-4000-8000-000000000001' }), 'asha');
    await granted.app.close();

    const refused = server(['status']);
    open = refused.app;
    expect((await refused.app.inject({ method: 'GET', url: '/op/organisations/asha/sign-in', headers: cookie })).statusCode).toBe(403);
    expect(refused.signIn.get).not.toHaveBeenCalled();
  });

  it('needs CSRF, a reason and a one-use step-up for sign_in on that organisation before any change', async () => {
    const s = server();
    open = s.app;
    const put = (headers: Record<string, string>, payload: object) =>
      s.app.inject({ method: 'PUT', url: '/op/organisations/asha/sign-in/providers/asha-idp', headers, payload });
    const provider = { label: 'Asha', issuer: 'https://idp.test', clientId: 'c', clientSecret: 'secret', allowedDomains: ['asha.org'] };

    expect((await put(cookie, { ...change, provider })).statusCode).toBe(403);
    expect((await put(write, { stepUpId: STEP_UP, provider })).statusCode).toBe(403);
    expect(s.store.consumeStepUp).not.toHaveBeenCalled();

    expect((await put(write, { ...change, provider })).statusCode).toBe(200);
    expect(s.store.consumeStepUp).toHaveBeenCalledWith(STEP_UP, '20000000-0000-4000-8000-000000000002', 'sign_in', 'asha');
    expect(s.signIn.saveProvider).toHaveBeenCalledWith(expect.anything(), 'asha', { ...provider, id: 'asha-idp' }, 'Moving to Entra', STEP_UP);
  });

  it('refuses a used or missing step-up', async () => {
    const s = server(['sign_in'], false);
    open = s.app;
    const res = await s.app.inject({ method: 'PUT', url: '/op/organisations/asha/sign-in/policy', headers: write, payload: { ...change, policy: {} } });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/step-up/);
    expect(s.signIn.savePolicy).not.toHaveBeenCalled();
  });

  it('routes policy, opt-in and removal changes, and tests a provider without a step-up', async () => {
    const s = server();
    open = s.app;
    const policy = { passwordEnabled: true, emailCodeEnabled: false, minimumAssurance: 'aal1' };
    expect((await s.app.inject({ method: 'PUT', url: '/op/organisations/asha/sign-in/policy', headers: write, payload: { ...change, policy } })).statusCode).toBe(200);
    expect(s.signIn.savePolicy).toHaveBeenCalledWith(expect.anything(), 'asha', policy, 'Moving to Entra', STEP_UP);
    const optIn = { enabled: true, assurance: 'aal2', allowedDomains: ['asha.org'] };
    await s.app.inject({ method: 'PUT', url: '/op/organisations/asha/sign-in/providers/google/policy', headers: write, payload: { ...change, policy: optIn } });
    expect(s.signIn.setProviderPolicy).toHaveBeenCalledWith(expect.anything(), 'asha', 'google', optIn, 'Moving to Entra', STEP_UP);
    await s.app.inject({ method: 'DELETE', url: '/op/organisations/asha/sign-in/providers/asha-idp', headers: write, payload: change });
    expect(s.signIn.removeProvider).toHaveBeenCalledWith(expect.anything(), 'asha', 'asha-idp', 'Moving to Entra', STEP_UP);

    s.store.consumeStepUp.mockClear();
    const test = await s.app.inject({ method: 'POST', url: '/op/organisations/asha/sign-in/providers/asha-idp/test', headers: write, payload: {} });
    expect(test.statusCode).toBe(200);
    expect(s.store.consumeStepUp).not.toHaveBeenCalled();
    expect((await s.app.inject({ method: 'POST', url: '/op/organisations/asha/sign-in/providers/asha-idp/test', headers: cookie, payload: {} })).statusCode).toBe(403);
  });

  it('answers platform errors with their status and message', async () => {
    const s = server();
    open = s.app;
    s.signIn.savePolicy.mockRejectedValueOnce(validationFailed('Keep at least two active sign-in administrators protected by an enabled method before switching passwords off.'));
    const res = await s.app.inject({ method: 'PUT', url: '/op/organisations/asha/sign-in/policy', headers: write, payload: { ...change, policy: {} } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed', message: expect.stringMatching(/two active sign-in administrators/) });
  });

  it('has no lifecycle route for the sign_in step-up action', () => {
    const s = server();
    open = s.app;
    expect(s.app.hasRoute({ method: 'POST', url: '/op/organisations/:code/sign_in' })).toBe(false);
    expect(s.app.hasRoute({ method: 'POST', url: '/op/organisations/:code/suspend' })).toBe(true);
  });
});
