-- 006_operator: operator control plane. Hosted editions only; a self-managed
-- install can leave this file out (see docs/architecture/migration-schema-analysis.html).
--
-- The external provider authenticates; these rows decide whether the verified
-- identity may act. Everything here is reachable only by ngo_operator (and the
-- owner); row-level security without a policy for any other role keeps
-- app_runtime out.

create table operator_account (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(trim(display_name)) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  created_by uuid references operator_account(id),
  disabled_at timestamptz,
  disabled_by uuid references operator_account(id),
  check (
    (status = 'active' and disabled_at is null and disabled_by is null)
    or (status = 'disabled' and disabled_at is not null and disabled_by is not null)
  )
);

create table operator_identity (
  operator_id uuid not null references operator_account(id),
  issuer text not null,
  subject text not null,
  linked_at timestamptz not null default now(),
  linked_by uuid references operator_account(id),
  primary key (issuer, subject),
  unique (operator_id, issuer)
);

create table operator_grant (
  operator_id uuid not null references operator_account(id),
  action text not null check (action in ('onboard', 'status', 'retry', 'suspend', 'reactivate', 'close')),
  granted_at timestamptz not null default now(),
  granted_by uuid references operator_account(id),
  revoked_at timestamptz,
  revoked_by uuid references operator_account(id),
  primary key (operator_id, action),
  check ((revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_by is not null))
);

create table operator_login_state (
  id_hash text primary key check (id_hash ~ '^[0-9a-f]{64}$'),
  issuer text not null,
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  verifier_ciphertext text not null,
  next_path text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at)
);

create table operator_session (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  operator_id uuid not null references operator_account(id),
  issuer text not null,
  subject text not null,
  provider_sid text,
  display_snapshot text not null,
  auth_time timestamptz not null,
  amr text[] not null default '{}',
  acr text,
  provider_tokens_ciphertext text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at)
);
create index operator_session_sid on operator_session (issuer, provider_sid) where provider_sid is not null;
create index operator_session_account on operator_session (operator_id, expires_at) where revoked_at is null;

create table operator_step_up (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references operator_session(id),
  action text not null check (action in ('suspend', 'reactivate', 'close')),
  target text not null,
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  auth_time timestamptz not null,
  amr text[] not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  unique (session_id, action, target, nonce_hash),
  check (expires_at > created_at)
);

-- Organisation onboarding and the platform audit ------------------------------------------
-- Provisioning reads and writes these only as the owner or ngo_operator.
-- requested_by / updated_by keep the free-text name; the *_operator_id columns
-- are the structured, stable evidence for control-plane writes.
create table organisation_onboarding (
  request_id text primary key check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,99}$'),
  organisation_code text not null unique,
  input jsonb not null,
  input_sha256 text not null,
  state text not null default 'provisioning' check (state in ('provisioning', 'provisioning_failed', 'active')),
  step text not null default 'requested',
  tenant_id uuid unique references tenant(id),
  administrator_id uuid references app_user(id),
  invitation text not null default 'pending' check (invitation in ('pending', 'sent', 'failed')),
  failure_code text,
  failure_message text,
  requested_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  requested_by_operator_id uuid references operator_account(id),
  updated_by_operator_id uuid references operator_account(id)
);
create index organisation_onboarding_requested_operator on organisation_onboarding (requested_by_operator_id);

-- Onboarding and lifecycle actions, including those before the organisation exists.
create table platform_audit (
  id bigint generated always as identity primary key,
  operator text not null,
  action text not null,
  tenant_id uuid references tenant(id),
  request_id text,
  detail jsonb,
  at timestamptz not null default now(),
  operator_account_id uuid references operator_account(id),
  issuer text,
  subject text,
  display_snapshot text,
  permission text,
  auth_time timestamptz,
  assurance text,
  amr text[],
  acr text,
  operator_session_id uuid references operator_session(id),
  step_up_id uuid references operator_step_up(id)
);
create index platform_audit_tenant on platform_audit (tenant_id, at);
create index platform_audit_request on platform_audit (request_id, at);
create index platform_audit_operator on platform_audit (operator_account_id, at);

create function platform_audit_is_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'platform audit entries cannot be changed or deleted' using errcode = 'P0001';
end
$$;
create trigger platform_audit_append_only before update or delete on platform_audit
  for each row execute function platform_audit_is_append_only();

alter table operator_account enable row level security;
alter table operator_identity enable row level security;
alter table operator_grant enable row level security;
alter table operator_login_state enable row level security;
alter table operator_session enable row level security;
alter table operator_step_up enable row level security;
alter table organisation_onboarding enable row level security;
alter table platform_audit enable row level security;

create policy operator_control on operator_account to ngo_operator using (true) with check (true);
create policy operator_control on operator_identity to ngo_operator using (true) with check (true);
create policy operator_control on operator_grant to ngo_operator using (true) with check (true);
create policy operator_control on operator_login_state to ngo_operator using (true) with check (true);
create policy operator_control on operator_session to ngo_operator using (true) with check (true);
create policy operator_control on operator_step_up to ngo_operator using (true) with check (true);
create policy operator_control on organisation_onboarding to ngo_operator using (true) with check (true);
create policy operator_read_append on platform_audit to ngo_operator using (true) with check (true);

grant select, insert, update on operator_account, operator_identity, operator_grant,
  operator_login_state, operator_session, operator_step_up, organisation_onboarding to ngo_operator;
-- The audit log is append-only: there is deliberately no UPDATE or DELETE grant.
grant select, insert on platform_audit to ngo_operator;
grant usage, select on sequence platform_audit_id_seq to ngo_operator;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (6, '006_operator.sql', 'additive');
