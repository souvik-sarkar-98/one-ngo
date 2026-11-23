-- 007_bank_reconciliation: the bank's own record of an account, and the sign-off
-- that the books agree with it.
--
-- A statement line is what the bank says happened (money in is positive, money
-- out negative). It is matched to the ledger line for the same event, ignored,
-- or booked (which posts the missing entry and matches it). A sign-off records,
-- for a money account and a date, that the statement balance and the books agree.
-- Sign-offs are never changed or deleted.

create table bank_statement_line (
  id uuid primary key default gen_random_uuid(),
  -- Keeps lines of one day in the order the statement gave them.
  seq bigint generated always as identity,
  tenant_id uuid not null references tenant(id),
  money_account_id uuid not null references money_account(id),
  line_date date not null,
  amount numeric(14, 2) not null check (amount <> 0),
  description text not null,
  reference text,
  -- Identifies the line so importing the same statement twice adds nothing.
  fingerprint text not null,
  status text not null default 'unmatched' check (status in ('unmatched', 'matched', 'ignored')),
  journal_line_id uuid references journal_line(id),
  note text,
  imported_by text,
  imported_at timestamptz not null default now(),
  resolved_by text,
  resolved_at timestamptz,
  unique (tenant_id, money_account_id, fingerprint),
  check ((status = 'matched') = (journal_line_id is not null))
);
-- A ledger line is the other half of at most one statement line.
create unique index bank_statement_line_one_book_line on bank_statement_line (journal_line_id) where journal_line_id is not null;
create index bank_statement_line_account on bank_statement_line (money_account_id, line_date);

create table bank_reconciliation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  money_account_id uuid not null references money_account(id),
  as_of date not null,
  statement_balance numeric(14, 2) not null,
  book_balance numeric(14, 2) not null,
  -- Ledger lines the bank has not shown yet (for example a cheque not cleared), debits less credits.
  outstanding_book numeric(14, 2) not null,
  note text,
  signed_off_by text not null,
  signed_off_at timestamptz not null default now(),
  unique (tenant_id, money_account_id, as_of)
);

create function bank_reconciliation_is_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'a signed-off reconciliation cannot be changed' using errcode = 'P0001';
end
$$;
create trigger bank_reconciliation_immutable before update or delete on bank_reconciliation
  for each row execute function bank_reconciliation_is_immutable();

do $$
declare
  t text;
begin
  foreach t in array array['bank_statement_line', 'bank_reconciliation'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = (select app_tenant())) with check (tenant_id = (select app_tenant()))', t);
  end loop;
end
$$;

grant select, insert, update on bank_statement_line to app_runtime;
grant select, insert on bank_reconciliation to app_runtime;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (7, '007_bank_reconciliation.sql', 'additive');
