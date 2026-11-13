-- 002_identity: people, membership, roles, sign-in, per-organisation sign-in
-- policy, API keys, the inbox and Home pins, and access-version invalidation.
--
-- Identity is global (a person can belong to several NGOs); membership and roles
-- are per tenant. app_user, refresh_token, auth_throttle, email_code,
-- password_token, oidc_login, connector_oauth_state and user_identity are only
-- reachable through the owner role, never as app_runtime.

-- Accounts ---------------------------------------------------------------------
-- totp_pending_secret_enc: setting up two-step again keeps the enrolled
-- authenticator working until the new one is confirmed. totp_last_step is the
-- last accepted 30-second time step; a code for the same or an earlier step is
-- refused, so each code signs in once.
create table app_user (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text not null,
  password_hash text,
  totp_secret_enc text,
  totp_enabled boolean not null default false,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  totp_pending_secret_enc text,
  totp_last_step bigint
);
create unique index app_user_email on app_user (lower(email));

-- display_name is the name the adding organisation gave the person. Accounts
-- are shared by every organisation a person belongs to, so the name one
-- organisation typed must not show in another; no name falls back to the
-- account's. last_signed_in_at never set means added but not signed in yet,
-- which the members list shows as invited.
create table tenant_member (
  tenant_id uuid not null references tenant(id),
  user_id uuid not null references app_user(id),
  status text not null default 'active' check (status in ('active', 'suspended')),
  joined_at timestamptz not null default now(),
  locale text check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  last_signed_in_at timestamptz,
  display_name text check (char_length(display_name) between 1 and 120),
  primary key (tenant_id, user_id)
);

create table role (
  tenant_id uuid not null references tenant(id),
  key text not null,
  label text not null,
  permissions text[] not null default '{}',
  require_two_step boolean not null default false,
  customised boolean not null default false,
  primary key (tenant_id, key)
);

create table role_assignment (
  tenant_id uuid not null references tenant(id),
  user_id uuid not null references app_user(id),
  role_key text not null,
  assigned_by text,
  assigned_at timestamptz not null default now(),
  primary key (tenant_id, user_id, role_key),
  foreign key (tenant_id, role_key) references role(tenant_id, key)
);

-- Sessions and sign-in tokens ------------------------------------------------------
-- Authentication evidence (method, assurance, provider) belongs to the
-- refresh-token family. Every rotation copies it from the locked predecessor;
-- callers can never upgrade it.
create table refresh_token (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  user_id uuid not null references app_user(id),
  tenant_id uuid not null references tenant(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  replaced_by uuid,
  created_at timestamptz not null default now(),
  method text not null default 'legacy',
  assurance text not null default 'aal1'
    check (assurance in ('aal1', 'aal2', 'aal3')),
  auth_time timestamptz not null default now(),
  amr text[] not null default '{}',
  acr text,
  provider_issuer text,
  provider_sid text
);
create index refresh_token_family on refresh_token (family_id);
create index refresh_token_method_live
  on refresh_token (tenant_id, user_id, method)
  where revoked_at is null;
create index refresh_token_provider_sid_live
  on refresh_token (provider_issuer, provider_sid)
  where provider_sid is not null and revoked_at is null;

create table auth_throttle (
  key text primary key,
  failures integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz
);

create table email_code (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  tenant_id uuid not null references tenant(id),
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index email_code_lookup on email_code (lower(email), tenant_id, created_at desc);

-- Password reset, invitations and two-step tickets. The sign_in_* columns carry
-- provider evidence across the local authenticator-app ticket.
create table password_token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id),
  tenant_id uuid not null references tenant(id),
  purpose text not null check (purpose in ('reset', 'invite', 'two_step')),
  token_hash text not null unique,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  sign_in_method text,
  sign_in_assurance text
    check (sign_in_assurance is null or sign_in_assurance in ('aal1', 'aal2', 'aal3')),
  sign_in_auth_time timestamptz,
  sign_in_amr text[],
  sign_in_acr text,
  sign_in_provider_issuer text,
  sign_in_provider_sid text
);
create index password_token_user on password_token (user_id, purpose) where used_at is null;

-- OpenID Connect sign-in.
create table oidc_login (
  state_hash text primary key,
  tenant_id uuid not null references tenant(id),
  provider text not null,
  nonce text not null,
  code_verifier text not null,
  next_path text not null default '/',
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Connector OAuth authorisation. Like oidc_login, only reachable through the owner role.
create table connector_oauth_state (
  state_hash text primary key,
  tenant_id uuid not null references tenant(id),
  connector_key text not null,
  code_verifier text not null,
  actor_id text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, connector_key) references connector(tenant_id, key)
);

