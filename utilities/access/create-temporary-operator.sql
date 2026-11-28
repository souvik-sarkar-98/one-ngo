/*
 * =============================================================================
 *  CREATE A TEMPORARY OPERATOR (production; the first user, or any later one)
 * =============================================================================
 *
 *  File     : utilities/access/create-temporary-operator.sql
 *  Follows  : docs/developer.html#first-operator
 *  Needs    : the operator tables from 006_operator.sql (they include the
 *             temporary and first_signed_in_at columns) and a console build
 *             that checks them
 *
 *  What a temporary operator is
 *    An operator account that may sign in ONCE. The console records the time
 *    of that first sign-in. Any later sign-in is refused, even with the same
 *    identity provider login. The session from that first sign-in lasts up to
 *    8 hours and cannot be extended. The row stays in the database, with the
 *    time of the first sign-in in first_signed_in_at.
 *
 *    A temporary account is not a password, and it does not bypass anything:
 *    the person still signs in at the identity provider with two-factor
 *    authentication, and must match the issuer and subject below exactly.
 *
 *  What this script does (one transaction)
 *    1. Stops if the identity is already linked to an operator.
 *    2. Creates one active account with temporary = true.
 *    3. Links it to the identity (issuer + subject).
 *    4. Grants all nine console actions, including "operators", so the person
 *       can use the whole console during their one sign-in.
 *    5. Writes one platform_audit row, "operator.temporary_created".
 *    It creates no password.
 *
 *  Get the two identity values from the console (do not type them)
 *    The person opens the console, chooses Continue, and signs in at the
 *    identity provider. The console refuses the login ("not an operator") and
 *    shows Provider and Subject. Those are the values to copy.
 *
 *  How to run (a terminal on a machine that may reach the database)
 *    psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 \
 *      -v issuer='<Provider shown on the sign-in page>' \
 *      -v subject='<Subject shown on the sign-in page>' \
 *      -v name='<Full name of the operator>' \
 *      -f utilities/access/create-temporary-operator.sql
 *
 *    Connect as the OWNER login (DATABASE_OWNER_URL). Never use a serving
 *    login. The owner URL is a secret: take it from where you keep it, and do
 *    not paste it into a ticket, a chat, or a file.
 *
 *  Rules
 *    - Re-running with the same identity changes nothing (it stops).
 *    - Nothing is changed if a value is missing or unusable.
 *    - Neither this script nor the console changes the temporary flag. To give
 *      the person permanent access, create a normal operator on Operators.
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
-- GUARD 3: the identity must not already be an operator.
-- =============================================================================
SELECT EXISTS (
  SELECT 1 FROM operator_identity
   WHERE issuer = :'issuer' AND subject = trim(:'subject')
) AS identity_exists
\gset

\if :identity_exists
  \echo 'That login is already an operator, so nothing was changed.'
  \echo 'Check Operators in the console. A temporary account cannot be re-created for the same login.'
  \quit
\endif

-- =============================================================================
-- CREATE THE TEMPORARY OPERATOR
-- =============================================================================
BEGIN;

INSERT INTO operator_account (display_name, temporary)
VALUES (trim(:'name'), true)
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
VALUES (trim(:'name'), 'operator.temporary_created', :'issuer', trim(:'subject'), trim(:'name'),
        :'operator_id',
        jsonb_build_object('how', 'utilities/access/create-temporary-operator.sql',
                           'one_sign_in', true,
                           'database_user', current_user));

-- Check the rows just written. If one is wrong, roll everything back.
SELECT (
  EXISTS (SELECT 1 FROM operator_account
           WHERE id = :'operator_id' AND temporary AND first_signed_in_at IS NULL)
  AND (SELECT count(*) FROM operator_grant
        WHERE operator_id = :'operator_id' AND revoked_at IS NULL) = 9
) AS rows_ok
\gset

\if :rows_ok
  COMMIT;
\else
  ROLLBACK;
  \echo 'Nothing was kept: the rows written did not match the expected shape.'
  \quit
\endif

\echo 'The temporary operator was created:' :operator_id
\echo 'The person signs in once on the console. Any later sign-in is refused.'


-- =============================================================================
-- CHECK THE RESULT (read-only, run any time)
-- =============================================================================
--   SELECT a.display_name, a.temporary, a.first_signed_in_at, i.issuer, i.subject
--   FROM operator_account a
--   JOIN operator_identity i ON i.operator_id = a.id
--   WHERE a.temporary
--   ORDER BY a.created_at DESC;
