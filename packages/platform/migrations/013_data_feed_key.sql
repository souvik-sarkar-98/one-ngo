-- 013_data_feed_key: an API key acts as a role, or reads one data feed, never both.

alter table api_key alter column role_key drop not null;
alter table api_key add column feed_key text;
alter table api_key add constraint api_key_one_subject check (
  (role_key is not null and feed_key is null) or (role_key is null and feed_key is not null)
);
alter table api_key add constraint api_key_feed_key_shape check (
  feed_key is null or feed_key ~ '^[a-z][a-zA-Z0-9_-]{0,62}$'
);

drop trigger api_key_access_version on api_key;
create trigger api_key_access_version after update of revoked_at, role_key, feed_key or delete on api_key
  for each row execute function app_bump_access_version();

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (13, '013_data_feed_key.sql', 'additive');
