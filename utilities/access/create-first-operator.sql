/*
 * =============================================================================
 *  CREATE THE FIRST OPERATOR (production, once per database)
 * =============================================================================
 *
 *  File     : utilities/access/create-first-operator.sql
 *  Follows  : docs/developer.html#first-operator
 *
 *  Why this exists
 *    Operators are added from the console, on Operators. But the console only
 *    lets in someone who is already an operator, so a new installation has
 *    nobody who can add the first one. A database administrator does that
 *    once, with this script. Everyone after that is added in the console.
 *
 *  What this script does
 *    In one transaction it:
 *      1. stops if ANY operator account already exists (it is for the first
 *         operator only, so re-running it is safe),
 *      2. creates one active operator account,
 *      3. links it to one identity (provider issuer + subject),
 *      4. grants all nine console actions, including "operators" (Manage
 *         operators), so this person can add the others,
 *      5. writes one platform_audit row, "operator.bootstrap".
 *    It creates no password. Operators have no local password: the identity
 *    provider signs them in, and it must show multi-factor authentication.
 *
 *  Get the two identity values from the console itself
 *    1. Deploy the console and let the person through Identity-Aware Proxy.
 *    2. They open the console and choose Continue, then sign in at the
 *       identity provider.
 *    3. The console refuses ("This login is not an operator on this console")
 *       and shows two values, Provider and Subject. Those are the exact
 *       values the console will look for. Copy them. Do not type them.
 *
 *  How to run (a terminal on a machine that may reach the database)
 *    psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 \
 *      -v issuer='<Provider shown on the sign-in page>' \
 *      -v subject='<Subject shown on the sign-in page>' \
 *      -v name='<Full name of the operator>' \
 *      -f utilities/access/create-first-operator.sql
 *
 *    Connect as the OWNER login (DATABASE_OWNER_URL), the one that ran the
 *    migrations. Never use a serving login. The owner URL is a secret: read it
 *    from where you keep it. Do not paste it into a ticket, a chat or a file.
 *    Requires psql 10 or newer (for \if and :{?variable}).
 *
 *  Afterwards
 *    The person signs in again on the console and sees the whole console. They
 *    add colleagues on Operators. Check the result with the queries at the end
 *    of this file.
 * =============================================================================
 */

-- =============================================================================
-- GUARD 1: all three values must be given.
-- =============================================================================
\set missing true
\if :{?issuer}
  \if :{?subject}
    \if :{?name}
      \set missing false
    \endif
  \endif
\endif

\if :missing
  \echo 'Nothing was changed. Pass -v issuer=... -v subject=... -v name=... (see the top of this file).'
  \quit
\endif

-- =============================================================================
-- GUARD 2: the values must be usable.
-- =============================================================================
SELECT (
  :'issuer' ~ '^https://[^[:space:]]+$'
  AND length(trim(:'subject')) BETWEEN 1 AND 200
  AND length(trim(:'name')) BETWEEN 1 AND 200
) AS inputs_ok
\gset

\if :inputs_ok
\else
  \echo 'Nothing was changed. The issuer must start with https://, the subject and the name must be 1 to 200 characters.'
  \echo 'Copy the issuer and subject from the console sign-in page instead of typing them.'
  \quit
\endif

-- =============================================================================
-- GUARD 3: first operator only.
-- =============================================================================
SELECT EXISTS (SELECT 1 FROM operator_account) AS operators_exist
\gset

\if :operators_exist
  \echo 'An operator account already exists, so nothing was changed.'
  \echo 'Add more operators in the console, on Operators.'
  \quit
\endif

-- =============================================================================
-- CREATE THE OPERATOR
-- =============================================================================
BEGIN;

INSERT INTO operator_account (display_name)
VALUES (trim(:'name'))
RETURNING id AS operator_id
\gset

INSERT INTO operator_identity (operator_id, issuer, subject, linked_by)
VALUES (:'operator_id', :'issuer', trim(:'subject'), :'operator_id');

INSERT INTO operator_grant (operator_id, action, granted_by)
SELECT :'operator_id', a.action, :'operator_id'
  FROM unnest(ARRAY['onboard', 'status', 'retry', 'suspend', 'reactivate', 'close',
                    'sign_in', 'operators', 'audit']) AS a (action);

INSERT INTO platform_audit (operator, action, issuer, subject, display_snapshot,
                            operator_account_id, detail)
VALUES (trim(:'name'), 'operator.bootstrap', :'issuer', trim(:'subject'), trim(:'name'),
        :'operator_id',
        jsonb_build_object('how', 'utilities/access/create-first-operator.sql',
                           'database_user', current_user));

-- A failed assertion rolls everything back.
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM operator_account) = 1, 'expected exactly one operator account';
  ASSERT (SELECT count(*) FROM operator_identity) = 1, 'expected exactly one linked identity';
  ASSERT (SELECT count(*) FROM operator_grant WHERE revoked_at IS NULL) = 9, 'expected nine active grants';
END
$$;

COMMIT;

\echo 'The first operator was created:' :operator_id
\echo 'Ask them to sign in again on the console. Then add colleagues on Operators.'


-- =============================================================================
-- CHECK THE RESULT (read-only, run any time)
-- =============================================================================
--   SELECT a.id, a.display_name, a.status, i.issuer, i.subject,
--          count(g.action) FILTER (WHERE g.revoked_at IS NULL) AS active_actions
--   FROM operator_account a
--   JOIN operator_identity i ON i.operator_id = a.id
--   LEFT JOIN operator_grant g ON g.operator_id = a.id
--   GROUP BY a.id, i.issuer, i.subject;
--
--   SELECT at, operator, action FROM platform_audit
--   WHERE action = 'operator.bootstrap' ORDER BY id DESC;
