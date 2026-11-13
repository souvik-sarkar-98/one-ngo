-- 001_core: database roles, tenant binding, organisations, definitions, records,
-- events, jobs, files and integrations.
--
-- Baseline of the pre-release migration chain. It holds the final form of every
-- object and no upgrade steps, so it can only run on an empty database. Files
-- 001-005 are the product; 006 is the operator control plane and is only
-- needed by an installation that onboards organisations for other people.

-- Roles ----------------------------------------------------------------------
-- app_runtime is the role every tenant transaction switches to, so row-level
-- security applies even where the connecting user owns the tables. The four
-- ngo_* roles are least-privilege groups for the serving applications; login
-- roles are provisioned by deployment and granted membership in exactly one.
-- Roles are cluster-wide catalog rows, not per-database ones. Several databases
-- on one cluster (every test database, and a shared staging cluster) can run
-- this file at once, and an unconditional ALTER ROLE, GRANT or COMMENT on a
-- role another migration is also touching fails with "tuple concurrently
-- updated". So each step only writes when the role is missing or differs, and
-- a steady-state run is read-only here.
do $$
declare
  v_role text;
begin
  foreach v_role in array array['app_runtime', 'ngo_main_runtime', 'ngo_main_system', 'ngo_operator', 'ngo_operator_runtime'] loop
    if not exists (select 1 from pg_roles where rolname = v_role) then
      begin
        execute format('create role %I nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls', v_role);
      exception when duplicate_object or unique_violation then
        -- Another database created it between the check and the create; the attribute check below still applies.
        null;
      end;
    end if;
    -- Never trust a pre-provisioned role's attributes. In particular, a
    -- superuser or BYPASSRLS role would invalidate every grant below.
    if exists (
      select 1 from pg_roles
       where rolname = v_role
         and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolbypassrls or rolinherit)
    ) then
      execute format('alter role %I nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls', v_role);
    end if;
  end loop;
end
$$;

-- Runtime groups may enter the tenant RLS role only inside the transaction
-- preamble. Control-plane groups cannot.
do $$
declare
  v_member text;
begin
  foreach v_member in array array['ngo_main_runtime', 'ngo_operator_runtime'] loop
    if not exists (
      select 1 from pg_auth_members m
        join pg_roles r on r.oid = m.roleid
        join pg_roles u on u.oid = m.member
       where r.rolname = 'app_runtime' and u.rolname = v_member
    ) then
      execute format('grant app_runtime to %I', v_member);
    end if;
  end loop;
end
$$;

-- On hosted PostgreSQL the connecting role is not a superuser, so it must be a
-- member of app_runtime to run SET LOCAL ROLE app_runtime.
do $$
begin
  if not exists (
    select 1 from pg_auth_members m
      join pg_roles r on r.oid = m.roleid
      join pg_roles u on u.oid = m.member
     where r.rolname = 'app_runtime' and u.rolname = current_user
  ) and not (select rolsuper from pg_roles where rolname = current_user) then
    execute format('grant app_runtime to %I', current_user);
  end if;
end
$$;

-- Migrations may run in a schema other than public (isolated test schemas).
do $$
begin
  -- Tenant transactions finish their preamble as app_runtime, so granting
  -- schema access only to its parent service groups is not sufficient.
  execute format('grant usage on schema %I to app_runtime, ngo_main_runtime, ngo_main_system, ngo_operator, ngo_operator_runtime', current_schema());
  execute format('revoke create on schema %I from app_runtime, ngo_main_runtime, ngo_main_system, ngo_operator, ngo_operator_runtime', current_schema());
end
$$;

do $$
declare
  v_role record;
begin
  for v_role in
    select * from (values
      ('ngo_main_runtime', 'One NGO main-server tenant traffic; member of app_runtime'),
      ('ngo_main_system', 'One NGO main-server reviewed cross-tenant functions only'),
      ('ngo_operator', 'One NGO operator control-plane functions and operator identity'),
      ('ngo_operator_runtime', 'One NGO operator onboarding tenant traffic; member of app_runtime')
    ) as c(role_name, description)
  loop
    if shobj_description((select oid from pg_roles where rolname = v_role.role_name), 'pg_authid') is distinct from v_role.description then
      execute format('comment on role %I is %L', v_role.role_name, v_role.description);
    end if;
  end loop;
end
$$;

