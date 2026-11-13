-- 011_operator_directory: operators manage other operators, and can read the audit, from the console.
--
-- `operators` needs a fresh step-up, like suspend and sign-in. `audit` is read-only.
-- A disabled account can keep the reason the operator typed. Existing disabled rows have no reason,
-- so the column stays optional.

alter table operator_grant drop constraint operator_grant_action_check;
alter table operator_grant add constraint operator_grant_action_check
  check (action in ('onboard', 'status', 'retry', 'suspend', 'reactivate', 'close', 'sign_in', 'operators', 'audit'));

alter table operator_step_up drop constraint operator_step_up_action_check;
alter table operator_step_up add constraint operator_step_up_action_check
  check (action in ('suspend', 'reactivate', 'close', 'sign_in', 'operators'));

alter table operator_account add column disabled_reason text
  check (disabled_reason is null or length(trim(disabled_reason)) between 1 and 500);

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (11, '011_operator_directory.sql', 'additive');
