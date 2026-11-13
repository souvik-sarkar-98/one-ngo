-- 010_file_store_ref: which store holds each uploaded file.
--
-- Every organisation still uses the installation's one store, named 'platform'.
-- Recording the store per file lets an organisation move to another store later
-- without breaking the files it already has: each file is read from where it was
-- written.

alter table file_object add column store_ref text not null default 'platform'
  check (store_ref ~ '^[a-z][a-z0-9:_-]{0,62}$');

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (10, '010_file_store_ref.sql', 'additive');