-- A provider account (issuer + subject) is linked to one person after their first verified sign-in.
create table user_identity (
  issuer text not null,
  subject text not null,
  user_id uuid not null references app_user(id),
  email_at_link text not null,
  linked_at timestamptz not null default now(),
  primary key (issuer, subject)
);
create unique index user_identity_one_per_issuer on user_identity (issuer, user_id);

-- Per-NGO sign-in policy. Installation providers are deliberately unavailable
-- until an NGO opts in and assigns the assurance it trusts them to provide.
create table tenant_auth_policy (
  tenant_id uuid primary key references tenant(id),
  password_enabled boolean not null default true,
  email_code_enabled boolean not null default true,
  minimum_assurance text not null default 'aal1'
    check (minimum_assurance in ('aal1', 'aal2', 'aal3')),
  updated_at timestamptz not null default now(),
  updated_by text
);

create table tenant_auth_provider (
  tenant_id uuid not null references tenant(id),
  provider_id text not null,
  enabled boolean not null default false,
  assurance text not null default 'aal1'
    check (assurance in ('aal1', 'aal2', 'aal3')),
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (tenant_id, provider_id)
);

-- API keys, inbox and Home -----------------------------------------------------------

create table api_key (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  name text not null,
  secret_hash text not null,
  role_key text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  foreign key (tenant_id, role_key) references role(tenant_id, key)
);
create unique index api_key_name on api_key (tenant_id, lower(name)) where revoked_at is null;

-- A list pinned to one person's Home.
create table member_pin (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  user_id uuid not null references app_user(id),
  label text not null,
  list_view text not null,
  address text not null check (address like '/%' and address not like '//%'),
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index member_pin_owner on member_pin (tenant_id, user_id, position);

-- link is an in-app address the notification opens, for example a finished import.
create table notification (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  user_id uuid references app_user(id),
  channel text not null check (channel in ('inApp', 'email', 'push', 'sms', 'whatsapp')),
  to_address text,
  subject text not null,
  body text not null,
  record_id uuid references record(id),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  error text,
  read_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  link text check (link like '/%' and link not like '//%')
);
create index notification_inbox on notification (tenant_id, user_id, created_at desc) where channel = 'inApp';

-- Access version ---------------------------------------------------------------------
-- Bumped on every change to who may do what (roles, role assignments, membership
-- status, a person's account status, a revoked or re-roled API key). Each
-- instance compares it with the value its cached actors were loaded at, as
-- definitions compare config_version, so a removed role stops working on every
-- instance and background jobs re-check their creator.
create function app_bump_access_version() returns trigger language plpgsql set search_path from current as $$
begin
  if tg_table_name = 'app_user' then
    update tenant t set access_version = t.access_version + 1
     where t.id in (select m.tenant_id from tenant_member m where m.user_id = coalesce(new.id, old.id));
  else
    update tenant set access_version = access_version + 1 where id = coalesce(new.tenant_id, old.tenant_id);
  end if;
  return null;
end $$;

create trigger role_access_version after insert or update or delete on role
  for each row execute function app_bump_access_version();
create trigger role_assignment_access_version after insert or update or delete on role_assignment
  for each row execute function app_bump_access_version();
create trigger tenant_member_access_version after insert or delete or update of status on tenant_member
  for each row execute function app_bump_access_version();
create trigger app_user_access_version after update of status on app_user
  for each row execute function app_bump_access_version();
create trigger api_key_access_version after update of revoked_at, role_key or delete on api_key
  for each row execute function app_bump_access_version();

-- The person's name as the current organisation knows them, for reads that do
-- not join the membership themselves (audit, approvals, jobs, shares).
create function app_member_name(p_user_id uuid) returns text language sql stable set search_path from current as $$
  select coalesce(m.display_name, u.display_name)
    from app_user u
    left join tenant_member m on m.user_id = u.id and m.tenant_id = app_tenant()
   where u.id = p_user_id
$$;
grant execute on function app_member_name(uuid) to app_runtime;

-- Row-level security -------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'tenant_member', 'role', 'role_assignment', 'tenant_auth_policy', 'tenant_auth_provider',
    'api_key', 'member_pin', 'notification'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = (select app_tenant())) with check (tenant_id = (select app_tenant()))', t);
  end loop;
end
$$;

-- Users are global, so app_runtime may only see people who belong to the current NGO.
alter table app_user enable row level security;
create policy app_user_member on app_user for select using (
  exists (select 1 from tenant_member m where m.user_id = app_user.id and m.tenant_id = (select app_tenant()))
);

grant select, insert, update on tenant_member, role, role_assignment, tenant_auth_policy, tenant_auth_provider,
  api_key, member_pin, notification to app_runtime;
grant delete on role, role_assignment, member_pin to app_runtime;
-- Display names are needed for inboxes and audit views; nothing else about users is exposed.
grant select (id, display_name, email, status) on app_user to app_runtime;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (2, '002_identity.sql', 'additive');
