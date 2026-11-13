-- 014_receipt_content: the wording of a receipt, resolved when it was issued.
-- A later edit to the receipt rule must not rewrite an issued receipt.

create table receipt_content (
  receipt_id uuid primary key references receipt(id),
  tenant_id uuid not null references tenant(id),
  content jsonb not null,
  captured_at timestamptz not null default now()
);

alter table receipt_content enable row level security;
create policy tenant_isolation on receipt_content
  using (tenant_id = (select app_tenant())) with check (tenant_id = (select app_tenant()));

grant select, insert on receipt_content to app_runtime;

create function receipt_content_is_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'a receipt''s wording cannot be changed' using errcode = 'P0001';
end
$$;
create trigger receipt_content_immutable before update or delete on receipt_content
  for each row execute function receipt_content_is_immutable();

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (14, '014_receipt_content.sql', 'additive');
