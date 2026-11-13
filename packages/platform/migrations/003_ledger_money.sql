-- 003_ledger_money: double-entry ledger, numbered receipts, money accounts,
-- transfers and payments.
--
-- Money is numeric(14, 2). Journals must balance (a deferred constraint trigger,
-- checked at commit); posted journals and issued receipts are immutable; closed
-- periods refuse postings.

-- Ledger ---------------------------------------------------------------------

create table ledger_account (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  code text not null,
  name text not null,
  type text not null check (type in ('asset', 'liability', 'equity', 'income', 'expense')),
  active boolean not null default true,
  unique (tenant_id, code)
);

create table fiscal_period (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  key text not null,
  starts_on date not null,
  ends_on date not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_at timestamptz,
  reopen_reason text,
  unique (tenant_id, key),
  check (ends_on >= starts_on)
);

create table journal_entry (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  period_id uuid not null references fiscal_period(id),
  entry_date date not null,
  memo text,
  source_record_id uuid references record(id),
  source_rule text,
  status text not null default 'posted' check (status in ('posted', 'reversed')),
  reverses_entry_id uuid references journal_entry(id),
  created_by text,
  created_at timestamptz not null default now()
);
create unique index journal_entry_one_reversal on journal_entry (reverses_entry_id) where reverses_entry_id is not null;
create unique index journal_entry_one_per_rule on journal_entry (source_record_id, source_rule) where source_rule is not null and reverses_entry_id is null;

create table journal_line (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  entry_id uuid not null references journal_entry(id),
  account_id uuid not null references ledger_account(id),
  debit numeric(14, 2) not null default 0,
  credit numeric(14, 2) not null default 0,
  fund text,
  check (debit >= 0 and credit >= 0),
  check ((debit = 0) <> (credit = 0))
);
create index journal_line_entry on journal_line (entry_id);
create index journal_line_account on journal_line (account_id);

create function journal_entry_must_balance() returns trigger language plpgsql as $$
declare
  v_entry uuid := coalesce(new.entry_id, old.entry_id);
  v_debit numeric;
  v_credit numeric;
  v_lines integer;
begin
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    into v_debit, v_credit, v_lines
    from journal_line where entry_id = v_entry;
  if v_lines < 2 or v_debit <> v_credit then
    raise exception 'journal entry % does not balance (debit %, credit %, lines %)', v_entry, v_debit, v_credit, v_lines
      using errcode = 'P0001';
  end if;
  return null;
end
$$;

create constraint trigger journal_line_balance
  after insert or update or delete on journal_line
  deferrable initially deferred
  for each row execute function journal_entry_must_balance();

create function journal_is_immutable() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'journal_line' then
    raise exception 'posted journal lines cannot be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'journal entries cannot be deleted' using errcode = 'P0001';
  end if;
  if old.status = 'posted' and new.status = 'reversed'
     and row(new.id, new.tenant_id, new.period_id, new.entry_date, new.memo, new.source_record_id,
             new.source_rule, new.reverses_entry_id, new.created_by, new.created_at)
         is not distinct from
         row(old.id, old.tenant_id, old.period_id, old.entry_date, old.memo, old.source_record_id,
             old.source_rule, old.reverses_entry_id, old.created_by, old.created_at) then
    return new;
  end if;
  raise exception 'posted journal entries cannot be changed' using errcode = 'P0001';
end
$$;

create trigger journal_entry_immutable before update or delete on journal_entry
  for each row execute function journal_is_immutable();
create trigger journal_line_immutable before update or delete on journal_line
  for each row execute function journal_is_immutable();

create function journal_period_must_be_open() returns trigger language plpgsql as $$
declare
  v_status text;
  v_starts date;
  v_ends date;
begin
  select status, starts_on, ends_on into v_status, v_starts, v_ends
    from fiscal_period where id = new.period_id;
  if v_status is distinct from 'open' then
    raise exception 'period is closed' using errcode = 'P0001';
  end if;
  if new.entry_date < v_starts or new.entry_date > v_ends then
    raise exception 'entry date is outside its period' using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger journal_entry_open_period before insert on journal_entry
  for each row execute function journal_period_must_be_open();

-- A journal entry's lines are written by the transaction that posts it. A
-- later transaction cannot add lines to a posted entry, not even a balanced
-- pair: corrections go through a reversal. The entry's xmin is compared with
-- the current top-level transaction, so entry and lines must not be split
-- across savepoints.
create function journal_line_with_its_entry() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from journal_entry e
     where e.id = new.entry_id and e.xmin = pg_current_xact_id()::xid
  ) then
    raise exception 'journal lines can only be added in the transaction that posts their entry' using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger journal_line_with_its_entry before insert on journal_line
  for each row execute function journal_line_with_its_entry();

-- Receipts -------------------------------------------------------------------

