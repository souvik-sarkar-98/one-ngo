import { describe, expect, it } from 'vitest';
import { localWithoutIap } from '../src/operators/provider.js';

const local = { OPERATOR_LOCAL_WITHOUT_IAP: '1', OPERATOR_PUBLIC_BASE_URL: 'http://localhost:8081' };

describe('running the operator console without IAP', () => {
  it('stays off unless asked for', () => {
    expect(localWithoutIap({})).toBe(false);
    expect(localWithoutIap({ OPERATOR_LOCAL_WITHOUT_IAP: 'true', OPERATOR_PUBLIC_BASE_URL: 'http://localhost:8081' })).toBe(false);
  });

  it('is allowed on this machine', () => {
    expect(localWithoutIap(local)).toBe(true);
    expect(localWithoutIap({ ...local, OPERATOR_PUBLIC_BASE_URL: 'http://127.0.0.1:8081' })).toBe(true);
  });

  it('is refused on any cloud host', () => {
    for (const marker of ['GAE_SERVICE', 'K_SERVICE', 'GOOGLE_CLOUD_PROJECT', 'FUNCTION_TARGET']) {
      expect(() => localWithoutIap({ ...local, [marker]: 'operator' })).toThrow(/cloud host/);
    }
  });

  it('is refused when the console address is not on this machine', () => {
    expect(() => localWithoutIap({ ...local, OPERATOR_PUBLIC_BASE_URL: 'https://operator.example.org' })).toThrow(/localhost/);
    expect(() => localWithoutIap({ ...local, OPERATOR_PUBLIC_BASE_URL: 'http://localhost.example.org' })).toThrow(/localhost/);
    expect(() => localWithoutIap({ OPERATOR_LOCAL_WITHOUT_IAP: '1' })).toThrow(/localhost/);
  });
});
