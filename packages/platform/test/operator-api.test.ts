import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { operatorControlPlane } from '../src/application/organisations/control-plane.js';
import type { OrganisationOperations } from '../src/application/organisations/control-plane.js';
import { verifiedOperatorPrincipal, type OperatorPrincipal } from '../src/application/organisations/operator-principal.js';

const principal = (actions: string[] = ['suspend', 'retry', 'onboard', 'sign_in']) =>
  verifiedOperatorPrincipal({
    operatorId: '10000000-0000-4000-8000-000000000001',
    issuer: 'https://identity.example.test/',
    subject: 'provider-user-7',
    display: 'Operations User',
    authTime: '2026-10-30T12:00:00.000Z',
    amr: ['pwd', 'mfa'],
    acr: 'urn:example:mfa',
    assurance: 'mfa',
    sessionId: '20000000-0000-4000-8000-000000000002',
    actions,
  });
const STEP_UP = '30000000-0000-4000-8000-000000000003';

describe('operator public API', () => {
  it('passes structured verified evidence and the granted action to lifecycle services', async () => {
    const suspend = vi.fn().mockResolvedValue({ organisation: null, onboarding: null, history: [] });
    const operations = {
      onboarding: {},
      lifecycle: { suspend },
    } as unknown as OrganisationOperations;
    const control = operatorControlPlane(operations);

    await control.suspend(principal(), 'ngo-one', 'payment overdue', STEP_UP);

    expect(suspend).toHaveBeenCalledWith(
      expect.objectContaining({
        display: 'Operations User',
        operatorId: '10000000-0000-4000-8000-000000000001',
        issuer: 'https://identity.example.test/',
        subject: 'provider-user-7',
        permission: 'suspend',
        authTime: '2026-10-30T12:00:00.000Z',
        assurance: 'mfa',
        amr: ['pwd', 'mfa'],
        acr: 'urn:example:mfa',
        sessionId: '20000000-0000-4000-8000-000000000002',
        stepUpId: '30000000-0000-4000-8000-000000000003',
      }),
      'ngo-one',
      'payment overdue',
    );
  });

  it('refuses an action the operator is not granted, before calling any service', async () => {
    const suspend = vi.fn();
    const retry = vi.fn();
    const onboard = vi.fn();
    const savePolicy = vi.fn();
    const control = operatorControlPlane({ onboarding: { retry, onboard }, lifecycle: { suspend }, signIn: { savePolicy } } as unknown as OrganisationOperations);
    const none = principal(['status']);
    await expect(control.suspend(none, 'ngo-one', 'overdue', STEP_UP)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(control.retry(none, 'request-1')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(control.onboard(none, {})).rejects.toMatchObject({ code: 'forbidden' });
    const policy = { passwordEnabled: true, emailCodeEnabled: true, minimumAssurance: 'aal1' } as const;
    await expect(control.signIn.savePolicy(none, 'ngo-one', policy, 'why', STEP_UP)).rejects.toMatchObject({ code: 'forbidden' });
    expect([suspend, retry, onboard, savePolicy].every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it('refuses a step-up action without a step-up, and runs it with one', async () => {
    const savePolicy = vi.fn().mockResolvedValue({});
    const suspend = vi.fn().mockResolvedValue({});
    const control = operatorControlPlane({ onboarding: {}, lifecycle: { suspend }, signIn: { savePolicy } } as unknown as OrganisationOperations);
    const policy = { passwordEnabled: true, emailCodeEnabled: true, minimumAssurance: 'aal1' } as const;
    await expect(control.suspend(principal(), 'ngo-one', 'overdue')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(control.signIn.savePolicy(principal(), 'ngo-one', policy, 'why', '')).rejects.toMatchObject({ code: 'forbidden' });
    expect(suspend).not.toHaveBeenCalled();
    await control.signIn.savePolicy(principal(), 'ngo-one', policy, 'why', STEP_UP);
    expect(savePolicy).toHaveBeenCalledWith(expect.objectContaining({ permission: 'sign_in', stepUpId: STEP_UP }), 'ngo-one', policy, 'why');
  });

  it('accepts the operators and audit grants, and refuses an unknown one', () => {
    expect(principal(['operators', 'audit']).actions).toEqual(['operators', 'audit']);
    expect(() => principal(['everything'])).toThrow(/actions/i);
  });

  it('rejects malformed evidence and an unbranded principal', async () => {
    expect(() => verifiedOperatorPrincipal({ ...principal(), operatorId: 'operator-name' })).toThrow(/account id/i);
    const operations = {
      onboarding: { retry: vi.fn() },
      lifecycle: {},
    } as unknown as OrganisationOperations;
    const control = operatorControlPlane(operations);
    await expect(
      control.retry(
        {
          operatorId: '10000000-0000-4000-8000-000000000001',
          issuer: 'issuer',
          subject: 'subject',
          display: 'display',
          authTime: '2026-10-30T12:00:00.000Z',
          amr: ['mfa'],
          assurance: 'mfa',
          sessionId: '20000000-0000-4000-8000-000000000002',
        } as unknown as OperatorPrincipal,
        'request-1',
      ),
    ).rejects.toThrow(/verified operator principal/i);
  });

  it('keeps the serving API and entry point free of operator imports', () => {
    const root = join(import.meta.dirname, '..');
    for (const file of ['src/api/main.ts', 'src/platform.ts']) {
      expect(readFileSync(join(root, file), 'utf8'), file).not.toMatch(/api\/operator|control-plane|composition\/organisations|operator-principal/);
    }
    for (const file of ['src/main.ts', 'src/http/server.ts']) {
      expect(readFileSync(join(root, '..', '..', 'apps/onengo/server', file), 'utf8'), file).not.toMatch(/api\/operator|control-plane|composition\/organisations|operator-principal/);
    }
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(Object.keys(pkg.exports)).toEqual(['./main', './operator', './contracts', './browser', './deployment', './testing', './icons']);
  });
});
