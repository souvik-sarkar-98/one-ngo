-- 012_public_form_link: one secret link per record a visitor submitted.
-- The raw token is encrypted. Lookup uses the hash, so a database read does not open the record.
-- Named apart from record_link, which already stores references between records.

create table public_form_link (
  record_id uuid primary key references record(id),
  tenant_id uuid not null references tenant(id),
  token_hash text not null unique,
  token_enc text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by text,
  check ((revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_by is not null))
);

alter table public_form_link enable row level security;
create policy tenant_isolation on public_form_link
  using (tenant_id = (select app_tenant())) with check (tenant_id = (select app_tenant()));

grant select, insert, update on public_form_link to app_runtime;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (12, '012_public_form_link.sql', 'additive');
