-- 010_migration_people: the per-organisation map from a legacy system's user id to the person
-- it became here, so a later file can point at a person by the old id. Nothing is added to
-- app_user. Legacy ids are text, so UUID, integer and text ids all fit. Two old ids may map to
-- one user (duplicate legacy accounts); one old id never maps to two. Old servers never name
-- this table.

create table migration_person_key (
  tenant_id  uuid not null references tenant(id),
  old_id     text not null check (length(old_id) between 1 and 200),
  user_id    uuid not null references app_user(id),
  profile_id uuid references migration_profile(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, old_id)
);
create index migration_person_key_user on migration_person_key (tenant_id, user_id);

alter table migration_person_key enable row level security;
create policy tenant_isolation on migration_person_key
  using (tenant_id = (select app_tenant())) with check (tenant_id = (select app_tenant()));
grant select, insert, update on migration_person_key to app_runtime;

-- Erasing a member also drops the legacy ids that pointed at them (an old id can be an email or a
-- national id). The runtime role has no delete grant on the table, so this runs as its owner, for
-- the current organisation, and only for a suspended member, like app_erase_side_data.
create function app_erase_migration_person_key(p_member uuid) returns integer
language plpgsql security definer set search_path from current as $$
declare
  v_tenant uuid := app_tenant();
  n integer;
begin
  if v_tenant is null then raise exception 'no organisation is set for this erasure'; end if;
  if not exists (select 1 from tenant_member where tenant_id = v_tenant and user_id = p_member and status = 'suspended') then
    raise exception 'only a suspended member of this organisation can be erased' using errcode = 'P0001';
  end if;
  delete from migration_person_key where tenant_id = v_tenant and user_id = p_member;
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function app_erase_migration_person_key(uuid) from public;
grant execute on function app_erase_migration_person_key(uuid) to app_runtime;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (10, '010_migration_people.sql', 'additive');
