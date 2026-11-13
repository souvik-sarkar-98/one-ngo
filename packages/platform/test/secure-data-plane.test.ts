import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database, SqlExecutor } from '../src/infrastructure/postgres/db.js';
import { prepareDeployment } from '../src/prepare-deployment.js';
import { openTestDatabase } from './helpers.js';

let db: Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await openTestDatabase());
  await prepareDeployment(db, { shippedModules: [] });
}, 30_000);

afterAll(async () => dispose());

function asRole<T>(role: 'app_runtime' | 'ngo_main_runtime' | 'ngo_main_system' | 'ngo_operator' | 'ngo_operator_runtime', fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return db.asSystem(async (tx) => {
    await tx.query(`set local role ${role}`);
    return fn(tx);
  });
}

describe('service role boundaries', () => {
  it('provisions only non-login roles that cannot bypass row security', async () => {
    const roles = await db.asSystem((tx) =>
      tx.query<{ rolname: string; canLogin: boolean; superuser: boolean; bypassRls: boolean; createRole: boolean }>(
        `select rolname, rolcanlogin as "canLogin", rolsuper as superuser, rolbypassrls as "bypassRls", rolcreaterole as "createRole"
           from pg_roles
          where rolname in ('app_runtime', 'ngo_main_runtime', 'ngo_main_system', 'ngo_operator', 'ngo_operator_runtime')
          order by rolname`,
      ),
    );
    expect(roles).toHaveLength(5);
    expect(roles.every((role) => !role.canLogin && !role.superuser && !role.bypassRls && !role.createRole)).toBe(true);
  });

  it('denies DDL to every serving role', async () => {
    for (const role of ['ngo_main_runtime', 'ngo_main_system', 'ngo_operator', 'ngo_operator_runtime'] as const) {
      await expect(asRole(role, (tx) => tx.query(`create table forbidden_${role} (id integer)`))).rejects.toThrow(/permission denied/);
    }
  });

  it('lets the system role manage bind keys only through the reviewed functions', async () => {
    const hash = 'a'.repeat(64);
    await asRole('ngo_main_system', (tx) => tx.query('select app_register_tenant_bind_key($1)', [hash]));
    await expect(asRole('ngo_main_system', (tx) => tx.query('select key_hash from tenant_bind_key'))).rejects.toThrow(/permission denied/);
    await asRole('ngo_main_system', (tx) => tx.query('select app_unregister_tenant_bind_key($1)', [hash]));
    await expect(asRole('ngo_main_system', (tx) => tx.query('select app_register_tenant_bind_key($1)', [null]))).rejects.toThrow(/invalid tenant bind key hash/);
  });

  it('keeps tenant service roles away from system functions and control-plane tables', async () => {
    await expect(asRole('ngo_main_runtime', (tx) => tx.query('select app_register_tenant_bind_key($1)', ['b'.repeat(64)]))).rejects.toThrow(/permission denied/);
    await expect(asRole('app_runtime', (tx) => tx.query('select * from organisation_onboarding'))).rejects.toThrow(/permission denied/);
    await expect(asRole('app_runtime', (tx) => tx.query('select app_tenant()'))).resolves.toEqual([{ app_tenant: null }]);
  });
});

describe('operator audit boundary', () => {
  it('allows structured append-only evidence without exposing it to tenant roles', async () => {
    const [operator] = await asRole('ngo_operator', (tx) =>
      tx.query<{ id: string }>(`insert into operator_account (display_name) values ('Release operator') returning id`),
    );
    const [audit] = await asRole('ngo_operator', (tx) =>
      tx.query<{ id: string }>(
        `insert into platform_audit
           (operator, operator_account_id, issuer, subject, display_snapshot, permission, action)
         values ('legacy-compatible', $1, 'https://issuer.test', 'operator-1', 'Release operator', 'status', 'organisation.status')
         returning id::text`,
        [operator!.id],
      ),
    );
    await expect(asRole('ngo_operator', (tx) => tx.query(`update platform_audit set action = 'changed' where id = $1`, [audit!.id]))).rejects.toThrow(
      /permission denied/,
    );
    await expect(asRole('app_runtime', (tx) => tx.query('select operator_account_id from platform_audit'))).rejects.toThrow(/permission denied/);
  });

  it('requires complete disable and revoke attribution', async () => {
    const [first] = await asRole('ngo_operator', (tx) =>
      tx.query<{ id: string }>(`insert into operator_account (display_name) values ('First operator') returning id`),
    );
    const [second] = await asRole('ngo_operator', (tx) =>
      tx.query<{ id: string }>(`insert into operator_account (display_name, created_by) values ('Second operator', $1) returning id`, [first!.id]),
    );
    await expect(
      asRole('ngo_operator', (tx) => tx.query(`update operator_account set status = 'disabled', disabled_at = now() where id = $1`, [second!.id])),
    ).rejects.toThrow(/check constraint/);
    await asRole('ngo_operator', (tx) =>
      tx.query(`update operator_account set status = 'disabled', disabled_at = now(), disabled_by = $2 where id = $1`, [second!.id, first!.id]),
    );
    await asRole('ngo_operator', (tx) => tx.query(`insert into operator_grant (operator_id, action, granted_by) values ($1, 'status', $2)`, [second!.id, first!.id]));
    await expect(asRole('ngo_operator', (tx) => tx.query(`update operator_grant set revoked_at = now() where operator_id = $1`, [second!.id]))).rejects.toThrow(
      /check constraint/,
    );
    await asRole('ngo_operator', (tx) =>
      tx.query(`update operator_grant set revoked_at = now(), revoked_by = $2 where operator_id = $1`, [second!.id, first!.id]),
    );
  });
});
