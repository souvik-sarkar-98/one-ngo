/*
 * =============================================================================
 *  CREATE THE SERVING LOGINS (production, once per database)
 * =============================================================================
 *
 *  File     : utilities/access/create-serving-logins.sql
 *  Follows  : docs/documents.html#deployment, section 6 (One-time setup, Database)
 *             (the statements the bundle test in
 *              tests/integration/onengo-server/artifact.test.ts also uses)
 *
 *  What this script does
 *    Creates the four login roles that the deployed servers connect with, and
 *    makes each one a member of its group role:
 *
 *      Login                          Group role           GitHub secret (prod)       Read by the server as
 *      -----------------------------  -------------------  -------------------------  ---------------------------
 *      ngo_main_system_login          ngo_main_system      SYSTEM_DATABASE_URL        DATABASE_SYSTEM_URL
 *      ngo_main_runtime_login         ngo_main_runtime     RUNTIME_DATABASE_URL       DATABASE_RUNTIME_URL
 *      ngo_operator_login             ngo_operator         CONSOLE_DATABASE_URL       OPERATOR_DATABASE_URL
 *      ngo_operator_runtime_login     ngo_operator_runtime CONSOLE_RUNTIME_URL        OPERATOR_RUNTIME_URL
 *
 *    The GitHub secret names are mapped to the server names by
 *    .github/workflows/deploy-gcp.yml. Use the GitHub secret names when you
 *    store the connection strings.
 *
 *  What this script does NOT do
 *    - It creates no tables, data, policies, functions or grants. Migrations
 *      001 to 007 own all of those, and `npm run deploy:prepare` runs them.
 *    - It inserts no sample data and no operator account. The first console
 *      operator is a separate step: utilities/access/create-first-operator.sql
 *      (docs/developer.html#first-operator).
 *    - It never writes a password to this file, to the shell history or to the
 *      server log. Passwords are typed at \password prompts.
 *
 *  Rules
 *    - If ANY of the four logins already exists, the script changes nothing and
 *      stops (\quit). Re-running it is safe.
 *    - If a group role is missing, the script stops with a message, because the
 *      migrations have not run yet.
 *    - One transaction. If any step fails, nothing is left behind.
 *
 *  Requirements
 *    - psql 10 or newer (for \if and \password).
 *    - Connect as the OWNER login (DATABASE_OWNER_URL), the one that ran the
 *      migrations. It needs CREATEROLE. Never run this as a serving login.
 *    - A terminal, because \password prompts for input.
 *
 *  How to run (after `npm run deploy:prepare` has run once with the owner URL)
 *    psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 -f utilities/access/create-serving-logins.sql
 *
 *    Use a long random password for each login (32 characters or more), for
 *    example from a password manager. Then put each login's connection string
 *    into the matching secret in GitHub (the deployment plan, section 10, step 4).
 *
 *  Afterwards
 *    The owner URL stays with the deploy job only. The serving logins never own
 *    schema objects, never have BYPASSRLS, and never migrate.
 * =============================================================================
 */

-- =============================================================================
-- GUARD: if any serving login already exists, change nothing and stop.
-- =============================================================================
SELECT
  EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('ngo_main_system_login', 'ngo_main_runtime_login',
                      'ngo_operator_login', 'ngo_operator_runtime_login')
  ) AS logins_exist,
  coalesce((
    SELECT string_agg(rolname, ', ' ORDER BY rolname)
    FROM pg_roles
    WHERE rolname IN ('ngo_main_system_login', 'ngo_main_runtime_login',
                      'ngo_operator_login', 'ngo_operator_runtime_login')
  ), '') AS existing_logins
\gset

\if :logins_exist
  \echo 'Serving logins already exist, so nothing was changed. Existing:' :existing_logins
  \quit
\endif

\echo 'No serving logins found. Creating the four logins.'

BEGIN;

-- =============================================================================
-- STEP 1: THE GROUP ROLES MUST EXIST
-- =============================================================================
-- Migration 001_core creates these roles. If one is missing, the migrations
-- have not been run against this database yet.

DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(r.role_name, ', ') INTO v_missing
  FROM (VALUES
    ('app_runtime'), ('ngo_main_system'), ('ngo_main_runtime'),
    ('ngo_operator'), ('ngo_operator_runtime')
  ) AS r (role_name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles p WHERE p.rolname = r.role_name);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'group roles missing: %. Run npm run deploy:prepare with the owner URL first. Nothing was changed.',
      v_missing;
  END IF;
