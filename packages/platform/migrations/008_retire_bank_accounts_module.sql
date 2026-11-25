-- 008_retire_bank_accounts_module: the bank-accounts module was removed from the
-- product (see docs/plans/finance-system-plan.md). An organisation that had
-- turned it on keeps a tenant_module row, so the Modules page still lists it.
--
-- Only the switch rows that are off are removed. A module an organisation has
-- turned on is left alone, so nothing it uses is deleted here.

delete from tenant_module
 where module_key = 'bank-accounts'
   and enabled = false;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (8, '008_retire_bank_accounts_module.sql', 'additive');
