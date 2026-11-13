-- 007_signatory: the organisation's authorised signatory, kept with each
-- receipt, and one public link per receipt.

alter table organisation_profile
  add column signatory_name text,
  add column signatory_designation text,
  add constraint organisation_profile_signatory_name_check check (signatory_name is null or length(signatory_name) between 1 and 120),
  add constraint organisation_profile_signatory_designation_check check (signatory_designation is null or length(signatory_designation) between 1 and 120);

do $$
declare
  c text;
begin
  select con.conname into c
    from pg_constraint con
   where con.conrelid = 'tenant_asset'::regclass
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) like '%kind%';
  if c is not null then
    execute format('alter table tenant_asset drop constraint %I', c);
  end if;
end
$$;

alter table tenant_asset add constraint tenant_asset_kind_check check (kind in ('logo', 'signatory'));

alter table receipt_issuer add column signatory_file_id uuid references file_object(id);
create index receipt_issuer_signatory on receipt_issuer (signatory_file_id) where signatory_file_id is not null;

-- The raw token is encrypted. Lookup uses the hash, so a database read does not open the receipt.
create table receipt_link (
  receipt_id uuid primary key references receipt(id),
  tenant_id uuid not null references tenant(id),
  token_hash text not null unique,
  token_enc text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by text,
  check ((revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_by is not null))
);

alter table receipt_link enable row level security;
create policy tenant_isolation on receipt_link
  using (tenant_id = (select app_tenant())) with check (tenant_id = (select app_tenant()));

grant select, insert, update on receipt_link to app_runtime;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (7, '007_signatory.sql', 'additive');
