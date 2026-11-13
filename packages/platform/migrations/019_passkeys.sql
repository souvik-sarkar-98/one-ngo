-- 019_passkeys: WebAuthn platform passkeys as a sign-in method. A passkey is
-- stored as its public key and signature counter only; the device keeps the
-- private key and checks the person's fingerprint, face or PIN itself. No
-- biometric data reaches the database.
--
-- Credentials and ceremony challenges belong to people, not organisations, so
-- like app_user and refresh_token they are reachable only through the owner role.

alter table tenant_auth_policy
  add column passkey_enabled boolean not null default false;

-- Registered device credentials. One person may keep several (a phone and a laptop).
create table passkey_credential (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id),
  credential_id text not null unique,
  public_key bytea not null,
  counter bigint not null default 0 check (counter >= 0),
  transports text[] not null default '{}',
  device_type text not null default 'singleDevice'
    check (device_type in ('singleDevice', 'multiDevice')),
  backed_up boolean not null default false,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index passkey_credential_user on passkey_credential (user_id) where revoked_at is null;

-- One-time challenges for registration and sign-in. Each is consumed by a single
-- ceremony and expires quickly; the organisation it was issued for is recorded.
create table passkey_challenge (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id),
  purpose text not null check (purpose in ('register', 'assert')),
  user_id uuid references app_user(id),
  challenge text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index passkey_challenge_expiry on passkey_challenge (expires_at) where used_at is null;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (19, '019_passkeys.sql', 'additive');
