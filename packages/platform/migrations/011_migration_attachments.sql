-- 011_migration_attachments: the files a data migration's records point at (photos, scans), uploaded
-- to the profile under a relative path. A file column of a record file names them. An attachment is
-- exempt from the 24-hour clean-up of unlinked uploads (it is kept while this row exists) and is
-- linked to its record by the normal save during the run. Old servers never name this table.

create table migration_attachment (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  profile_id  uuid not null references migration_profile(id) on delete cascade,
  path        text not null check (length(path) between 1 and 255),
  file_id     uuid not null references file_object(id),
  size        bigint not null check (size >= 0),
  uploaded_by text not null,
  created_at  timestamptz not null default now()
);
create unique index migration_attachment_path on migration_attachment (profile_id, lower(path));
create index migration_attachment_file on migration_attachment (file_id);

alter table migration_attachment enable row level security;
create policy tenant_isolation on migration_attachment
  using (tenant_id = (select app_tenant())) with check (tenant_id = (select app_tenant()));
grant select, insert, delete on migration_attachment to app_runtime;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (11, '011_migration_attachments.sql', 'additive');