-- Tenant binding ---------------------------------------------------------------
-- The organisation a tenant transaction acts for cannot be switched by the
-- runtime role. `app.tenant_id` is still a setting anyone may change, so
-- app_tenant() only trusts it together with `app.tenant_seal`, a hash of the
-- organisation, the transaction's start time and a secret only the owner can
-- read. Only app_bind_tenant() writes the seal, and only for a caller that
-- presents a key the server registered (as the owner) in tenant_bind_key. A
-- changed or forged setting makes app_tenant() fail, so a statement cannot
-- reach another organisation's rows.

create table tenant_seal_key (
  id boolean primary key default true check (id),
  secret text not null
);
insert into tenant_seal_key (secret)
  values (replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));

-- Hashes of the keys of running server processes; each process adds its own.
create table tenant_bind_key (
  key_hash text primary key,
  registered_at timestamptz not null default now()
);

create function app_tenant_seal(p_tenant uuid) returns text language sql stable parallel safe as $$
  select encode(sha256(convert_to(k.secret || ':' || p_tenant::text || ':' || (extract(epoch from now()) * 1000000)::bigint::text, 'UTF8')), 'hex')
    from tenant_seal_key k
$$;

create function app_tenant() returns uuid
language plpgsql stable parallel safe security definer set search_path from current as $$
declare
  v_id text := nullif(current_setting('app.tenant_id', true), '');
begin
  if v_id is null then return null; end if;
  if current_setting('app.tenant_seal', true) is distinct from app_tenant_seal(v_id::uuid) then
    raise exception 'the organisation of this transaction was not set by the server' using errcode = '42501';
  end if;
  return v_id::uuid;
end
$$;

