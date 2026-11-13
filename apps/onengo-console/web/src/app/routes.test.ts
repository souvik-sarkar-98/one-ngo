import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { Router, type ActivatedRouteSnapshot, type CanActivateFn, type RouterStateSnapshot } from '@angular/router';
import { OPERATOR_ACTIONS, type OperatorActionContract } from '@onengo/platform/contracts';
import { describe, expect, it } from 'vitest';
import { OperatorApi } from './services/operator-api';
import { routes } from './routes';

const ACTION_BY_PATH: Record<string, OperatorActionContract> = {
  organisations: 'status',
  'organisations/find': 'status',
  'organisations/status': 'status',
  'organisations/onboard': 'onboard',
  'organisations/sign-in': 'sign_in',
  operators: 'operators',
  'operators/:id': 'operators',
  activity: 'audit',
};

async function enter(path: string, actions: readonly OperatorActionContract[], authenticated = true): Promise<unknown> {
  const api = new OperatorApi();
  api.session.set({ authenticated, actions: [...actions] });
  const router = { createUrlTree: (commands: unknown[], extras?: unknown) => ({ commands, extras }) };
  const guard = routes.find((route) => route.path === path)?.canActivate?.[0] as CanActivateFn;
  const injector = Injector.create({
    providers: [
      { provide: OperatorApi, useValue: api },
      { provide: Router, useValue: router },
    ],
  });
  return runInInjectionContext(injector, () => guard({} as ActivatedRouteSnapshot, { url: `/${path}` } as RouterStateSnapshot));
}

describe('operator web routes', () => {
  it('contains lookup, onboarding, sign-in, operators, activity, and authentication screens', () => {
    const paths = routes.map((route) => route.path);
    expect(paths).toContain('organisations');
    expect(paths).toContain('organisations/find');
    expect(paths).toContain('organisations/onboard');
    expect(paths).toContain('organisations/status');
    expect(paths).toContain('organisations/sign-in');
    expect(paths).toContain('operators');
    expect(paths).toContain('operators/:id');
    expect(paths).toContain('activity');
    expect(paths).not.toContain('organisations/list');
    expect(paths.some((path) => path?.includes('grant') || path?.includes('bulk'))).toBe(false);
  });

  it('allows a signed-in operator who holds the route action and refuses one who does not', async () => {
    const guarded = routes.filter((route) => route.canActivate?.length).map((route) => route.path);
    expect(guarded.sort()).toEqual(Object.keys(ACTION_BY_PATH).sort());
    for (const [path, action] of Object.entries(ACTION_BY_PATH)) {
      await expect(enter(path, [action])).resolves.toBe(true);
      await expect(enter(path, OPERATOR_ACTIONS.filter((item) => item !== action))).resolves.toBe(false);
    }
  });

  it('sends a signed-out visitor to sign-in', async () => {
    await expect(enter('organisations', ['status'], false)).resolves.toEqual({
      commands: ['/sign-in'],
      extras: { queryParams: { next: '/organisations' } },
    });
  });
});
