-- 004_record_query: the record query functions.
--
-- These run clauses compiled from the record-query AST
-- (src/runtime/records/pg-query-compiler.ts) as the owner, outside row-level
-- security. They accept only that compiler's grammar:
--   * values only as $1 (the jsonb argument array); no other parameter;
--   * text literals only definition keys and the fixed formats of the totals;
--   * words only record columns, the functions, types and keywords the compiler
--     writes; operators only those it writes;
--   * sub-queries only the compiler's exact share, approval and bound-array
--     shapes, and only in the condition.
-- A clause shape the compiler starts writing needs a migration here too.

create function app_record_clause_ok(clause text, part text) returns boolean language plpgsql immutable as $$
declare
  c text := clause;
  depth integer := 0;
  op text;
  bound constant text := 'array\(select jsonb_array_elements_text\(\$1->[0-9]+\)\)';
begin
  if c is null or length(c) > 20000 or part is null or part not in ('where', 'order', 'select') then return false; end if;
  if c ~ '(;|--|/\*|\*/|\\|")' then return false; end if;

  if part = 'where' then
    c := regexp_replace(c,
      'exists \(select 1 from record_share s where s\.tenant_id = app_tenant\(\) and s\.record_id = r\.id'
      || ' and \(s\.expires_at is null or s\.expires_at > now\(\)\)'
      || ' and \(\(s\.principal_kind = ''user'' and s\.principal = \(\$1->>[0-9]+\)\)'
      || ' or \(s\.principal_kind = ''role'' and s\.principal = any\(' || bound || '\)\)\)\)',
      ' true ', 'g');
    c := regexp_replace(c,
      'exists \(select 1 from approval_request a where a\.tenant_id = app_tenant\(\) and a\.record_id = r\.id'
      || ' and a\.status = ''pending'' and a\.transition_key = any\(' || bound || '\)\)',
      ' true ', 'g');
    c := regexp_replace(c, bound, ' true ', 'g');
    c := regexp_replace(c, 'array\(select x::numeric from jsonb_array_elements_text\(\$1->[0-9]+\) x\)', ' true ', 'g');
    c := regexp_replace(c, '\mis distinct from\M', ' = ', 'g');
  end if;

  c := regexp_replace(c, '''(?:[a-z][a-zA-Z0-9_-]{0,62}|YYYY-MM-DD|YYYY-MM|YYYY|YY|-|Asia/Kolkata|[0-9]{1,2} months)''', ' true ', 'g');
  if strpos(c, '''') > 0 then return false; end if;

  for i in 1 .. length(c) loop
    if substr(c, i, 1) = '(' then depth := depth + 1;
    elsif substr(c, i, 1) = ')' then
      depth := depth - 1;
      if depth < 0 then return false; end if;
    end if;
  end loop;
  if depth <> 0 then return false; end if;

  for op in select m[1] from regexp_matches(c, '([-+*/<>=~!@#%^&|`?]+)', 'g') as m loop
    if op not in ('->>', '->', '?|', '>=', '<=', '<>', '||', '=', '<', '>', '*', '/', '+', '-') then return false; end if;
  end loop;

  c := replace(c, '::', ' ');
  c := regexp_replace(c, '\$1(?![0-9])', ' ', 'g');
  c := regexp_replace(c,
    '\m(?:and|or|not|is|null|true|false|any|between|ilike|asc|desc|nulls|last|as|at|time|zone|interval'
    || '|r|id|type_key|deleted_at|status|owner_id|created_by|created_at|updated_at|workflow_key|workflow_state|data|search_text|number'
    || '|text|numeric|uuid|date'
    || '|lower|coalesce|sum|count|asin|sqrt|least|power|sin|cos|radians|to_char|date_trunc'
    || '|k|v|s[0-9]+)\M',
    ' ', 'g');
  c := regexp_replace(c, '\m[0-9]+\M', ' ', 'g');
  c := regexp_replace(c, '->>|->|\?\||>=|<=|<>|\|\||[-=<>*/+(),.]', ' ', 'g');
  return c ~ '^\s*$';
end
$$;

create function app_record_ids(p_where text, p_order text, p_args jsonb, p_limit integer, p_offset integer)
returns table (id uuid) language plpgsql stable security definer set search_path from current set random_page_cost = 1.1 as $$
begin
  if app_tenant() is null then raise exception 'no organisation is set for this query'; end if;
  if not app_record_clause_ok(p_where, 'where') or not app_record_clause_ok(p_order, 'order')
     or jsonb_typeof(p_args) is distinct from 'array' then
    raise exception 'invalid record query';
  end if;
  return query execute format(
    'select r.id from record r where r.tenant_id = app_tenant() and (%s) order by %s limit $2 offset $3', p_where, p_order)
    using p_args, p_limit, p_offset;
end
$$;

create function app_record_count(p_where text, p_args jsonb)
returns integer language plpgsql stable security definer set search_path from current set random_page_cost = 1.1 as $$
declare n integer;
begin
  if app_tenant() is null then raise exception 'no organisation is set for this query'; end if;
  if not app_record_clause_ok(p_where, 'where') or jsonb_typeof(p_args) is distinct from 'array' then
    raise exception 'invalid record query';
  end if;
  execute format('select count(*)::int from record r where r.tenant_id = app_tenant() and (%s)', p_where) into n using p_args;
  return n;
end
$$;

-- The group is a select-list position.
create function app_record_agg(p_select text, p_where text, p_group text, p_args jsonb)
returns setof jsonb language plpgsql stable security definer set search_path from current set random_page_cost = 1.1 as $$
begin
  if app_tenant() is null then raise exception 'no organisation is set for this query'; end if;
  if not app_record_clause_ok(p_where, 'where') or not app_record_clause_ok(p_select, 'select')
     or (p_group is not null and p_group !~ '^[1-9]$') or jsonb_typeof(p_args) is distinct from 'array' then
    raise exception 'invalid record query';
  end if;
  return query execute format(
    'select to_jsonb(t) from (select %s from record r where r.tenant_id = app_tenant() and (%s) %s) t',
    p_select, p_where, case when p_group is null then '' else 'group by ' || p_group end)
    using p_args;
end
$$;

-- Owner functions resolve names in the migration's schema; a caller's temporary
-- table must not shadow record, record_share or approval_request.
do $$
declare
  path text := current_setting('search_path') || ', pg_temp';
begin
  execute format('alter function app_record_ids(text, text, jsonb, integer, integer) set search_path = %s', path);
  execute format('alter function app_record_count(text, jsonb) set search_path = %s', path);
  execute format('alter function app_record_agg(text, text, text, jsonb) set search_path = %s', path);
end
$$;

-- Only the runtime role (and the owner) may run them.
revoke all on function app_record_clause_ok(text, text) from public;
revoke all on function app_record_ids(text, text, jsonb, integer, integer) from public;
revoke all on function app_record_count(text, jsonb) from public;
revoke all on function app_record_agg(text, text, text, jsonb) from public;
grant execute on function app_record_ids(text, text, jsonb, integer, integer) to app_runtime;
grant execute on function app_record_count(text, jsonb) to app_runtime;
grant execute on function app_record_agg(text, text, text, jsonb) to app_runtime;

insert into schema_compatibility (schema_level, migration_name, compatibility)
values (4, '004_record_query.sql', 'additive');