create function app_bind_tenant(p_tenant uuid, p_key text) returns void
language plpgsql volatile security definer set search_path from current as $$
begin
  if p_tenant is null then raise exception 'no organisation given' using errcode = '22004'; end if;
  if not exists (select 1 from tenant_bind_key where key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')) then
    raise exception 'this connection may not choose an organisation' using errcode = '42501';
  end if;
  if nullif(current_setting('app.tenant_id', true), '') is not null or nullif(current_setting('app.tenant_seal', true), '') is not null then
    raise exception 'the organisation of this transaction is already set' using errcode = '42501';
  end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  perform set_config('app.tenant_seal', app_tenant_seal(p_tenant), true);
end
$$;

-- Serving processes register an ephemeral tenant-binding key without direct
-- access to tenant_bind_key. The owner remains the function owner.
create function app_register_tenant_bind_key(p_key_hash text) returns void
language plpgsql volatile security definer set search_path from current as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid tenant bind key hash' using errcode = '22023';
  end if;
  insert into tenant_bind_key (key_hash) values (p_key_hash) on conflict do nothing;
end
$$;

create function app_unregister_tenant_bind_key(p_key_hash text) returns void
language plpgsql volatile security definer set search_path from current as $$
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid tenant bind key hash' using errcode = '22023';
  end if;
  delete from tenant_bind_key where key_hash = p_key_hash;
end
$$;

revoke all on function app_tenant_seal(uuid) from public;
revoke all on function app_bind_tenant(uuid, text) from public;
revoke all on function app_register_tenant_bind_key(text) from public;
revoke all on function app_unregister_tenant_bind_key(text) from public;
grant execute on function app_tenant() to app_runtime;
grant execute on function app_bind_tenant(uuid, text) to app_runtime;
grant execute on function app_register_tenant_bind_key(text), app_unregister_tenant_bind_key(text)
  to ngo_main_system, ngo_operator;

-- Serving processes may read migration history for the start-up compatibility
-- gate (the migrator creates this table before the first file). This grants no
-- write, ownership, CREATE, or migrator capability.
grant select on table kysely_migration to ngo_main_system, ngo_operator;

-- Future independently deployed servers use this registry to decide whether a
-- schema newer than their own is still safe to serve. Every migration
-- registers itself in its own transaction.
create table schema_compatibility (
  schema_level integer primary key check (schema_level > 0),
  migration_name text not null unique,
  compatibility text not null check (compatibility in ('additive', 'breaking'))
);
revoke all on schema_compatibility from public, ngo_main_runtime, ngo_main_system, ngo_operator;
grant select on schema_compatibility to ngo_main_system, ngo_operator;

-- Organisations ----------------------------------------------------------------

-- tenant.name is the display name; the legal name is separate. The organisation
-- code (key) is in every sign-in and invitation link /o/<code>/sign-in.
-- config_version and access_version are cache-invalidation counters: instances
-- compare them with the value their cached definitions or actors were loaded at.
create table tenant (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  region text,
  config_version integer not null default 0,
  status text not null default 'active'
    check (status in ('provisioning', 'active', 'provisioning_failed', 'suspended', 'closed')),
  created_at timestamptz not null default now(),
  last_tick_at timestamptz,
  default_locale text not null default 'en' check (default_locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  access_version integer not null default 0,
  legal_name text check (legal_name is null or length(trim(legal_name)) between 1 and 200),
  status_changed_at timestamptz,
  constraint tenant_key_format check (key ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$')
);

create function tenant_key_is_immutable() returns trigger language plpgsql as $$
begin
  if new.key is distinct from old.key then
    raise exception 'an organisation code cannot change' using errcode = 'P0001';
  end if;
  return new;
end
$$;
create trigger tenant_key_immutable before update of key on tenant
  for each row execute function tenant_key_is_immutable();

create table tenant_module (
  tenant_id uuid not null references tenant(id),
  module_key text not null,
  module_version text not null,
  enabled boolean not null default true,
  installed_at timestamptz not null default now(),
  primary key (tenant_id, module_key)
);

create table tenant_setting (
  tenant_id uuid not null references tenant(id),
  key text not null,
  value jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

-- Definitions --------------------------------------------------------------------
-- tenant_id null = product-shipped base layer, readable by every tenant.
-- Tenant rows are the effective definitions the runtime reads. A tenant row
-- with base_version set was materialised from that base version plus the
-- tenant's extension patch.
create table definition (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenant(id),
  module_key text,
  kind text not null,
  key text not null,
  version integer not null,
  base_version integer,
  status text not null check (status in ('draft', 'published', 'superseded')),
  body jsonb not null,
  checksum text not null,
  created_by text,
  created_at timestamptz not null default now(),
  published_by text,
  published_at timestamptz,
  unique nulls not distinct (tenant_id, kind, key, version)
);
create unique index definition_one_draft on definition (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, key) where status = 'draft';
create unique index definition_one_published on definition (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, key) where status = 'published';

create table extension_patch (
  tenant_id uuid not null references tenant(id),
  kind text not null,
  key text not null,
  patch jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, kind, key)
);

-- Cross-tenant read for the start-up definitions check.
create function app_published_definition_checksums(p_module_key text)
returns table(kind text, key text, checksum text)
language sql stable security definer set search_path from current as $$
  select d.kind, d.key, d.checksum
    from definition d
   where d.tenant_id is null
     and d.module_key = p_module_key
     and d.status = 'published'
$$;
revoke all on function app_published_definition_checksums(text) from public;
grant execute on function app_published_definition_checksums(text)
  to ngo_main_system, ngo_operator;

-- Records ------------------------------------------------------------------------

-- pg_trgm is optional: without it the search column still exists and search
-- falls back to an unindexed ilike (checked and logged at start-up).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_trgm') then
    create extension if not exists pg_trgm;
  end if;
exception when insufficient_privilege then
  raise notice 'pg_trgm could not be created; search will not be indexed';
end
$$;

-- blind_index keeps a keyed hash of sensitive field values by field key.
-- Sensitive values are stored encrypted, so a unique sensitive field cannot be
-- compared in record data; unique checks and the managed unique index (cast
-- 'hash') compare the hash instead.
create table record (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  type_key text not null,
  schema_version integer not null,
  number text,
  status text,
  data jsonb compression lz4 not null default '{}'::jsonb,
  owner_id text,
  version integer not null default 1,
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  search_text text,
  workflow_key text,
  workflow_state jsonb not null default '{}'::jsonb,
  blind_index jsonb not null default '{}'::jsonb
);
create index record_tenant_type on record (tenant_id, type_key, created_at desc);
create unique index record_number on record (tenant_id, type_key, number) where number is not null;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    execute 'create index record_search on record using gin (search_text gin_trgm_ops) where deleted_at is null';
  end if;
end
$$;

create table record_link (
  tenant_id uuid not null references tenant(id),
  from_id uuid not null references record(id),
  relation_key text not null,
  to_id uuid not null references record(id),
  primary key (tenant_id, from_id, relation_key, to_id)
);

create table sequence_counter (
  tenant_id uuid not null references tenant(id),
  key text not null,
  period text not null,
  next_value bigint not null,
  primary key (tenant_id, key, period)
);

-- Indexes on record data created from published definitions. Shared by every
-- organisation with the same record type key, field and cast; owner only.
create table managed_index (
  name text primary key,
  type_key text not null,
  field text not null,
  cast_as text not null default 'text' check (cast_as in ('text', 'numeric', 'date', 'lat', 'lng', 'state', 'hash')),
  kind text not null check (kind in ('reference', 'unique', 'filter', 'sort', 'location', 'state')),
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  last_needed_at timestamptz not null default now(),
  unique (type_key, field, cast_as, kind)
);

-- A record shared with a person or a role.
create table record_share (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  record_id uuid not null references record(id),
  principal_kind text not null check (principal_kind in ('user', 'role')),
  principal text not null,
  access text not null check (access in ('read', 'edit')),
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (tenant_id, record_id, principal_kind, principal)
);
create index record_share_principal on record_share (tenant_id, principal_kind, principal);

-- Files live in the file store; the database keeps what they are and where they are linked.
create table file_object (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  name text not null,
  mime text not null,
  size bigint not null check (size >= 0),
  sha256 text not null,
  storage_key text not null,
  record_id uuid references record(id),
  field_key text,
  created_by text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index file_object_record on file_object (tenant_id, record_id) where deleted_at is null;
create index file_object_unlinked on file_object (created_at) where record_id is null and deleted_at is null;

-- Audit, events and scripts ------------------------------------------------------------

create table audit_event (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenant(id),
  actor_id text,
  action text not null,
  entity text not null,
  entity_id text,
  -- A create or delete holds the whole record; an update holds only the fields it changed
  -- (`diff: true` in the snapshot). lz4 keeps large values small and cheap to read.
  before jsonb compression lz4,
  after jsonb compression lz4,
  at timestamptz not null default now()
);
create index audit_event_entity on audit_event (tenant_id, entity, entity_id);
create index audit_event_at on audit_event (tenant_id, at);
-- The audit log filtered by person (Administration).
create index audit_event_actor on audit_event (tenant_id, actor_id, at);

-- done_handlers names the handlers that finished for the event; a retry runs only the rest.
create table outbox_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  type text not null,
  payload jsonb compression lz4 not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  processed_at timestamptz,
  done_handlers text[] not null default '{}'
) with (autovacuum_vacuum_scale_factor = 0.05);
create index outbox_pending on outbox_event (available_at) where status = 'pending';
create index outbox_done_cleanup on outbox_event (processed_at) where status = 'done';

-- Script effects: each run keeps a summary of the effects it proposed (count by
-- type and the journal total); a run whose proposal was refused is logged as
-- 'rejected'. The hook names are the five scripts run on.
create table script_run (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenant(id),
  script_key text not null,
  script_version integer not null,
  hook text not null,
  record_id uuid,
  duration_ms integer not null,
  outcome text not null check (outcome in ('ok', 'failed', 'limit', 'rejected')),
  message text,
  at timestamptz not null default now(),
  effects jsonb,
  constraint script_run_hook_check
    check (hook in ('beforeSave', 'validate', 'afterSave', 'workflowGuard', 'customButton'))
);

-- Rate limits shared across instances for actions that send messages.
create table rate_limit (
  key text primary key,
  window_started_at timestamptz not null default now(),
  hits integer not null default 0
) with (autovacuum_vacuum_scale_factor = 0.05);

-- Scheduler fairness and resumable scheduled automations.
create table automation_state (
  tenant_id uuid not null references tenant(id),
  automation_key text not null,
  last_run_at timestamptz,
  pending_due_at timestamptz,
  cursor_created_at timestamptz,
  cursor_id uuid,
  primary key (tenant_id, automation_key)
);

-- Marks automation actions already done, so a retried event does not repeat them.
create table automation_run (
  tenant_id uuid not null references tenant(id),
  event_id text not null,
  automation_key text not null,
  action_index integer not null,
  done_at timestamptz not null default now(),
  primary key (tenant_id, event_id, automation_key, action_index)
);

-- Approvals ----------------------------------------------------------------------------

create table approval_request (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  record_id uuid not null references record(id),
  transition_key text not null,
  requested_by text not null,
  data jsonb not null default '{}'::jsonb,
  record_version integer not null,
  required_approvals integer not null default 1 check (required_approvals >= 1),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'stale', 'withdrawn')),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index approval_one_pending on approval_request (record_id) where status = 'pending';
create index approval_pending_by_tenant on approval_request (tenant_id, created_at) where status = 'pending';

create table approval_decision (
  request_id uuid not null references approval_request(id),
  tenant_id uuid not null references tenant(id),
  user_id text not null,
  decision text not null check (decision in ('approve', 'reject')),
  comment text,
  decided_at timestamptz not null default now(),
  primary key (request_id, user_id)
);

-- Background work -----------------------------------------------------------------------
-- Shared by imports, bulk operations and rebuilds. A running job holds a short
-- lease (locked_until); when it lapses (the process stopped) the next tick
-- resumes the job. actor is who the job acts for, with the permissions they had
-- when they started it.
create table job (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  kind text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  input jsonb not null default '{}'::jsonb,
  state jsonb not null default '{}'::jsonb,
  progress integer not null default 0,
  total integer,
  result jsonb,
  error text,
  cancel_requested boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  locked_until timestamptz,
  actor jsonb not null default '{}'::jsonb
) with (autovacuum_vacuum_scale_factor = 0.05);
create index job_runnable on job (created_at) where status in ('queued', 'running');
create index job_by_creator on job (tenant_id, created_by, created_at desc);

create table job_item (
  tenant_id uuid not null references tenant(id),
  job_id uuid not null references job(id),
  seq integer not null,
  status text not null check (status in ('done', 'failed', 'skipped')),
  record_id uuid,
  message text,
  data jsonb,
  created_at timestamptz not null default now(),
  primary key (job_id, seq)
);
create index job_item_failed on job_item (job_id, seq) where status = 'failed';

create table record_import (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  type_key text not null,
  file_id uuid not null references file_object(id),
  file_name text not null,
  columns jsonb not null default '[]'::jsonb,
  row_count integer not null default 0,
  mapping jsonb,
  options jsonb not null default '{}'::jsonb,
  status text not null default 'uploaded' check (status in ('uploaded', 'mapped', 'checked', 'running', 'done', 'failed')),
  check_result jsonb,
  job_id uuid references job(id),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index record_import_by_creator on record_import (tenant_id, created_by, created_at desc);

-- The same Idempotency-Key within 24 hours returns the first response.
create table idempotency_key (
  tenant_id uuid not null references tenant(id),
  actor_id text not null,
  key text not null,
  request_hash text not null,
  status_code integer not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, actor_id, key)
);
create index idempotency_key_age on idempotency_key (created_at);

-- Connectors -------------------------------------------------------------------------------

create table connector (
  tenant_id uuid not null references tenant(id),
  key text not null,
  type text not null check (type in ('smtp', 'razorpay', 'cashfree', 'webhook', 'oidc', 'sms', 'whatsapp', 'http', 'oauth')),
  config jsonb not null default '{}'::jsonb,
  secret_enc text,
  enabled boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

-- Retries of one queued delivery update the same log row (outbox_event_id).
create table connector_delivery (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  connector_key text not null,
  event text not null,
  record_id uuid references record(id),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  response_status integer,
  error text,
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  outbox_event_id uuid,
  foreign key (tenant_id, connector_key) references connector(tenant_id, key)
);
create index connector_delivery_log on connector_delivery (tenant_id, connector_key, created_at desc);
create unique index connector_delivery_event on connector_delivery (outbox_event_id);

-- Row-level security -------------------------------------------------------------------------
-- Policies bind app_runtime, the role every tenant transaction switches to. RLS is
-- deliberately not FORCEd: system work (migrations, dispatcher, base definitions)
-- runs as the owning role, which may not be a superuser on hosted PostgreSQL.
-- The organisation is evaluated once per statement, not per row.

alter table tenant enable row level security;
create policy tenant_self on tenant using (id = (select app_tenant()));

alter table definition enable row level security;
create policy definition_read on definition for select using (tenant_id is null or tenant_id = (select app_tenant()));
create policy definition_write on definition for insert with check (tenant_id = (select app_tenant()));
create policy definition_update on definition for update using (tenant_id = (select app_tenant())) with check (tenant_id = (select app_tenant()));

do $$
declare
  t text;
begin
  foreach t in array array[
    'tenant_module', 'tenant_setting', 'extension_patch', 'record', 'record_link', 'sequence_counter',
    'record_share', 'file_object', 'audit_event', 'outbox_event', 'script_run', 'automation_state',
    'automation_run', 'approval_request', 'approval_decision', 'job', 'job_item', 'record_import',
    'idempotency_key', 'connector', 'connector_delivery'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = (select app_tenant())) with check (tenant_id = (select app_tenant()))', t);
  end loop;
end
$$;

grant select on tenant to app_runtime;
grant update (config_version, access_version) on tenant to app_runtime;
grant select, insert, update on tenant_module, tenant_setting, definition, extension_patch, record, record_link,
  sequence_counter, record_share, file_object, outbox_event, automation_state, automation_run, approval_request,
  approval_decision, job, job_item, record_import, idempotency_key, connector, connector_delivery to app_runtime;
grant delete on extension_patch, record_link, record_share to app_runtime;
grant select, insert on audit_event, script_run to app_runtime;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (1, '001_core.sql', 'additive');
