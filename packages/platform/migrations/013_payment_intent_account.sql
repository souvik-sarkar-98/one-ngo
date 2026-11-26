-- 013_payment_intent_account: a payment request remembers which money account the person chose to be paid
-- into (see docs/plans/finance-system-plan.md). When the payment arrives, the record's "received in" field
-- is filled from that account, so the money is booked to the right bank.
--
-- The column is nullable and unused by older servers, so rolling back needs no data change. Requests made
-- before this migration keep a null account and are booked as they were. Safe to run twice.

alter table payment_intent add column if not exists account_key text;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (13, '013_payment_intent_account.sql', 'additive');
