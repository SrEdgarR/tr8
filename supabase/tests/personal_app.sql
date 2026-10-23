-- Run as postgres against a disposable/test project, or in the SQL editor.
-- Every fixture and the allowlist change are rolled back. Identity sequences
-- deliberately keep their consumed values; gaps do not affect correctness.
begin;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
select set_config('tr8.test_count', '0', true);
-- PostgreSQL creates the session's pg_temp namespace on the first TEMP object.
create temporary table tr8_test_runtime_init (unused boolean) on commit drop;
-- Preserve a read-only snapshot of all pre-existing real rows. Fixture actions
-- must not change their IDs, versions, relationships or contents.
create temporary table tr8_test_existing_data on commit drop as
select 'projects'::text as entity, coalesce(jsonb_agg(to_jsonb(p) order by id), '[]'::jsonb) as payload
from public.tr8_projects p
union all
select 'tasks', coalesce(jsonb_agg(to_jsonb(t) order by id), '[]'::jsonb)
from public.tr8_tasks t;

create function pg_temp.assert_true(p_ok boolean, p_label text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_ok is distinct from true then
    raise exception 'Assertion failed: %', p_label;
  end if;
  perform set_config('tr8.test_count', (current_setting('tr8.test_count')::integer + 1)::text, true);
end;
$$;
create function pg_temp.expect_error(p_sql text, p_state text, p_label text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_state then
      perform pg_temp.assert_true(true, p_label);
      return;
    end if;
    raise exception 'Assertion failed: %; expected SQLSTATE %, received % (%)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'Assertion failed: %; operation unexpectedly succeeded', p_label;
end;
$$;
do $$
begin
  execute format('grant usage on schema %I to anon, authenticated', pg_my_temp_schema()::regnamespace::text);
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text), pg_temp.expect_error(text, text, text) to anon, authenticated;

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('ee010001-0001-4000-8000-000000000001', 'authenticated', 'authenticated', 'tr8-owner-fixture@example.invalid', now(), '{}', '{}', now(), now()),
  ('ee010002-0001-4000-8000-000000000002', 'authenticated', 'authenticated', 'tr8-outsider-fixture@example.invalid', now(), '{}', '{"role":"Owner","email":"tr8-owner-fixture@example.invalid"}', now(), now());
update tr8_private.app_config set owner_email = 'tr8-owner-fixture@example.invalid' where singleton;
insert into public.tr8_projects (id, owner_id, name)
values ('aa010002-0001-4000-8000-000000000002', 'ee010002-0001-4000-8000-000000000002', 'Other owner');
insert into public.tr8_tasks (id, owner_id, project_id, title)
values ('bb010002-0001-4000-8000-000000000002', 'ee010002-0001-4000-8000-000000000002', 'aa010002-0001-4000-8000-000000000002', 'Other task');

do $$
begin
  perform pg_temp.assert_true(
    (select count(*) = 2 from pg_class where oid in ('public.tr8_projects'::regclass, 'public.tr8_tasks'::regclass) and relrowsecurity),
    'RLS is enabled on both exposed tables');
  perform pg_temp.assert_true(
    (select count(*) = 1 from pg_constraint where conname = 'tr8_tasks_project_owner_fk' and contype = 'f' and cardinality(conkey) = 2),
    'project ownership is protected by a composite foreign key');
  perform pg_temp.assert_true(
    (select identity_generation = 'ALWAYS' from information_schema.columns
     where table_schema = 'public' and table_name = 'tr8_tasks' and column_name = 'task_number'),
    'task numbers use a server identity, rather than a client maximum');
  perform pg_temp.assert_true(
    (select count(*) = 6 from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('tr8_check_access', 'tr8_create_project', 'tr8_create_task', 'tr8_update_project', 'tr8_update_task', 'tr8_delete_task') and not p.prosecdef),
    'all public RPCs run with invoker privileges');
end;
$$;

set local role anon;
do $$
begin
  perform pg_temp.expect_error('select * from public.tr8_projects', '42501', 'anon cannot read projects');
  perform pg_temp.expect_error('select * from public.tr8_tasks', '42501', 'anon cannot read tasks');
  perform pg_temp.expect_error('select public.tr8_check_access()', '42501', 'anon cannot call access check');
  perform pg_temp.expect_error($sql$select public.tr8_create_project(gen_random_uuid(), 'x', '', '#5A67D8', 'active')$sql$, '42501', 'anon cannot call project create');
  perform pg_temp.expect_error($sql$select public.tr8_create_task(gen_random_uuid(), gen_random_uuid(), 'x', '', 'todo', 'none', null, null)$sql$, '42501', 'anon cannot call task create');
  perform pg_temp.expect_error($sql$select public.tr8_update_project(gen_random_uuid(), 1, '{"name":"x"}')$sql$, '42501', 'anon cannot call project update');
  perform pg_temp.expect_error($sql$select public.tr8_update_task(gen_random_uuid(), 1, '{"title":"x"}')$sql$, '42501', 'anon cannot call task update');
  perform pg_temp.expect_error('select public.tr8_delete_task(gen_random_uuid(), 1)', '42501', 'anon cannot call delete');
end;
$$;

set local role authenticated;
do $$
begin
  perform pg_temp.assert_true(not tr8_private.is_owner(), 'authenticated without a user ID is denied');
  perform pg_temp.assert_true((select count(*) = 0 from public.tr8_projects), 'missing JWT cannot read projects');
  perform pg_temp.assert_true((select count(*) = 0 from public.tr8_tasks), 'missing JWT cannot read tasks');
end;
$$;
select set_config('request.jwt.claim.sub', 'ee010002-0001-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"ee010002-0001-4000-8000-000000000002","role":"authenticated","user_metadata":{"role":"Owner","email":"tr8-owner-fixture@example.invalid"}}', true);
do $$
begin
  perform pg_temp.assert_true(not tr8_private.is_owner(), 'confirmed outsider and forged metadata do not satisfy the allowlist');
  perform pg_temp.assert_true(not public.tr8_check_access(), 'public access check denies outsider');
  perform pg_temp.assert_true((select count(*) = 0 from public.tr8_projects), 'outsider cannot see even its own fixture project');
  perform pg_temp.assert_true((select count(*) = 0 from public.tr8_tasks), 'outsider cannot see even its own fixture task');
  perform pg_temp.expect_error('select * from tr8_private.app_config', '42501', 'allowlist is not readable by authenticated');
  perform pg_temp.expect_error($sql$update tr8_private.app_config set owner_email = 'tr8-outsider-fixture@example.invalid'$sql$, '42501', 'outsider cannot change the allowlist');
  perform pg_temp.expect_error($sql$insert into public.tr8_projects (name) values ('forbidden')$sql$, '42501', 'outsider cannot insert through the Data API');
  perform pg_temp.expect_error($sql$select public.tr8_create_task(gen_random_uuid(), 'aa010002-0001-4000-8000-000000000002', 'x', '', 'todo', 'none', null, null)$sql$, '42501', 'outsider cannot create using RPC');
  update public.tr8_projects set name = 'forbidden' where id = 'aa010002-0001-4000-8000-000000000002';
  perform pg_temp.assert_true(not found, 'outsider UPDATE affects no project rows');
  delete from public.tr8_tasks where id = 'bb010002-0001-4000-8000-000000000002';
  perform pg_temp.assert_true(not found, 'outsider DELETE affects no task rows');
end;
$$;

reset role;
update auth.users set email_confirmed_at = null where id = 'ee010001-0001-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ee010001-0001-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"ee010001-0001-4000-8000-000000000001","role":"authenticated"}', true);
do $$
begin
  perform pg_temp.assert_true(not tr8_private.is_owner(), 'allowlisted but unconfirmed email is denied');
  perform pg_temp.expect_error($sql$select public.tr8_create_project(gen_random_uuid(), 'x', '', '#5A67D8', 'active')$sql$, '42501', 'unconfirmed account cannot create');
