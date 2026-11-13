-- 008_notification_html: the HTML alternative of a queued email.
-- In-app notifications and SMS leave it empty and keep using body.

alter table notification add column html text;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (8, '008_notification_html.sql', 'additive');