create table receipt_series (
  tenant_id uuid not null references tenant(id),
  key text not null,
  prefix text not null,
  reset text not null default 'fiscal_year' check (reset in ('fiscal_year', 'never')),
  label text not null,
  primary key (tenant_id, key)
);

create table receipt (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  series_key text not null,
  period text not null,
  seq bigint not null,
  number text not null,
  record_id uuid references record(id),
  amount numeric(14, 2) not null check (amount > 0),
  receipt_date date not null,
  status text not null default 'issued' check (status in ('issued', 'void')),
  void_reason text,
  voided_at timestamptz,
  replaces_receipt_id uuid references receipt(id),
  issued_by text,
  issued_at timestamptz not null default now(),
  foreign key (tenant_id, series_key) references receipt_series(tenant_id, key),
  unique (tenant_id, series_key, period, seq),
  unique (tenant_id, number),
  check (status = 'issued' or (void_reason is not null and length(trim(void_reason)) > 0))
);
create unique index receipt_one_replacement on receipt (replaces_receipt_id) where replaces_receipt_id is not null;
create unique index receipt_one_live_per_rule on receipt (record_id, series_key) where status = 'issued';

create function receipt_is_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'receipts cannot be deleted' using errcode = 'P0001';
  end if;
  if old.status = 'issued' and new.status = 'void'
     and row(new.id, new.tenant_id, new.series_key, new.period, new.seq, new.number, new.record_id,
             new.amount, new.receipt_date, new.replaces_receipt_id, new.issued_by, new.issued_at)
         is not distinct from
         row(old.id, old.tenant_id, old.series_key, old.period, old.seq, old.number, old.record_id,
             old.amount, old.receipt_date, old.replaces_receipt_id, old.issued_by, old.issued_at) then
    return new;
  end if;
  raise exception 'issued receipts cannot be changed except by voiding' using errcode = 'P0001';
end
$$;

create trigger receipt_immutable before update or delete on receipt
  for each row execute function receipt_is_immutable();

-- Who issued a receipt, as it stood then: a later change to the organisation's
-- names, address, registrations or logo must not rewrite an issued receipt.
create table receipt_issuer (
  receipt_id uuid primary key references receipt(id),
  tenant_id uuid not null references tenant(id),
  issuer jsonb not null,
  logo_file_id uuid references file_object(id),
  captured_at timestamptz not null default now()
);
create index receipt_issuer_logo on receipt_issuer (logo_file_id) where logo_file_id is not null;

create function receipt_issuer_is_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'a receipt''s issuer cannot be changed' using errcode = 'P0001';
end
$$;
create trigger receipt_issuer_immutable before update or delete on receipt_issuer
  for each row execute function receipt_issuer_is_immutable();

-- Money accounts, transfers, payments ------------------------------------------------

create table money_account (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  key text not null,
  name text not null,
  kind text not null check (kind in ('bank', 'cash', 'wallet', 'investment')),
  ledger_account_id uuid not null references ledger_account(id),
  holder_user_id uuid references app_user(id),
  custodian text,
  upi_id text,
  allow_negative boolean not null default false,
  status text not null default 'active' check (status in ('active', 'closed')),
  created_by text,
  created_at timestamptz not null default now(),
  unique (tenant_id, key),
  unique (ledger_account_id)
);

create table transfer (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  from_account_id uuid not null references money_account(id),
  to_account_id uuid not null references money_account(id),
  amount numeric(14, 2) not null check (amount > 0),
  transfer_date date not null,
  reference text,
  journal_entry_id uuid not null references journal_entry(id),
  created_by text,
  created_at timestamptz not null default now(),
  check (from_account_id <> to_account_id)
);

create table payment_intent (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  record_id uuid not null references record(id),
  provider text not null check (provider in ('upi_direct', 'razorpay', 'cashfree')),
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null default 'INR',
  reference text not null,
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment', 'paid', 'failed', 'cancelled')),
  on_paid jsonb not null,
  upi_link text,
  provider_order_id text,
  provider_payment_id text,
  paid_on date,
  confirmed_by text,
  created_by text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (tenant_id, reference)
);
create unique index payment_intent_order on payment_intent (provider, provider_order_id) where provider_order_id is not null;
create unique index payment_intent_one_open on payment_intent (record_id) where status = 'awaiting_payment';

create table payment_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  provider text not null,
  provider_event_id text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  unique (tenant_id, provider, provider_event_id)
);

-- Row-level security -------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'ledger_account', 'fiscal_period', 'journal_entry', 'journal_line', 'receipt_series', 'receipt',
    'receipt_issuer', 'money_account', 'transfer', 'payment_intent', 'payment_event'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = (select app_tenant())) with check (tenant_id = (select app_tenant()))', t);
  end loop;
end
$$;

grant select, insert, update on ledger_account, fiscal_period, journal_entry, journal_line, receipt_series,
  receipt, money_account, payment_intent to app_runtime;
grant select, insert on receipt_issuer, transfer, payment_event to app_runtime;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (3, '003_ledger_money.sql', 'additive');