end;
$$;
reset role;
update auth.users set email_confirmed_at = now() where id = 'ee010001-0001-4000-8000-000000000001';
update auth.users set deleted_at = now() where id = 'ee010001-0001-4000-8000-000000000001';
set local role authenticated;
do $$
begin
  perform pg_temp.assert_true(not public.tr8_check_access(), 'soft-deleted account is denied');
end;
$$;
reset role;
update auth.users set deleted_at = null where id = 'ee010001-0001-4000-8000-000000000001';
update tr8_private.app_config set owner_email = null where singleton;
set local role authenticated;
do $$
begin
  perform pg_temp.assert_true(not tr8_private.is_owner(), 'empty allowlist denies the confirmed account');
end;
$$;
reset role;
update tr8_private.app_config set owner_email = 'tr8-owner-fixture@example.invalid' where singleton;
set local role authenticated;

do $$
declare
  v_project public.tr8_projects;
  v_task public.tr8_tasks;
  v_number bigint;
begin
  perform pg_temp.assert_true(tr8_private.is_owner(), 'confirmed allowlisted account is authorized');
  perform pg_temp.assert_true(public.tr8_check_access(), 'public access check accepts the owner before any project exists');
  v_project := public.tr8_create_project('aa010001-0001-4000-8000-000000000001', '  Personal project  ', '', '#5A67D8', 'active');
  perform pg_temp.assert_true(v_project.owner_id = auth.uid() and v_project.name = 'Personal project' and v_project.version = 1, 'create project returns normalized owned row');
  v_project := public.tr8_create_project('aa010001-0001-4000-8000-000000000001', 'Personal project', '', '#5A67D8', 'active');
  perform pg_temp.assert_true(v_project.version = 1 and (select count(*) = 1 from public.tr8_projects), 'project retry returns one original row without updating version');
  perform pg_temp.expect_error($sql$select public.tr8_create_project('aa010001-0001-4000-8000-000000000001', 'different', '', '#5A67D8', 'active')$sql$, 'PT409', 'request IDs cannot be reused with a different project');
  perform pg_temp.expect_error($sql$select public.tr8_create_project('aa010002-0001-4000-8000-000000000002', 'Other owner', '', '#5A67D8', 'planning')$sql$, 'PT409', 'collision with invisible project is not returned');
  perform pg_temp.assert_true((select count(*) = 0 from public.tr8_projects where owner_id <> auth.uid()), 'owner cannot read another owner project');
  perform pg_temp.assert_true((select count(*) = 0 from public.tr8_tasks where owner_id <> auth.uid()), 'owner cannot read another owner task');
  perform pg_temp.expect_error($sql$insert into public.tr8_projects (owner_id, name) values ('ee010002-0001-4000-8000-000000000002', 'forged')$sql$, '42501', 'owner cannot create data for a different owner');
  perform pg_temp.expect_error($sql$update public.tr8_projects set owner_id = 'ee010002-0001-4000-8000-000000000002' where id = 'aa010001-0001-4000-8000-000000000001'$sql$, '42501', 'owner_id is not an updatable Data API column');
  perform pg_temp.expect_error($sql$update public.tr8_projects set version = 99 where id = 'aa010001-0001-4000-8000-000000000001'$sql$, '42501', 'versions cannot be forged directly');
  perform pg_temp.expect_error($sql$insert into public.tr8_projects (name) values ('   ')$sql$, '23514', 'blank project name rejected');
  perform pg_temp.expect_error($sql$insert into public.tr8_projects (name, color) values ('invalid', 'red')$sql$, '23514', 'non-hex color rejected');
  perform pg_temp.expect_error($sql$insert into public.tr8_projects (name, status) values ('invalid', 'risk')$sql$, '23514', 'unknown project status rejected');
  perform pg_temp.expect_error($sql$select public.tr8_update_project('aa010001-0001-4000-8000-000000000001', 1, '{"owner_id":"ee010002-0001-4000-8000-000000000002"}')$sql$, '22023', 'RPC rejects server-managed project patch keys');
  perform pg_temp.expect_error($sql$select public.tr8_update_project('aa010001-0001-4000-8000-000000000001', 1, '{"name":123}')$sql$, '22023', 'RPC rejects nonstring project names');

  v_task := public.tr8_create_task('bb010001-0001-4000-8000-000000000001', v_project.id, '  First task  ', '', 'todo', 'high', '2026-10-22', '2026-10-23');
  v_number := v_task.task_number;
  perform pg_temp.assert_true(v_task.owner_id = auth.uid() and v_task.title = 'First task' and v_task.version = 1 and v_number > 0, 'create task returns normalized row and server number');
  v_task := public.tr8_create_task(v_task.id, v_project.id, 'First task', '', 'todo', 'high', '2026-10-22', '2026-10-23');
  perform pg_temp.assert_true(v_task.task_number = v_number and v_task.version = 1 and (select count(*) = 1 from public.tr8_tasks), 'task retry preserves identity without duplicating');
  perform pg_temp.expect_error($sql$select public.tr8_create_task('bb010001-0001-4000-8000-000000000001', 'aa010001-0001-4000-8000-000000000001', 'different', '', 'todo', 'high', '2026-10-22', '2026-10-23')$sql$, 'PT409', 'task retry with different payload conflicts');
  perform pg_temp.expect_error($sql$select public.tr8_create_task(gen_random_uuid(), 'aa010002-0001-4000-8000-000000000002', 'cross-owner', '', 'todo', 'none', null, null)$sql$, '23503', 'task cannot reference another owner project');
  perform pg_temp.expect_error($sql$select public.tr8_create_task(gen_random_uuid(), 'aa010001-0001-4000-8000-000000000001', 'dates', '', 'todo', 'none', '2026-10-24', '2026-10-23')$sql$, '23514', 'inverted task dates rejected');
  perform pg_temp.expect_error($sql$select public.tr8_create_task(gen_random_uuid(), 'aa010001-0001-4000-8000-000000000001', ' ', '', 'todo', 'none', null, null)$sql$, '23514', 'blank task title rejected');
  perform pg_temp.expect_error($sql$update public.tr8_tasks set task_number = 7 where id = 'bb010001-0001-4000-8000-000000000001'$sql$, '428C9', 'identity rejects forged task numbers');
  perform pg_temp.expect_error($sql$update public.tr8_tasks set task_number = default where id = 'bb010001-0001-4000-8000-000000000001'$sql$, '42501', 'client cannot regenerate task number');
  perform pg_temp.expect_error($sql$select public.tr8_update_task('bb010001-0001-4000-8000-000000000001', 1, '{"project_id":"aa010002-0001-4000-8000-000000000002"}')$sql$, '22023', 'RPC rejects changing task parent');
  perform pg_temp.expect_error($sql$select public.tr8_update_task('bb010001-0001-4000-8000-000000000001', 1, '{"position":1.5}')$sql$, '22023', 'fractional position rejected');
  perform pg_temp.expect_error($sql$select public.tr8_update_task('bb010001-0001-4000-8000-000000000001', 1, '{"due_date":"tomorrow"}')$sql$, '22023', 'relative dates rejected');
  perform pg_temp.expect_error($sql$select public.tr8_update_task('bb010001-0001-4000-8000-000000000001', 1, '{"priority":"critical"}')$sql$, '23514', 'unknown priority rejected');
  perform pg_temp.expect_error($sql$select public.tr8_update_task('bb010001-0001-4000-8000-000000000001', 1, '{}')$sql$, '22023', 'empty task patch rejected');

  v_task := public.tr8_update_task(v_task.id, 1, '{"status":"progress","position":100,"start_date":null}');
  perform pg_temp.assert_true(v_task.version = 2 and v_task.status = 'progress' and v_task.position = 100 and v_task.start_date is null, 'task update increments version and applies nullable patch');
  perform pg_temp.expect_error($sql$select public.tr8_update_task('bb010001-0001-4000-8000-000000000001', 1, '{"title":"stale"}')$sql$, 'PT409', 'stale task update conflicts');
  perform pg_temp.expect_error($sql$select public.tr8_delete_task('bb010001-0001-4000-8000-000000000001', 1)$sql$, 'PT409', 'stale delete conflicts');
  perform pg_temp.expect_error($sql$select public.tr8_update_task('bb010002-0001-4000-8000-000000000002', 1, '{"title":"invisible"}')$sql$, 'PT404', 'invisible task cannot be updated');
  perform pg_temp.expect_error($sql$select public.tr8_delete_task('bb010002-0001-4000-8000-000000000002', 1)$sql$, 'PT404', 'invisible task cannot be deleted');

  -- A bulk workload exercises server UUID/sequence allocation and uniqueness.
  -- It is not a substitute for a separate two-connection concurrency test.
  insert into public.tr8_tasks (project_id, title)
    select v_project.id, 'allocation fixture ' || n from generate_series(1, 128) as n;
  perform pg_temp.assert_true(
    (select count(*) = 129 and count(distinct task_number) = 129 and count(distinct id) = 129 from public.tr8_tasks),
    'bulk allocation produces distinct server numbers and UUIDs');

  v_project := public.tr8_update_project(v_project.id, 1, '{"archived_at":"2026-10-22T12:00:00Z"}');
  perform pg_temp.assert_true(v_project.version = 2 and v_project.archived_at is not null, 'archival increments project version');
  perform pg_temp.expect_error($sql$select public.tr8_update_project('aa010001-0001-4000-8000-000000000001', 1, '{"name":"stale"}')$sql$, 'PT409', 'stale project update conflicts');
  perform pg_temp.expect_error($sql$select public.tr8_create_task(gen_random_uuid(), 'aa010001-0001-4000-8000-000000000001', 'archived', '', 'todo', 'none', null, null)$sql$, '55000', 'cannot create task in archived project');
  perform pg_temp.expect_error($sql$select public.tr8_update_task('bb010001-0001-4000-8000-000000000001', 2, '{"title":"archived"}')$sql$, '55000', 'cannot edit task in archived project');
  v_project := public.tr8_update_project(v_project.id, 2, '{"archived_at":null}');
  perform pg_temp.assert_true(v_project.version = 3 and v_project.archived_at is null, 'restoring project allows future task edits');
  perform public.tr8_delete_task(v_task.id, 2);
  perform pg_temp.assert_true((select count(*) = 0 from public.tr8_tasks where id = v_task.id), 'delete removes only the expected task');
  perform pg_temp.expect_error($sql$select public.tr8_delete_task('bb010001-0001-4000-8000-000000000001', 2)$sql$, 'PT404', 'repeated delete reports not found');
  perform pg_temp.expect_error('delete from public.tr8_projects', '42501', 'client archives projects instead of deleting them');
