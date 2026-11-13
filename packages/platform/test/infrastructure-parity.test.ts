import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fiscalYearKey } from '../src/domain/ledger/fiscal-year.js';
import { fiscalYearExpr } from '../src/infrastructure/postgres/query-compiler/record-query.js';
import { likePattern as approvalLikePattern } from '../src/infrastructure/postgres/stores/approval-store.js';
import { likePattern } from '../src/runtime/definitions/list-params.js';
import { createWorld, type TestWorld } from './helpers.js';
import { PlatformError, conflict as coreConflict, validationFailed as coreValidationFailed } from '@onengo/kernel/errors';
import {
  InfrastructureError,
  infrastructureConflict as conflict,
  infrastructureValidationFailed as validationFailed,
} from '@onengo/kernel/errors';
import { atPortBoundary, platformErrorOf } from '../src/composition/infrastructure-errors.js';
import { existsSync } from 'node:fs';
import { SYSTEM_ACTOR_PREFIX as domainPrefix, systemActor as domainSystemActor } from '../src/domain/system-actor.js';
import { SYSTEM_ACTOR_PREFIX as infrastructurePrefix } from '../src/infrastructure/postgres/db.js';

/**
 * Infrastructure keeps its own copy of the few core values it cannot receive through composition, because it may not import core code at runtime; these tests keep the copies identical.
 * Everything else has one owner: the index expressions and the setting keys are written once, the financial-year rules are the domain's and reach the stores from composition.
 */
describe('infrastructure copies of core values', () => {
  it('names platform-run actors the same way as the domain, which every runtime and application module imports', () => {
    expect(infrastructurePrefix).toBe(domainPrefix);
    expect(domainSystemActor('jobs')).toEqual({ id: `${infrastructurePrefix}jobs`, roles: ['system'], permissions: ['*'] });
    for (const file of ['src/runtime/records/ports/tenant-context.ts', 'src/runtime/definitions/ports/tenant-context.ts', 'src/runtime/definitions/ports/logger.ts']) {
      expect(existsSync(new URL(`../${file}`, import.meta.url)), `${file} is a retired shim`).toBe(false);
    }
  });

  it('keeps infrastructure errors out of the core: composition maps them to platform errors at the port boundary', async () => {
    const raised = validationFailed('Bad.', [{ path: '/a', message: 'no' }]);
    expect(raised).toBeInstanceOf(InfrastructureError);
    expect(raised).not.toBeInstanceOf(PlatformError);
    const mapped = platformErrorOf(raised);
    expect(mapped).toBeInstanceOf(PlatformError);
    expect({ name: mapped.name, code: mapped.code, message: mapped.message, issues: mapped.issues }).toEqual({
      name: 'PlatformError',
      code: 'validation_failed',
      message: 'Bad.',
      issues: [{ path: '/a', message: 'no' }],
    });
    expect(conflict('Busy.').code).toBe(coreConflict('Busy.').code);
    expect(coreValidationFailed('Bad.')).toBeInstanceOf(PlatformError);
    expect({} instanceof PlatformError).toBe(false);

    const port = atPortBoundary({
      sync(): never { throw conflict('Busy.'); },
      async later(): Promise<never> { throw conflict('Busy.'); },
      other(): never { throw new Error('plain'); },
      value: 7,
    });
    expect(() => port.sync()).toThrow(PlatformError);
    await expect(port.later()).rejects.toBeInstanceOf(PlatformError);
    expect(() => port.other()).toThrow('plain');
    expect(port.value).toBe(7);
  });
});

describe('infrastructure duplicates that must stay, and the proof they agree', () => {
  let w: TestWorld;
  beforeAll(async () => {
    w = await createWorld({ autoRunJobs: false });
  });
  afterAll(() => w.close());

  it('groups by the financial-year label fiscalYearKey gives, for every start month and day', async () => {
    for (let month = 1; month <= 12; month++) {
      const rows = await w.platform.db.asSystem((tx) =>
        tx.query<{ d: string; k: string }>(
          `select to_char(d, 'YYYY-MM-DD') as d, ${fiscalYearExpr('d::date', month)} as k from generate_series('2025-01-01'::date, '2028-12-31'::date, '1 day') d`,
        ),
      );
      expect(rows.length).toBe(1461);
      expect(rows.filter((r) => r.k !== fiscalYearKey(r.d, month)).slice(0, 3), `start month ${month}`).toEqual([]);
    }
  });

  it('escapes search text like the runtime does, apart from case, which the approval search leaves to ilike', () => {
    for (const text of ['plain', 'a_b', '50%', 'back\\slash', 'MiXed 100%_\\']) {
      expect(approvalLikePattern(text).toLowerCase()).toBe(likePattern(text));
    }
  });
});