-- Local development only. A database administrator inserts the first production operator.
-- utilities/sandbox/dev-setup.mjs replaces __ISSUER__ and __SUBJECT__ before running this.
-- An identity that is already stored is left in place. A missing action is granted.
-- A revoked action is restored so the local operator keeps the full console.
do $seed$
declare
  v_id uuid;
  v_action text;
begin
  select operator_id into v_id from operator_identity
   where issuer = '__ISSUER__' and subject = '__SUBJECT__';
  if v_id is null then
    insert into operator_account (display_name)
    values ('Local operator')
    returning id into v_id;
    insert into operator_identity (operator_id, issuer, subject, linked_by)
    values (v_id, '__ISSUER__', '__SUBJECT__', v_id);
  end if;
  foreach v_action in array array['onboard', 'status', 'retry', 'suspend', 'reactivate', 'close', 'sign_in', 'operators', 'audit']
  loop
    insert into operator_grant (operator_id, action, granted_by)
    values (v_id, v_action, v_id)
    on conflict (operator_id, action) do update
      set granted_at = now(), granted_by = excluded.granted_by, revoked_at = null, revoked_by = null
      where operator_grant.revoked_at is not null;
  end loop;
end
$seed$;
