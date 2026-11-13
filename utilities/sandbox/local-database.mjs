/**
 * Local compatibility for a .env that only sets DATABASE_URL.
 * The serving processes need separate logins. When those are absent, the dev
 * scripts copy the administrative URL for the owner and system connections and
 * provision a least-privilege runtime login, the same way the old setup did.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const roleName = /^[a-z_][a-z0-9_]{0,62}$/;

export function fillAdministrativeUrls() {
  const admin = process.env.DATABASE_URL?.trim();
  if (!admin) throw new Error('Set DATABASE_URL in .env, e.g. DATABASE_URL=postgres://postgres@localhost:5432/ngo');
  if (!process.env.DATABASE_OWNER_URL?.trim()) process.env.DATABASE_OWNER_URL = admin;
  if (!process.env.DATABASE_SYSTEM_URL?.trim()) process.env.DATABASE_SYSTEM_URL = admin;
  return admin;
}

/** Creates or resets a local runtime login and returns its connection string. The password stays in this process. */
export async function runtimeConnectionString(adminUrl, login, role) {
  if (!roleName.test(login)) throw new Error(`Runtime login '${login}' is not a database role name.`);
  if (!roleName.test(role)) throw new Error(`Runtime role '${role}' is not a database role name.`);
  const password = randomBytes(32).toString('hex');
  const client = new pg.Client({ connectionString: adminUrl });
  try {
    await client.connect();
    await client.query(
      `do $$ begin
         if not exists (select 1 from pg_roles where rolname = '${login}') then
           create role ${login} login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
         end if;
       end $$`,
    );
    await client.query(`alter role ${login} password '${password}'`);
    await client.query(`grant ${role} to ${login}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not provision the local runtime login ${login} (${reason}). Run npm run dev:setup so the database migrations exist.`, { cause: error });
  } finally {
    await client.end().catch(() => undefined);
  }
  const url = new URL(adminUrl);
  url.username = login;
  url.password = password;
  return url.toString();
}