end;
$$;

reset role;
do $$
begin
  perform pg_temp.assert_true(
    (select name = 'Other owner' from public.tr8_projects where id = 'aa010002-0001-4000-8000-000000000002'),
    'other owner project is unchanged');
  perform pg_temp.assert_true(
    (select title = 'Other task' from public.tr8_tasks where id = 'bb010002-0001-4000-8000-000000000002'),
    'other owner task is unchanged');
  perform pg_temp.assert_true(
    (select coalesce(jsonb_agg(to_jsonb(p) order by id), '[]'::jsonb) from public.tr8_projects p
      where owner_id not in ('ee010001-0001-4000-8000-000000000001', 'ee010002-0001-4000-8000-000000000002'))
      = (select payload from pg_temp.tr8_test_existing_data where entity = 'projects'),
    'all pre-existing real projects retain their IDs, versions and contents');
  perform pg_temp.assert_true(
    (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]'::jsonb) from public.tr8_tasks t
      where owner_id not in ('ee010001-0001-4000-8000-000000000001', 'ee010002-0001-4000-8000-000000000002'))
      = (select payload from pg_temp.tr8_test_existing_data where entity = 'tasks'),
    'all pre-existing real tasks retain their IDs, versions and contents');
end;
$$;
select 'personal_app assertions passed' as result, current_setting('tr8.test_count')::integer as assertions;
rollback;
