-- 005_organisation_privacy: organisation profile, registrations and logo;
-- consent and erasure (DPDP).
--
-- consent_event and erasure_request are append-only and hold no personal
-- values: a data subject is named by kind and id only, so the history survives
-- the subject's erasure.

create table organisation_profile (
  tenant_id uuid primary key references tenant(id),
  email text,
  phone text,
  website text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country text check (country ~ '^[A-Z]{2}$'),
  timezone text,
  identity_confirmed_at timestamptz,
  identity_confirmed_by text,
  receipts_reviewed_at timestamptz,
  receipts_reviewed_by text,
  setup_completed_at timestamptz,
  setup_completed_by text,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- Numbers are stored trimmed and upper-cased, so the uniqueness ignores case.
create table organisation_registration (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  type text not null check (type ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  number text not null check (length(number) between 1 and 80),
  issuing_authority text,
  issued_on date,
  expires_on date,
  notes text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  unique (tenant_id, type, number),
  check (expires_on is null or issued_on is null or expires_on >= issued_on)
);

-- The binary is in the file store; a file named here is linked and never cleaned up.
create table tenant_asset (
  tenant_id uuid not null references tenant(id),
  kind text not null check (kind in ('logo')),
  file_id uuid not null references file_object(id),
  version integer not null default 1,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, kind)
);

create table consent_event (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenant(id),
  subject_kind text not null check (subject_kind in ('record', 'member')),
  subject_id text not null,
  purpose text not null check (purpose ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  state text not null check (state in ('granted', 'withdrawn')),
  source text not null check (source in ('form', 'paper', 'email', 'phone', 'in_person', 'import', 'api', 'erasure')),
  recorded_by text not null,
  recorded_at timestamptz not null default now()
);
create index consent_event_subject on consent_event (tenant_id, subject_kind, subject_id, purpose, id desc);

create table erasure_request (
  id uuid primary key,
  tenant_id uuid not null references tenant(id),
  subject_kind text not null check (subject_kind in ('record', 'member')),
  subject_id text not null,
  reason text not null check (reason in ('subject_request', 'consent_withdrawn', 'other')),
  summary jsonb not null,
  requested_by text not null,
  completed_at timestamptz not null default now(),
  unique (tenant_id, subject_kind, subject_id)
);

create function privacy_is_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% entries cannot be changed or deleted', tg_table_name using errcode = 'P0001';
end
$$;
create trigger consent_event_append_only before update or delete on consent_event
  for each row execute function privacy_is_append_only();
create trigger erasure_request_append_only before update or delete on erasure_request
  for each row execute function privacy_is_append_only();

do $$
declare
  t text;
begin
  foreach t in array array[
    'organisation_profile', 'organisation_registration', 'tenant_asset', 'consent_event', 'erasure_request'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = (select app_tenant())) with check (tenant_id = (select app_tenant()))', t);
  end loop;
end
$$;

grant select, insert, update on organisation_profile, organisation_registration, tenant_asset to app_runtime;
grant delete on organisation_registration, tenant_asset to app_runtime;
grant select, insert on consent_event, erasure_request to app_runtime;

-- Erasure functions ------------------------------------------------------------------
-- The runtime role may only add audit entries. Erasure replaces the erased
-- fields' values in the audit snapshots of the organisation's own records,
-- keeping who did what and when; nothing else in an entry changes.
create function app_erase_audit_values(p_entity text, p_entity_id text, p_keys text[])
returns integer language plpgsql security definer set search_path from current as $$
declare
  v_count integer;
begin
  if app_tenant() is null then raise exception 'no organisation is set for this erasure'; end if;
  if p_entity !~ '^record:' then raise exception 'only record audit entries are erased'; end if;
  update audit_event a
     set before = case when a.before ? 'data' then jsonb_set(a.before, '{data}', app_erased_keys(a.before->'data', p_keys)) else a.before end,
         after = case when a.after ? 'data' then jsonb_set(a.after, '{data}', app_erased_keys(a.after->'data', p_keys)) else a.after end
   where a.tenant_id = app_tenant() and a.entity = p_entity and a.entity_id = p_entity_id
     and ((a.before->'data') ?| p_keys or (a.after->'data') ?| p_keys);
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

create function app_erased_keys(p_data jsonb, p_keys text[]) returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(e.key, case when e.key = any(p_keys) then '"[erased]"'::jsonb else e.value end), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(p_data) = 'object' then p_data else '{}'::jsonb end) e
$$;

-- Accounts are shared by every organisation a person belongs to and only the
-- owner can change them. A suspended member of this organisation who belongs
-- to no other organisation has their account pseudonymised and switched off;
-- otherwise the account is left as it is and 'shared' is returned. Either way
-- this organisation's name for the person is cleared.
create function app_erase_account(p_user_id uuid, p_name text, p_email text)
returns text language plpgsql security definer set search_path from current as $$
declare
  v_email text;
begin
  if app_tenant() is null then raise exception 'no organisation is set for this erasure'; end if;
  if not exists (select 1 from tenant_member where tenant_id = app_tenant() and user_id = p_user_id and status = 'suspended') then
    raise exception 'only a suspended member of this organisation can be erased' using errcode = 'P0001';
  end if;
  update tenant_member set display_name = p_name where tenant_id = app_tenant() and user_id = p_user_id;
  if exists (select 1 from tenant_member where user_id = p_user_id and tenant_id <> app_tenant()) then
    return 'shared';
  end if;
  select email into v_email from app_user where id = p_user_id for update;
  update app_user
     set display_name = p_name, email = p_email, password_hash = null, totp_secret_enc = null, totp_enabled = false, status = 'disabled'
   where id = p_user_id;
  delete from user_identity where user_id = p_user_id;
  delete from email_code where lower(email) = lower(v_email);
  update password_token set used_at = now() where user_id = p_user_id and used_at is null;
  update refresh_token set revoked_at = now() where user_id = p_user_id and revoked_at is null;
  return 'erased';
end
$$;

-- Erasure also clears the erased person's values from the tables beside the
-- records, in the erasure's own transaction: stored API responses, queued and
-- sent events, import rows, approval requests and comments, connector delivery
-- errors, script messages, payment webhook bodies, file and member audit
-- entries, and a member's own messages. Amounts, dates, references, statuses
-- and ids are kept, so receipts, journals and payments still reconcile. The
-- runtime role cannot change several of these tables, so the owner does it
-- here, for records this same erasure pseudonymised.

create function app_scrub_keys(p_value jsonb, p_keys text[]) returns jsonb language plpgsql immutable as $$
begin
  return case jsonb_typeof(p_value)
    when 'object' then (
      select coalesce(jsonb_object_agg(e.key, case when lower(e.key) = any(p_keys) then '"[erased]"'::jsonb else app_scrub_keys(e.value, p_keys) end), '{}'::jsonb)
        from jsonb_each(p_value) e)
    when 'array' then (
      select coalesce(jsonb_agg(app_scrub_keys(a.v, p_keys) order by a.i), '[]'::jsonb)
        from jsonb_array_elements(p_value) with ordinality a(v, i))
    else p_value
  end;
end
$$;

-- p_records: [{"id": <record id>, "fields": [<erased field keys>]}].
create function app_erase_side_data(p_erasure uuid, p_records jsonb, p_member uuid, p_files text[])
returns jsonb language plpgsql security definer set search_path from current as $$
declare
  v_tenant uuid := app_tenant();
  v_marker jsonb := jsonb_build_object('erased', p_erasure);
  v_ids uuid[];
  v_needles text[];
  v_payment_needles text[];
  v_personal text[] := array['name', 'displayname', 'display_name', 'email', 'phone', 'contact', 'mobile', 'address',
    'customer_name', 'customer_email', 'customer_phone', 'customer_details', 'billing_address', 'shipping_address',
    'vpa', 'upi_id', 'payer_vpa', 'notes', 'card', 'bank_account', 'account_number', 'payer'];
  v_events uuid[];
  v_requests uuid[];
  r record;
  n integer;
  v_counts jsonb := '{}'::jsonb;
begin
  if v_tenant is null then raise exception 'no organisation is set for this erasure'; end if;
  select coalesce(array_agg((e->>'id')::uuid), '{}') into v_ids from jsonb_array_elements(p_records) e;
  if exists (
    select 1 from unnest(v_ids) i
     where not exists (
       select 1 from audit_event a
        where a.tenant_id = v_tenant and a.action = 'record.pseudonymised' and a.entity_id = i::text and a.after->>'erasure' = p_erasure::text)
  ) then
    raise exception 'only records this erasure pseudonymised are cleared' using errcode = 'P0001';
  end if;
  if p_member is not null and not exists (select 1 from tenant_member where tenant_id = v_tenant and user_id = p_member and status = 'suspended') then
    raise exception 'only a suspended member of this organisation can be erased' using errcode = 'P0001';
  end if;
  v_needles := array(select i::text from unnest(v_ids) i) || case when p_member is null then '{}'::text[] else array[p_member::text] end;
  if not cardinality(v_needles) > 0 then return v_counts; end if;

  -- Stored API responses: the request stays recognised, so a retry is still not run twice.
  update idempotency_key k set response = v_marker
   where k.tenant_id = v_tenant and k.response <> 'null'::jsonb
     and (k.actor_id = p_member::text or exists (select 1 from unnest(v_needles) x where strpos(k.response::text, x) > 0));
  get diagnostics n = row_count;
  v_counts := v_counts || jsonb_build_object('apiResponses', n);

  -- Events: a queued one is not sent any more.
  with changed as (
    update outbox_event o set payload = v_marker, status = case when o.status = 'pending' then 'failed' else o.status end
     where o.tenant_id = v_tenant and exists (select 1 from unnest(v_needles) x where strpos(o.payload::text, x) > 0)
    returning o.id)
  select coalesce(array_agg(id), '{}') into v_events from changed;
  v_counts := v_counts || jsonb_build_object('events', cardinality(v_events));

  update connector_delivery d set error = '[erased]'
   where d.tenant_id = v_tenant and d.error is not null and (d.record_id = any(v_ids) or d.outbox_event_id = any(v_events));
  get diagnostics n = row_count;
  v_counts := v_counts || jsonb_build_object('deliveries', n);

  -- Import rows, and the check results of the imports that created the records.
  update record_import i set check_result = null
   where i.tenant_id = v_tenant and i.check_result is not null
     and i.job_id in (select j.job_id from job_item j where j.tenant_id = v_tenant and j.record_id = any(v_ids));
  get diagnostics n = row_count;
  v_counts := v_counts || jsonb_build_object('imports', n);
  update job_item j set data = null, message = case when j.message is null then null else '[erased]' end
   where j.tenant_id = v_tenant and (j.data is not null or j.message is not null)
     and (j.record_id = any(v_ids) or exists (select 1 from unnest(v_needles) x where strpos(j.data::text, x) > 0));
  get diagnostics n = row_count;
  v_counts := v_counts || jsonb_build_object('jobItems', n);

  -- Approval requests: the proposed values of the erased fields; one still waiting can no longer be approved.
  for r in select (e->>'id')::uuid as id, array(select jsonb_array_elements_text(e->'fields')) as fields from jsonb_array_elements(p_records) e loop
    update approval_request a
       set data = app_erased_keys(a.data, r.fields),
           status = case when a.status = 'pending' then 'stale' else a.status end,
           decided_at = case when a.status = 'pending' then now() else a.decided_at end
     where a.tenant_id = v_tenant and a.record_id = r.id;
  end loop;
  select coalesce(array_agg(a.id), '{}') into v_requests from approval_request a where a.tenant_id = v_tenant and a.record_id = any(v_ids);
  v_counts := v_counts || jsonb_build_object('approvalRequests', cardinality(v_requests));
  update approval_decision d set comment = '[erased]' where d.tenant_id = v_tenant and d.request_id = any(v_requests) and d.comment is not null;
  get diagnostics n = row_count;
  v_counts := v_counts || jsonb_build_object('approvalComments', n);

  update script_run s set message = case when s.message is null then null else '[erased]' end, effects = null
   where s.tenant_id = v_tenant and s.record_id = any(v_ids) and (s.message is not null or s.effects is not null);
  get diagnostics n = row_count;
  v_counts := v_counts || jsonb_build_object('scriptRuns', n);

  -- Payment webhook bodies: the payer's contact details go; amounts, ids and statuses stay.
  v_payment_needles := array(
    select x from payment_intent p, unnest(array[p.reference, p.provider_order_id, p.provider_payment_id]) x
     where p.tenant_id = v_tenant and p.record_id = any(v_ids) and x is not null and length(x) >= 6);
  update payment_event e set payload = app_scrub_keys(e.payload, v_personal)
   where e.tenant_id = v_tenant and exists (select 1 from unnest(v_payment_needles || v_needles) x where strpos(e.payload::text, x) > 0)
     and e.payload is distinct from app_scrub_keys(e.payload, v_personal);
  get diagnostics n = row_count;
  v_counts := v_counts || jsonb_build_object('paymentEvents', n);

  update audit_event a set before = app_scrub_keys(a.before, v_personal), after = app_scrub_keys(a.after, v_personal)
   where a.tenant_id = v_tenant
     and ((a.entity = 'file' and a.entity_id = any(coalesce(p_files, '{}'))) or (a.entity = 'member' and a.entity_id = p_member::text))
     and (a.before is distinct from app_scrub_keys(a.before, v_personal) or a.after is distinct from app_scrub_keys(a.after, v_personal));
  get diagnostics n = row_count;
  v_counts := v_counts || jsonb_build_object('otherAuditEntries', n);

  if p_member is not null then
    update notification m set to_address = null, subject = '[erased]', body = '[erased]'
     where m.tenant_id = v_tenant and m.user_id = p_member and m.subject <> '[erased]';
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('memberMessages', n);
  end if;
  return v_counts;
end
$$;

revoke all on function app_erase_audit_values(text, text, text[]) from public;
revoke all on function app_erased_keys(jsonb, text[]) from public;
revoke all on function app_erase_account(uuid, text, text) from public;
revoke all on function app_scrub_keys(jsonb, text[]) from public;
revoke all on function app_erase_side_data(uuid, jsonb, uuid, text[]) from public;
grant execute on function app_erase_audit_values(text, text, text[]) to app_runtime;
grant execute on function app_erase_account(uuid, text, text) to app_runtime;
grant execute on function app_erase_side_data(uuid, jsonb, uuid, text[]) to app_runtime;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (5, '005_organisation_privacy.sql', 'additive');
