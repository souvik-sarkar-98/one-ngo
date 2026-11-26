-- 012_overdraft_default_off: a new bank account no longer may go below zero unless the person who opens
-- it says so (see docs/plans/finance-system-plan.md). Bank accounts opened by a module used to start
-- with the overdraft allowed, so a payment could take the account negative without anyone noticing.
--
-- Only an active bank account that holds zero or more is changed, so no existing account is made to
-- break its own rule. An account that is already below zero keeps the setting until it is topped up.
-- Safe to run twice: the second run finds nothing left to change. Old servers never read anything new.

update money_account m
   set allow_negative = false
 where m.kind = 'bank'
   and m.status = 'active'
   and m.allow_negative
   and coalesce(
         (select sum(l.debit - l.credit) from journal_line l where l.account_id = m.ledger_account_id),
         0
       ) >= 0;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (12, '012_overdraft_default_off.sql', 'additive');
