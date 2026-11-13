-- Local development seed for riverbank.
-- npm run dev runs this file after harbour. A row that is already stored is skipped and reported.
-- That skip is a notice, not an error.
-- @password Password@01
-- The block stores the scrypt hash of that password.
-- Sensitive record values (donor PAN) are stored as plain text. The application reads an unsealed value as it is, and seals it when that record is next saved.
-- Paid donations also post the donations module's journal and receipt, using the date this script runs as paid on.
-- Keep the donations setup in step with packages/product/modules/donations/module.json (version 0.2.1).
-- @organisation riverbank
do $seed$
declare
  v_tenant uuid;
  v_user uuid;
  v_email text;
  v_name text;
  v_role text;
  v_count int;
  v_expected int;
  v_changed boolean := false;
  v_hash text := 'scrypt$16384$8$1$t-HA_-4SNFZ4kKvN$WP-4--bYkmoWxrem4v_S3-O3ZcMhLHaDFfzUKxitmp0';
  v_today date := current_date;
  v_fy_start int;
  v_fy text;
  v_member record;
  v_row record;
  v_ravi uuid := 'b1000000-0000-4000-8000-000000000001';
  v_meera uuid := 'b1000000-0000-4000-8000-000000000002';
  v_long uuid := 'b1000000-0000-4000-8000-000000000003';
  v_long_name text := 'Long Name Donor NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN';
  v_donor_schema int;
  v_donation_schema int;
  v_period uuid;
  v_donor_name text;
  v_number text;
  v_data jsonb;
  v_entry uuid;
  v_account uuid;
  v_receipt uuid;
  v_receipt_seq int := 0;
  v_issuer jsonb;
