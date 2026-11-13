-- Local development seed for the operator organisation.
-- npm run dev runs this file after riverbank. A row that is already stored is skipped and reported.
-- That skip is a notice, not an error.
-- @password Password@01
-- The block stores the scrypt hash of that password.
-- Keep the donations setup in step with packages/product/modules/donations/module.json (version 0.2.1).
-- @organisation operator
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
begin
  -- Create the organisation. An existing key is left unchanged: this reports
  -- the skip and stops, so the rest of the seed does not write over it.
  v_tenant := null;
  insert into tenant (key, name, region)
  values ('operator', 'Operator', 'asia-south1')
  on conflict (key) do nothing
  returning id into v_tenant;
  if v_tenant is null then
    raise notice 'Skipping organisation operator: it already exists.';
    return;
  end if;
  v_changed := true;

  -- Administrator is customised. Finance and viewer keep the default donations
  -- permissions. A role key that is already stored is skipped and reported.
  insert into role (tenant_id, key, label, permissions, require_two_step, customised)
  values
    (v_tenant, 'admin', 'Administrator', array['*']::text[], false, true),
    (v_tenant, 'finance', 'Finance', array['record:donor:*', 'record:donation:*', 'record:donation:transition:*', 'record:donation:action:*', 'payments:create', 'payments:confirm', 'money:accounts:read', 'people:read']::text[], false, false),
    (v_tenant, 'viewer', 'Viewer', array['record:donor:read', 'record:donation:read', 'people:read']::text[], false, false)
  on conflict (tenant_id, key) do nothing;
  get diagnostics v_count = row_count;
  if v_count < 3 then
    raise notice 'Skipping % role(s) for organisation operator: they already exist.', 3 - v_count;
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
    raise notice 'Skipping % ledger account(s) for organisation operator: they already exist.', 3 - v_count;
  end if;
  if v_count > 0 then v_changed := true; end if;

  -- Donation acknowledgement numbers, restarted each financial year.
  -- An existing series key is skipped and reported.
  insert into receipt_series (tenant_id, key, prefix, label, reset)
  values (v_tenant, 'donation-receipt', 'RCPT', 'Donation acknowledgement', 'fiscal_year')
  on conflict (tenant_id, key) do nothing;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise notice 'Skipping receipt series donation-receipt for organisation operator: it already exists.';
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
    raise notice 'Skipping module donations for organisation operator: it already exists.';
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
    raise notice 'Skipping % donations definition(s) for organisation operator: they already exist.', v_expected - v_count;
  end if;
  if v_count > 0 then v_changed := true; end if;

  -- Financial year starts in April. An existing setting is skipped and reported.
  insert into tenant_setting (tenant_id, key, value, updated_by)
  values (v_tenant, 'finance.financialYearStartMonth', to_jsonb(4), 'seed')
  on conflict (tenant_id, key) do nothing;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise notice 'Skipping setting finance.financialYearStartMonth for organisation operator: it already exists.';
  else
    v_changed := true;
  end if;

  -- Label the financial year that contains today, April through March,
  -- for example 2026-27. Open that period. An existing label is skipped and reported.
  v_fy_start := case when extract(month from v_today) >= 4 then extract(year from v_today)::int else extract(year from v_today)::int - 1 end;
  v_fy := v_fy_start::text || '-' || lpad(((v_fy_start + 1) % 100)::text, 2, '0');
  insert into fiscal_period (tenant_id, key, starts_on, ends_on)
  values (v_tenant, v_fy, make_date(v_fy_start, 4, 1), make_date(v_fy_start + 1, 3, 31))
  on conflict (tenant_id, key) do nothing;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise notice 'Skipping fiscal period % for organisation operator: it already exists.', v_fy;
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
      ('admin@operator.local', 'Operator Admin', 'admin')
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
      raise notice 'Skipping member % in organisation operator: it already exists.', v_email;
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
end
$seed$;
