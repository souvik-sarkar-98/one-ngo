-- 009_migration_retention: a data migration's uploaded CSVs and failed-row data can hold
-- personal information. Purging deletes them and stamps when it happened, so the screens can
-- say the data is gone. Old servers select explicit column lists and never name these columns.

alter table migration_source  add column purged_at timestamptz;
alter table migration_profile add column purged_at timestamptz;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (9, '009_migration_retention.sql', 'additive');
