-- 017_published_report_model: a published report keeps the data and layout
-- the page and the workbook are built from, not the rendered file.

alter table published_report add column model jsonb not null default '{}'::jsonb;
alter table published_report alter column model drop default;
alter table published_report drop column html;
alter table published_report drop column workbook;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (17, '017_published_report_model.sql', 'additive');