END
$$;


-- =============================================================================
-- STEP 2: CREATE THE LOGINS (no password yet) AND GRANT THEIR GROUPS
-- =============================================================================
-- NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE and NOCREATEDB are the defaults. They
-- are written out here so the intent is visible. The start-up check refuses a
-- runtime login that is a superuser, bypasses row security, or owns the schema.
--
-- A login with no password cannot sign in, so creating it before its password
-- is set is safe. The passwords are set in Step 3, in the same transaction.

CREATE ROLE ngo_main_system_login
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT ngo_main_system TO ngo_main_system_login;

CREATE ROLE ngo_main_runtime_login
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT ngo_main_runtime TO ngo_main_runtime_login;

CREATE ROLE ngo_operator_login
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT ngo_operator TO ngo_operator_login;

CREATE ROLE ngo_operator_runtime_login
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT ngo_operator_runtime TO ngo_operator_runtime_login;


-- =============================================================================
-- STEP 3: SET THE PASSWORDS (hidden prompts)
-- =============================================================================
-- \password asks for the password twice, hides what you type, and hashes it on
-- the client before sending it. The plain text never reaches the server, the
-- shell history, this file, or the server log.

\echo 'Set the password for ngo_main_system_login (typed twice, hidden):'
\password ngo_main_system_login

\echo 'Set the password for ngo_main_runtime_login (typed twice, hidden):'
\password ngo_main_runtime_login

\echo 'Set the password for ngo_operator_login (typed twice, hidden):'
\password ngo_operator_login

\echo 'Set the password for ngo_operator_runtime_login (typed twice, hidden):'
\password ngo_operator_runtime_login


-- =============================================================================
-- STEP 4: VERIFY BEFORE COMMIT
-- =============================================================================
-- A failed assertion rolls back the whole transaction, so the logins are never
-- left half set up.

DO $$
DECLARE
  v_login text;
BEGIN
  -- No serving login may be a superuser, bypass RLS, or create roles or databases.
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('ngo_main_system_login', 'ngo_main_runtime_login',
                      'ngo_operator_login', 'ngo_operator_runtime_login')
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)
  ), 'a serving login has superuser, BYPASSRLS, CREATEROLE or CREATEDB';

  -- No serving login may own any table in the schema the migrations use.
  FOREACH v_login IN ARRAY ARRAY[
    'ngo_main_system_login', 'ngo_main_runtime_login',
    'ngo_operator_login', 'ngo_operator_runtime_login'
  ] LOOP
    ASSERT NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_roles r ON r.oid = c.relowner
      WHERE r.rolname = v_login
        AND c.relnamespace = current_schema()::regnamespace
    ), format('%s owns a table in %s', v_login, current_schema());
  END LOOP;

  -- Tenant runtime logins must reach app_runtime, which row-level security checks.
  ASSERT pg_has_role('ngo_main_runtime_login', 'app_runtime', 'MEMBER'),
    'ngo_main_runtime_login must reach app_runtime';
  ASSERT pg_has_role('ngo_operator_runtime_login', 'app_runtime', 'MEMBER'),
    'ngo_operator_runtime_login must reach app_runtime';

  -- Control-plane logins must not reach app_runtime (migration 001 says so).
  ASSERT NOT pg_has_role('ngo_main_system_login', 'app_runtime', 'MEMBER'),
    'ngo_main_system_login must not reach app_runtime';
  ASSERT NOT pg_has_role('ngo_operator_login', 'app_runtime', 'MEMBER'),
    'ngo_operator_login must not reach app_runtime';
END
$$;

COMMIT;

\echo 'Serving logins created and verified.'
\echo 'Next: build the four connection strings with these logins and store them as the'
\echo 'deployment secrets (deployment plan, section 10, step 4). The owner URL stays with'
\echo 'the deploy job only.'


-- =============================================================================
-- CHECK THE RESULT (read-only, run any time)
-- =============================================================================
--   SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
--   FROM pg_roles
--   WHERE rolname LIKE 'ngo\_%' ESCAPE '\'
--   ORDER BY rolname;
--
--   SELECT m.rolname AS login, g.rolname AS member_of
--   FROM pg_auth_members am
--   JOIN pg_roles m ON m.oid = am.member
--   JOIN pg_roles g ON g.oid = am.roleid
--   WHERE m.rolname LIKE 'ngo\_%login' ESCAPE '\'
--   ORDER BY login, member_of;
