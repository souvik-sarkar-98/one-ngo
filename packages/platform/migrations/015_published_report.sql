-- 015_published_report: a reviewed report kept so chosen roles can open it.

create table published_report (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  report_key text not null,
  title text not null,
  params jsonb not null default '{}',
  html text not null,
  audience text[] not null default '{}',
  created_by text not null,
  created_at timestamptz not null default now()
);

create index published_report_tenant on published_report (tenant_id, created_at desc);

alter table published_report enable row level security;
create policy published_report_tenant on published_report
  using (tenant_id = (select app_tenant()))
  with check (tenant_id = (select app_tenant()));

grant select, insert on published_report to app_runtime;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (15, '015_published_report.sql', 'additive');
