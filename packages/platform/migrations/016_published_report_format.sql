-- 016_published_report_format: a shared copy is a PDF document or an Excel workbook.

alter table published_report add column format text not null default 'pdf';
alter table published_report add constraint published_report_format check (format in ('pdf', 'excel'));
alter table published_report add column workbook bytea;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (16, '016_published_report_format.sql', 'additive');
