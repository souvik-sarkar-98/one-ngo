-- 009_org_sign_in: operators configure an organisation's sign-in from the console.
--
-- sign_in is a new operator grant, and changing sign-in needs a fresh step-up
-- like suspend, reactivate and close. An organisation's opt-in to the shared
-- installation provider can be limited to its own email domains.

alter table operator_grant drop constraint operator_grant_action_check;
alter table operator_grant add constraint operator_grant_action_check
  check (action in ('onboard', 'status', 'retry', 'suspend', 'reactivate', 'close', 'sign_in'));

alter table operator_step_up drop constraint operator_step_up_action_check;
alter table operator_step_up add constraint operator_step_up_action_check
  check (action in ('suspend', 'reactivate', 'close', 'sign_in'));

-- Empty means the provider's own domain list alone decides.
alter table tenant_auth_provider add column allowed_domains text[] not null default '{}'
  check (cardinality(allowed_domains) <= 50);

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (9, '009_org_sign_in.sql', 'additive');