begin
  -- Create the organisation. An existing key is left unchanged: this reports
  -- the skip and stops, so the rest of the seed does not write over it.
  v_tenant := null;
  insert into tenant (key, name, region)
  values ('riverbank', 'Riverbank Trust', 'asia-south1')
  on conflict (key) do nothing
  returning id into v_tenant;
  if v_tenant is null then
    raise notice 'Skipping organisation riverbank: it already exists.';
    return;
  end if;
  v_changed := true;

  -- Roles used by the functional test plan. Each one is customised, so a later
  -- edit in the product is not written back here. An existing role key is skipped.
  insert into role (tenant_id, key, label, permissions, require_two_step, customised)
  values
    (v_tenant, 'admin', 'Administrator', array['*']::text[], false, true),
    (v_tenant, 'finance', 'Finance', array['record:donor:*', 'record:donation:*', 'record:donation:transition:*', 'record:donation:action:*', 'payments:create', 'payments:confirm', 'money:accounts:read', 'people:read']::text[], false, true),
    (v_tenant, 'viewer', 'Viewer', array['record:donor:read', 'record:donation:read', 'people:read']::text[], false, true),
    (v_tenant, 'people-admin', 'People administrator', array['members:manage']::text[], false, true),
    (v_tenant, 'roles-admin', 'Roles administrator', array['admin:roles']::text[], false, true),
    (v_tenant, 'config', 'Config author', array['config:read', 'config:publish']::text[], false, true),
    (v_tenant, 'script', 'Script author', array['config:script:publish']::text[], false, true),
    (v_tenant, 'directory', 'Directory', array['people:read']::text[], false, true),
    (v_tenant, 'noaccess', 'No access', array[]::text[], false, true),
    (v_tenant, 'privacy', 'Privacy', array['privacy:consent:record', 'privacy:consent:read', 'privacy:erase']::text[], false, true),
    (v_tenant, 'two-step', 'Two-step required', array['record:donor:read', 'record:donation:read']::text[], true, true)
  on conflict (tenant_id, key) do nothing;
  get diagnostics v_count = row_count;
  if v_count < 11 then
    raise notice 'Skipping % role(s) for organisation riverbank: they already exist.', 11 - v_count;
  end if;
  if v_count > 0 then v_changed := true; end if;

  -- Bank, cash, and donation income. An existing account code is skipped and reported.
  insert into ledger_account (tenant_id, code, name, type)
  values
    (v_tenant, 'BANK', 'Bank account', 'asset'),
    (v_tenant, 'CASH', 'Cash in hand', 'asset'),
    (v_tenant, 'DONATION_INCOME', 'Donations received', 'income')
  on conflict (tenant_id, code) do nothing;
  get diagnostics v_count = row_count;
  if v_count < 3 then
    raise notice 'Skipping % ledger account(s) for organisation riverbank: they already exist.', 3 - v_count;
  end if;
  if v_count > 0 then v_changed := true; end if;

  -- Donation acknowledgement numbers, restarted each financial year.
  -- An existing series key is skipped and reported.
  insert into receipt_series (tenant_id, key, prefix, label, reset)
  values (v_tenant, 'donation-receipt', 'RCPT', 'Donation acknowledgement', 'fiscal_year')
  on conflict (tenant_id, key) do nothing;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise notice 'Skipping receipt series donation-receipt for organisation riverbank: it already exists.';
  else
    v_changed := true;
  end if;

  -- Turn on Donations at the version shipped with this seed.
  -- An existing module row is skipped and reported.
  insert into tenant_module (tenant_id, module_key, module_version)
  values (v_tenant, 'donations', '0.2.1')
  on conflict (tenant_id, module_key) do nothing;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise notice 'Skipping module donations for organisation riverbank: it already exists.';
  else
    v_changed := true;
  end if;

  -- The deploy step must already have published the donations catalogue.
  -- Copy each published definition this organisation does not have yet.
  -- A definition that is already published here is skipped and reported.
  select count(*) into v_expected
    from definition d
   where d.tenant_id is null and d.module_key = 'donations' and d.status = 'published';
  if v_expected = 0 then
    raise exception 'The donations module is not published. Run the deploy step before seeding.';
  end if;
  insert into definition (
    tenant_id, module_key, kind, key, version, base_version, status, body, checksum, created_by, published_by, published_at
  )
  select v_tenant, d.module_key, d.kind, d.key, 1, d.version, 'published', d.body, d.checksum, 'seed', 'seed', now()
    from definition d
   where d.tenant_id is null and d.module_key = 'donations' and d.status = 'published'
     and not exists (
       select 1 from definition existing
        where existing.tenant_id = v_tenant
          and existing.kind = d.kind
          and existing.key = d.key
          and existing.status = 'published'
     );
  get diagnostics v_count = row_count;
  if v_count < v_expected then
    raise notice 'Skipping % donations definition(s) for organisation riverbank: they already exist.', v_expected - v_count;
  end if;
  if v_count > 0 then v_changed := true; end if;

  -- Sample records need the published donor and donation schema versions copied above.
  select version into v_donor_schema from definition
   where tenant_id = v_tenant and kind = 'recordType' and key = 'donor' and status = 'published';
  -- Same check for the donation record type.
  select version into v_donation_schema from definition
   where tenant_id = v_tenant and kind = 'recordType' and key = 'donation' and status = 'published';
  if v_donor_schema is null or v_donation_schema is null then
    raise exception 'The donations record types were not published for this organisation.';
  end if;

  -- Financial year starts in April. An existing setting is skipped and reported.
  insert into tenant_setting (tenant_id, key, value, updated_by)
  values (v_tenant, 'finance.financialYearStartMonth', to_jsonb(4), 'seed')
  on conflict (tenant_id, key) do nothing;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise notice 'Skipping setting finance.financialYearStartMonth for organisation riverbank: it already exists.';
  else
    v_changed := true;
  end if;

  -- Label the financial year that contains today, April through March,
  -- for example 2026-27. Open that period. An existing label is skipped and reported.
  v_fy_start := case when extract(month from v_today) >= 4 then extract(year from v_today)::int else extract(year from v_today)::int - 1 end;
  v_fy := v_fy_start::text || '-' || lpad(((v_fy_start + 1) % 100)::text, 2, '0');
  v_period := null;
  insert into fiscal_period (tenant_id, key, starts_on, ends_on)
  values (v_tenant, v_fy, make_date(v_fy_start, 4, 1), make_date(v_fy_start + 1, 3, 31))
  on conflict (tenant_id, key) do nothing
  returning id into v_period;
  if v_period is null then
    raise notice 'Skipping fiscal period % for organisation riverbank: it already exists.', v_fy;
    -- The period is already open. Keep its id so a new paid donation can post into it.
    select id into v_period from fiscal_period where tenant_id = v_tenant and key = v_fy;
  else
    v_changed := true;
  end if;

  -- Bump the config version when this seed wrote setup, so open sessions reload it.
  if v_changed then
    update tenant set config_version = config_version + 1 where id = v_tenant;
  end if;

  -- People who can sign in. The account is shared by every organisation, so an
  -- existing email is kept. Membership and the role belong to this organisation
  -- and are skipped when this person already has them here.
  for v_member in
    select * from (values
      ('asha@riverbank.example', 'Asha Menon', 'admin'),
      ('finance@riverbank.example', 'Finance Member', 'finance'),
      ('viewer@riverbank.example', 'Viewer Member', 'viewer'),
      ('people@riverbank.example', 'People Administrator', 'people-admin'),
      ('roles@riverbank.example', 'Roles Administrator', 'roles-admin'),
      ('config@riverbank.example', 'Config Author', 'config'),
      ('script@riverbank.example', 'Script Author', 'script'),
      ('directory@riverbank.example', 'Directory Member', 'directory'),
      ('noaccess@riverbank.example', 'No Access Member', 'noaccess'),
      ('privacy@riverbank.example', 'Privacy Officer', 'privacy'),
      ('twostep@riverbank.example', 'Two Step Member', 'two-step'),
      ('shared@riverbank.example', 'Shared Member', 'viewer')
    ) as m(email, display_name, role_key)
  loop
    v_email := v_member.email;
    v_name := v_member.display_name;
    v_role := v_member.role_key;
    -- Account. Skip an email that already exists; the same person can belong to more than one organisation.
    insert into app_user (email, display_name, password_hash)
    values (v_email, v_name, v_hash)
    on conflict ((lower(email))) do nothing;
    get diagnostics v_count = row_count;
    if v_count = 0 then
      raise notice 'Skipping user %: it already exists.', v_email;
    end if;
    -- Look up the account, including one that was skipped above.
    select id into v_user from app_user where lower(email) = lower(v_email);
    -- Membership in this organisation. Skip when this person is already a member.
    insert into tenant_member (tenant_id, user_id, display_name)
    values (v_tenant, v_user, v_name)
    on conflict (tenant_id, user_id) do nothing;
    get diagnostics v_count = row_count;
    if v_count = 0 then
      raise notice 'Skipping member % in organisation riverbank: it already exists.', v_email;
    end if;
    -- Grant the listed role. Skip when this person already has that role here.
    insert into role_assignment (tenant_id, user_id, role_key, assigned_by)
    values (v_tenant, v_user, v_role, 'seed')
    on conflict (tenant_id, user_id, role_key) do nothing;
    get diagnostics v_count = row_count;
    if v_count = 0 then
      raise notice 'Skipping role % for %: it already exists.', v_role, v_email;
    end if;
  end loop;

  -- Sample donors from the functional test plan: Ravi Kumar (with PAN), Meera Iyer
  -- (no PAN), and a 200-character name. An existing record id is skipped and reported.
  insert into record (id, tenant_id, type_key, schema_version, number, data, search_text, created_by)
  values
    (
      v_ravi, v_tenant, 'donor', v_donor_schema, 'DNR/00001',
      jsonb_build_object(
        'name', 'Ravi Kumar', 'email', 'ravi@donor.example', 'phone', '+91 98765 43210', 'pan', 'ABCDE1234F',
        'city', 'Bengaluru', 'address', '12 Lake Road', 'notes', 'Functional test plan sample.',
        'totalGiven', 3300, 'donationCount', 5
      ),
      lower('DNR/00001 Ravi Kumar ravi@donor.example +91 98765 43210'),
      'seed'
    ),
    (
      v_meera, v_tenant, 'donor', v_donor_schema, 'DNR/00002',
      jsonb_build_object(
        'name', 'Meera Iyer', 'email', 'meera@donor.example', 'phone', '+91 80 4000 1200',
        'city', 'Bengaluru', 'notes', 'Functional test plan sample. No PAN.',
        'totalGiven', 0, 'donationCount', 0
      ),
      lower('DNR/00002 Meera Iyer meera@donor.example +91 80 4000 1200'),
      'seed'
    ),
    (
      v_long, v_tenant, 'donor', v_donor_schema, 'DNR/00003',
      jsonb_build_object(
        'name', v_long_name, 'city', 'Mysuru', 'notes', 'Functional test plan sample. 200 character name.',
        'totalGiven', 0, 'donationCount', 0
      ),
      lower('DNR/00003 ' || v_long_name),
      'seed'
    )
  on conflict (id) do nothing;
  get diagnostics v_count = row_count;
  if v_count < 3 then
    raise notice 'Skipping % donor record(s) for organisation riverbank: they already exist.', 3 - v_count;
  end if;

  -- Issuer stored on each receipt below. A later change to the organisation does not rewrite it.
  v_issuer := jsonb_build_object(
    'displayName', 'Riverbank Trust',
    'legalName', null,
    'contact', jsonb_build_object('email', null, 'phone', null, 'website', null),
    'address', null,
    'registrations', '[]'::jsonb,
    'logo', null,
    'signatory', null
  );

  -- Sample donations: raised, paid, and cancelled. An existing donation id is
  -- skipped and reported, and its journal and receipt are left as they are.
  -- A new paid donation posts cash or bank against donation income and issues
  -- a receipt dated today.
  for v_row in
    select * from (values
      (1, 'a1000000-0000-4000-8000-000000000001'::uuid, 'ravi', 1000::numeric, 10::numeric, 'raised', null::text, null::text),
      (2, 'a1000000-0000-4000-8000-000000000002'::uuid, 'ravi', 1, 0, 'raised', null, null),
      (3, 'a1000000-0000-4000-8000-000000000003'::uuid, 'walkin', 99999999.99, 0, 'raised', null, null),
      (4, 'a1000000-0000-4000-8000-000000000004'::uuid, 'ravi', 500, 0, 'paid', 'cash', null),
      (5, 'a1000000-0000-4000-8000-000000000005'::uuid, 'ravi', 750, 0, 'paid', 'bank_transfer', 'NEFT1001'),
      (6, 'a1000000-0000-4000-8000-000000000006'::uuid, 'ravi', 250, 0, 'paid', 'upi', 'UPI123456'),
      (7, 'a1000000-0000-4000-8000-000000000007'::uuid, 'ravi', 300, 0, 'paid', 'cheque', 'CHQ42'),
      (8, 'a1000000-0000-4000-8000-000000000008'::uuid, 'ravi', 1500, 0, 'paid', 'online', 'GATEWAY9'),
      (9, 'a1000000-0000-4000-8000-000000000009'::uuid, 'ravi', 200, 0, 'cancelled', null, null)
    ) as d(seq, id, who, amount, fee, status, method, reference)
  loop
    v_donor_name := case when v_row.who = 'walkin' then 'Walk-in donor' else 'Ravi Kumar' end;
    v_number := 'DON/' || v_fy || '/' || lpad(v_row.seq::text, 5, '0');
    v_data := jsonb_build_object(
      'donorName', v_donor_name,
      'amount', v_row.amount,
      'fee', v_row.fee,
      'netAmount', v_row.amount - v_row.fee
    );
    if v_row.who = 'ravi' then
      v_data := v_data || jsonb_build_object(
        'donor', v_ravi,
        'donorEmail', 'ravi@donor.example',
        'donorPhone', '+91 98765 43210',
        'donorPan', 'ABCDE1234F'
      );
    end if;
    if v_row.method is not null then
      v_data := v_data || jsonb_build_object('method', v_row.method, 'paidOn', to_char(v_today, 'YYYY-MM-DD'));
    end if;
    if v_row.reference is not null then
      v_data := v_data || jsonb_build_object('reference', v_row.reference);
    end if;

    -- Store the donation. Skip when this id is already stored.
    insert into record (
      id, tenant_id, type_key, schema_version, number, status, data, workflow_key, search_text, created_by
    ) values (
      v_row.id, v_tenant, 'donation', v_donation_schema, v_number, v_row.status, v_data, 'donation',
      lower(v_number || ' ' || v_donor_name || ' ' || v_row.amount::text),
      'seed'
    )
    on conflict (id) do nothing;
    if not found then
      raise notice 'Skipping donation %: it already exists.', v_number;
    elsif v_row.status = 'paid' then
      -- Cash is paid into the cash account. Every other method is paid into the bank account.
      select id into v_account from ledger_account
       where tenant_id = v_tenant and code = case when v_row.method = 'cash' then 'CASH' else 'BANK' end;
      -- Post the donation: one journal, then the balancing lines.
      insert into journal_entry (tenant_id, period_id, entry_date, memo, source_record_id, source_rule, created_by)
      values (
        v_tenant, v_period, v_today,
        'Donation ' || v_number || ' from ' || v_donor_name,
        v_row.id, 'donationPaid', 'seed'
      )
      returning id into v_entry;
      -- Debit that asset account for the amount received.
      insert into journal_line (tenant_id, entry_id, account_id, debit, credit)
      values (v_tenant, v_entry, v_account, v_row.amount, 0);
      -- Credit donation income for the same amount.
      select id into v_account from ledger_account where tenant_id = v_tenant and code = 'DONATION_INCOME';
      -- Write the credit line so the journal balances.
      insert into journal_line (tenant_id, entry_id, account_id, debit, credit)
      values (v_tenant, v_entry, v_account, 0, v_row.amount);

      -- Issue the next receipt in this financial year.
      v_receipt_seq := v_receipt_seq + 1;
      insert into receipt (tenant_id, series_key, period, seq, number, record_id, amount, receipt_date, issued_by)
      values (
        v_tenant, 'donation-receipt', v_fy, v_receipt_seq,
        'RCPT/' || v_fy || '/' || lpad(v_receipt_seq::text, 5, '0'),
        v_row.id, v_row.amount, v_today, 'seed'
      )
      returning id into v_receipt;
      -- Store who issued the receipt, as the organisation stands now.
      insert into receipt_issuer (receipt_id, tenant_id, issuer)
      values (v_receipt, v_tenant, v_issuer);
    end if;
  end loop;

  -- Next numbers for donors, donations, and receipts, past the sample rows.
  -- An existing counter is skipped and reported, so a later run does not rewind it.
  insert into sequence_counter (tenant_id, key, period, next_value)
  values
    (v_tenant, 'record:donor', 'all', 4),
    (v_tenant, 'record:donation', v_fy, 10),
    (v_tenant, 'receipt:donation-receipt', v_fy, v_receipt_seq + 1)
  on conflict (tenant_id, key, period) do nothing;
  get diagnostics v_count = row_count;
  if v_count < 3 then
    raise notice 'Skipping % sequence counter(s) for organisation riverbank: they already exist.', 3 - v_count;
  end if;
end
$seed$;
