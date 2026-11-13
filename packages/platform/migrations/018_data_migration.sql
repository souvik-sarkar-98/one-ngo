-- 018_data_migration: CSV files from another system, mapped onto record types and run in order.
--
-- A profile holds the files, each file's targets (record types filled from its rows) and the
-- books figures applied after the run. migration_key remembers which record each old id became,
-- so a second run updates instead of adding, and a later file can refer to a record by old id.

create table migration_profile (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  name text not null check (length(name) between 1 and 120),
  status text not null default 'draft' check (status in ('draft', 'checked', 'running', 'done', 'failed')),
  books jsonb not null default '{}'::jsonb,
  books_applied_at timestamptz,
  books_result jsonb,
  check_result jsonb,
  job_id uuid references job(id),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index migration_profile_tenant on migration_profile (tenant_id, created_at desc);

create table migration_source (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  profile_id uuid not null references migration_profile(id) on delete cascade,
  file_id uuid not null references file_object(id),
  file_name text not null,
  columns jsonb not null default '[]'::jsonb,
  row_count integer not null default 0,
  position integer not null,
  mapping jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, file_name)
);
create index migration_source_profile on migration_source (tenant_id, profile_id, position);
create index migration_source_file on migration_source (file_id);

create table migration_key (
  tenant_id uuid not null references tenant(id),
  type_key text not null,
  old_id text not null check (length(old_id) between 1 and 200),
  record_id uuid not null references record(id) on delete cascade,
  profile_id uuid references migration_profile(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, type_key, old_id)
);
create index migration_key_record on migration_key (record_id);

do $$
declare
  t text;
begin
  foreach t in array array['migration_profile', 'migration_source', 'migration_key'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = (select app_tenant())) with check (tenant_id = (select app_tenant()))', t);
  end loop;
end
$$;

grant select, insert, update on migration_profile, migration_source, migration_key to app_runtime;
grant delete on migration_source to app_runtime;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (18, '018_data_migration.sql', 'additive');
