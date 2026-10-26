-- TR8 stage 1 integration suite. Execute as postgres ONLY in a disposable
-- project with the stage-1 migration installed. Never execute in production.
-- All identities are synthetic, have reserved example.test addresses and no
-- password. Every fixture and flag change is rolled back. Identity sequences
-- may consume values; gaps are expected and must never be repaired with MAX+1.
-- This single-connection suite does not claim to prove concurrent behavior.
begin;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
select set_config('tr8.stage1_test_count', '0', true);
create temporary table tr8_stage1_runtime (key text primary key, value jsonb) on commit drop;
create temporary table tr8_stage1_existing on commit drop as
select 'projects'::text entity, coalesce(jsonb_agg(to_jsonb(p) order by id), '[]'::jsonb) payload
from public.tr8_workspace_projects p
union all
select 'tasks', coalesce(jsonb_agg(to_jsonb(t) order by id), '[]'::jsonb)
from public.tr8_workspace_tasks t;

create function pg_temp.assert_true(p_ok boolean, p_label text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_ok is distinct from true then
    raise exception 'Assertion failed: %', p_label;
  end if;
  perform set_config('tr8.stage1_test_count', (current_setting('tr8.stage1_test_count')::integer + 1)::text, true);
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
create function pg_temp.as_user(p_user_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user_id::text, ''), true);
  perform set_config('request.jwt.claims', case when p_user_id is null then '{}' else jsonb_build_object('sub',p_user_id,'role','authenticated','session_id',p_user_id,'user_metadata',jsonb_build_object('role','Owner','email','tr8-stage1-owner@example.test'))::text end, true);
end;
$$;
create function pg_temp.remember(p_key text, p_value jsonb)
returns void language sql security invoker set search_path = '' as $$
  insert into pg_temp.tr8_stage1_runtime(key,value) values(p_key,p_value)
  on conflict(key) do update set value=excluded.value;
$$;
create function pg_temp.recall(p_key text)
returns jsonb language sql security invoker set search_path = '' as $$
  select value from pg_temp.tr8_stage1_runtime where key=p_key;
$$;
create function pg_temp.personal_id(p_key text)
returns uuid language sql security invoker set search_path = '' as $$
  select (pg_temp.recall(p_key)->>'personal_workspace_id')::uuid;
$$;
do $$
begin
  execute format('grant usage on schema %I to anon, authenticated', pg_my_temp_schema()::regnamespace::text);
end;
$$;
grant select, insert, update on pg_temp.tr8_stage1_runtime to authenticated;
grant execute on function pg_temp.assert_true(boolean,text), pg_temp.expect_error(text,text,text),
  pg_temp.as_user(uuid), pg_temp.remember(text,jsonb), pg_temp.recall(text), pg_temp.personal_id(text)
  to anon, authenticated;

-- Auth fixtures intentionally do not include a password or send an email.
insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
 ('f1000001-0000-4000-8000-000000000001','authenticated','authenticated','tr8-stage1-owner@example.test',now(),'{}','{}',now(),now()),
 ('f1000002-0000-4000-8000-000000000002','authenticated','authenticated','tr8-stage1-other-owner@example.test',now(),'{}','{}',now(),now()),
 ('f1000003-0000-4000-8000-000000000003','authenticated','authenticated','tr8-stage1-member@example.test',now(),'{}','{}',now(),now()),
 ('f1000004-0000-4000-8000-000000000004','authenticated','authenticated','tr8-stage1-outsider@example.test',now(),'{}','{"role":"Owner","email":"tr8-stage1-owner@example.test"}',now(),now()),
 ('f1000005-0000-4000-8000-000000000005','authenticated','authenticated','tr8-stage1-unconfirmed@example.test',null,'{}','{}',now(),now()),
 ('f1000006-0000-4000-8000-000000000006','authenticated','authenticated','tr8-stage1-deleted@example.test',now(),'{}','{}',now(),now()),
 ('f1000007-0000-4000-8000-000000000007','authenticated','authenticated','tr8-stage1-invite@example.test',now(),'{}','{}',now(),now()),
 ('f1000008-0000-4000-8000-000000000008','authenticated','authenticated','tr8-stage1-other-email@example.test',now(),'{}','{}',now(),now()),
 ('f1000009-0000-4000-8000-000000000009','authenticated','authenticated','tr8-stage1-expired@example.test',now(),'{}','{}',now(),now()),
 ('f100000a-0000-4000-8000-00000000000a','authenticated','authenticated','tr8-stage1-revoked@example.test',now(),'{}','{}',now(),now()),
 ('f100000b-0000-4000-8000-00000000000b','authenticated','authenticated','tr8-stage1-issuer-lost@example.test',now(),'{}','{}',now(),now());
update auth.users set deleted_at=now() where id='f1000006-0000-4000-8000-000000000006';
-- Sessions are real fixtures; JWT/session binding is part of authorization.
insert into auth.sessions(id,user_id,created_at,updated_at)
select id,id,statement_timestamp(),statement_timestamp() from auth.users where id::text like 'f10000%';
insert into tr8_private.app_users(user_id,enabled,display_name)
values
 ('f1000001-0000-4000-8000-000000000001',true,'Synthetic owner'),
 ('f1000002-0000-4000-8000-000000000002',true,'Other synthetic owner'),
 ('f1000003-0000-4000-8000-000000000003',true,'Synthetic member'),
 ('f1000005-0000-4000-8000-000000000005',true,'Unconfirmed'),
 ('f1000006-0000-4000-8000-000000000006',true,'Deleted');

-- No historical owner-email predicate may enable an unrelated account after
-- migration. Only app_users and valid invitation acceptance authorize the app.
update tr8_private.app_config set owner_email='tr8-stage1-outsider@example.test', external_invites_enabled=false where singleton;

do $$
begin
  perform pg_temp.assert_true(to_regclass('public.tr8_projects') is null and to_regclass('public.tr8_tasks') is null,'old table endpoints are absent');
  perform pg_temp.assert_true(to_regprocedure('public.tr8_check_access()') is null,'old access RPC is absent');
  perform pg_temp.assert_true((select count(*)=0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('tr8_create_project','tr8_create_task','tr8_update_project','tr8_update_task','tr8_delete_task')),'all legacy mutation RPC endpoints are absent');
  perform pg_temp.assert_true((select count(*)=2 from pg_class where oid in ('public.tr8_workspace_projects'::regclass,'public.tr8_workspace_tasks'::regclass) and relrowsecurity),'RLS enabled on both exposed content tables');
  perform pg_temp.assert_true((select count(*)=19 from tr8_private.permission_catalog),'current permission catalogue includes the separate project.delete capability');
  perform pg_temp.assert_true((select count(*)=0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'tr8_v2_%' and p.prosecdef),'public stage-1 RPC wrappers never run as definer');
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='tr8_workspace_tasks' and column_name='assignee_member_id') then
    perform pg_temp.assert_true((select count(*)=0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('tr8_v2_create_role','tr8_v2_update_role','tr8_v2_delete_role','tr8_v2_set_member_roles','tr8_v2_set_project_access','tr8_v2_remove_project_access')),'stage-2 role and ACL mutation endpoints are not prematurely exposed');
  else
    perform pg_temp.assert_true((select count(*)=6 and not bool_or(p.prosecdef) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('tr8_v2_create_role','tr8_v2_update_role','tr8_v2_delete_role','tr8_v2_set_member_roles','tr8_v2_set_project_access','tr8_v2_remove_project_access')),'authorized stage-2 role and ACL mutation endpoints exist and remain invokers');
  end if;
end;
$$;

set local role anon;
select pg_temp.as_user(null);
do $$
begin
  perform pg_temp.expect_error('select * from public.tr8_workspace_projects','42501','anon cannot read projects');
  perform pg_temp.expect_error('select * from public.tr8_workspace_tasks','42501','anon cannot read tasks');
  perform pg_temp.expect_error('select public.tr8_v2_get_context()','42501','anon cannot request account context');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_team(gen_random_uuid(),'Forbidden')$sql$,'42501','anon cannot create a team');
end;
$$;
set local role authenticated;
do $$
begin
  perform pg_temp.expect_error('select public.tr8_v2_get_context()','42501','authenticated role without JWT subject is denied');
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_projects),'missing JWT cannot enumerate projects');
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_tasks),'missing JWT cannot enumerate tasks');
end;
$$;
select pg_temp.as_user('f1000004-0000-4000-8000-000000000004');
do $$
begin
  perform pg_temp.expect_error('select public.tr8_v2_get_context()','42501','confirmed non-enabled account with forged metadata and matching historical email remains denied');
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_projects),'non-enabled account cannot enumerate content');
  perform pg_temp.expect_error('select * from tr8_private.app_users','42501','private enablement table cannot be read');
  perform pg_temp.expect_error($sql$insert into tr8_private.app_users(user_id,enabled,display_name) values(auth.uid(),true,'Self-enabled')$sql$,'42501','account cannot enable itself');
  perform pg_temp.expect_error('update tr8_private.app_config set external_invites_enabled=true','42501','account cannot enable external invitations');
end;
$$;
select pg_temp.as_user('f1000005-0000-4000-8000-000000000005');
do $$
begin
  perform pg_temp.expect_error('select public.tr8_v2_get_context()','42501','enabled but unconfirmed account remains denied');
end;
$$;
select pg_temp.as_user('f1000006-0000-4000-8000-000000000006');
do $$
begin
  perform pg_temp.expect_error('select public.tr8_v2_get_context()','42501','soft-deleted enabled account remains denied');
end;
$$;

select pg_temp.as_user('f1000001-0000-4000-8000-000000000001');
do $$
declare
  v_context jsonb;
  v_retry jsonb;
  v_team jsonb;
begin
  v_context:=public.tr8_v2_get_context();
  perform pg_temp.remember('owner_context',v_context);
  perform pg_temp.assert_true((v_context->>'contract_version')::int=2,'context advertises contract version 2');
  perform pg_temp.assert_true((v_context->>'personal_workspace_id')::uuid is not null,'enabled owner obtains a personal workspace');
  perform pg_temp.assert_true((v_context->>'external_invites_enabled')::boolean=false,'context advertises external invitations disabled');
  perform pg_temp.assert_true(jsonb_array_length(v_context->'workspaces')=1,'new account initially has only its personal workspace');
  v_retry:=public.tr8_v2_get_context();
  perform pg_temp.assert_true(v_retry->>'personal_workspace_id'=v_context->>'personal_workspace_id','bootstrap retry retains the original personal workspace');
  v_team:=public.tr8_v2_create_team('ca100001-0000-4000-8000-000000000001','  Synthetic Team A  ');
  perform pg_temp.assert_true(v_team->>'kind'='team' and v_team->>'name'='Synthetic Team A' and (v_team->>'owner_id')::uuid=auth.uid() and (v_team->>'version')::int=1,'team creation returns normalized, server-owned version 1');
  v_retry:=public.tr8_v2_create_team('ca100001-0000-4000-8000-000000000001','Synthetic Team A');
  perform pg_temp.assert_true(v_retry=v_team,'same team ID and payload retry returns the same team');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_team('ca100001-0000-4000-8000-000000000001','Different team')$sql$,'PT409','reused team ID with different payload conflicts');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_team(gen_random_uuid(),'   ')$sql$,'22023','blank team name rejected');
  perform pg_temp.assert_true(jsonb_array_length(public.tr8_v2_get_context()->'workspaces')=2,'team appears beside the personal workspace');
  perform pg_temp.assert_true(jsonb_array_length(public.tr8_v2_list_members('ca100001-0000-4000-8000-000000000001'))=1,'new team contains exactly its protected owner');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_invitation('ca100001-0000-4000-8000-000000000001','da100001-0000-4000-8000-000000000001','tr8-stage1-invite@example.test')$sql$,'42501','external invitation creation denied while SMTP gate is disabled');
end;
$$;
select pg_temp.as_user('f1000002-0000-4000-8000-000000000002');
do $$
begin
  perform pg_temp.remember('other_context',public.tr8_v2_get_context());
  perform public.tr8_v2_create_team('ca100002-0000-4000-8000-000000000002','Synthetic Team B');
  perform pg_temp.assert_true(pg_temp.personal_id('other_context')<>pg_temp.personal_id('owner_context'),'different users obtain different personal workspaces');
  perform pg_temp.assert_true(jsonb_array_length(public.tr8_v2_get_context()->'workspaces')=2,'other owner sees only its own personal space and team');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_team('ca100001-0000-4000-8000-000000000001','Synthetic Team A')$sql$,'PT409','team idempotency does not return another owner team');
  perform pg_temp.expect_error($sql$select public.tr8_v2_list_members('ca100001-0000-4000-8000-000000000001')$sql$,'PT404','foreign team member directory unavailable');
  perform pg_temp.expect_error($sql$select public.tr8_v2_list_invitations('ca100001-0000-4000-8000-000000000001')$sql$,'PT404','foreign team invitations unavailable');
end;
$$;
select pg_temp.as_user('f1000003-0000-4000-8000-000000000003');
select pg_temp.remember('member_context',public.tr8_v2_get_context());

reset role;
do $$
declare
  v_team uuid:='ca100001-0000-4000-8000-000000000001';
begin
  perform pg_temp.assert_true((select count(*)=1 from tr8_private.workspaces where kind='personal' and owner_id='f1000001-0000-4000-8000-000000000001'),'bootstrap is backed by one durable personal workspace');
  perform pg_temp.assert_true((select count(*)=1 from tr8_private.workspace_authz_state where workspace_id=v_team),'team creates one authorization revision row');
  perform pg_temp.assert_true((select count(*)=3 from tr8_private.workspace_roles where workspace_id=v_team),'team creates exactly three role templates once');
  perform pg_temp.assert_true((select count(*)=3 from tr8_private.role_permissions p join tr8_private.workspace_roles r on r.id=p.role_id and r.workspace_id=p.workspace_id where r.workspace_id=v_team and r.template_key='read' and p.permission in ('member.read','project.read','task.read')) and (select count(*)=3 from tr8_private.role_permissions p join tr8_private.workspace_roles r on r.id=p.role_id and r.workspace_id=p.workspace_id where r.workspace_id=v_team and r.template_key='read'),'read role starts with exactly the agreed three permissions');
  perform pg_temp.assert_true((select count(*)=8 from tr8_private.role_permissions p join tr8_private.workspace_roles r on r.id=p.role_id and r.workspace_id=p.workspace_id where r.workspace_id=v_team and r.template_key='collaborator' and p.permission in ('member.read','project.read','task.read','project.create','project.edit','task.create','task.edit','task.assign')) and (select count(*)=8 from tr8_private.role_permissions p join tr8_private.workspace_roles r on r.id=p.role_id and r.workspace_id=p.workspace_id where r.workspace_id=v_team and r.template_key='collaborator'),'collaborator role starts with exactly the agreed eight permissions');
  perform pg_temp.assert_true((select count(*)=19 from tr8_private.role_permissions p join tr8_private.workspace_roles r on r.id=p.role_id and r.workspace_id=p.workspace_id where r.workspace_id=v_team and r.template_key='admin'),'new administration template starts with all 19 current permissions');
  perform pg_temp.assert_true((select count(*)=0 from tr8_private.member_roles r join tr8_private.workspace_members m on m.id=r.member_id and m.workspace_id=r.workspace_id where m.workspace_id=v_team and m.user_id='f1000001-0000-4000-8000-000000000001'),'protected owner does not depend on a mutable admin-role assignment');
  perform pg_temp.assert_true((select count(*)=0 from tr8_private.invitations where id='da100001-0000-4000-8000-000000000001'),'disabled invitation attempt leaves no invitation row');
end;
$$;

-- CRUD through the same public API the browser uses. Stable IDs, versioned
-- patches and archived-project behavior must survive the workspace migration.
set local role authenticated;
select pg_temp.as_user('f1000001-0000-4000-8000-000000000001');
do $$
declare
  v_personal uuid:=pg_temp.personal_id('owner_context');
  v_project jsonb;
  v_task jsonb;
  v_retry jsonb;
begin
  v_project:=to_jsonb(public.tr8_v2_create_project(v_personal,'aa100001-0000-4000-8000-000000000001','  Personal fixture  ','Description','#5A67D8','active'));
  perform pg_temp.assert_true(v_project->>'name'='Personal fixture' and (v_project->>'workspace_id')::uuid=v_personal and (v_project->>'owner_id')::uuid=auth.uid() and (v_project->>'version')::int=1,'personal project preserves normalization, provenance and version');
  v_retry:=to_jsonb(public.tr8_v2_create_project(v_personal,'aa100001-0000-4000-8000-000000000001','Personal fixture','Description','#5A67D8','active'));
  perform pg_temp.assert_true(v_retry=v_project,'project retry preserves all fields without a second row');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_project(pg_temp.personal_id('owner_context'),'aa100001-0000-4000-8000-000000000001','Different','Description','#5A67D8','active')$sql$,'PT409','project request reuse with different payload conflicts');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_project(pg_temp.personal_id('other_context'),gen_random_uuid(),'Foreign','','#5A67D8','active')$sql$,'PT404','cannot create in another user personal workspace');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_project(pg_temp.personal_id('owner_context'),gen_random_uuid(),'   ','','#5A67D8','active')$sql$,'23514','blank project name rejected');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_project(pg_temp.personal_id('owner_context'),gen_random_uuid(),'Color','','red','active')$sql$,'23514','invalid project color rejected');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_project(pg_temp.personal_id('owner_context'),'aa100001-0000-4000-8000-000000000001',1,'{"workspace_id":"ca100001-0000-4000-8000-000000000001"}')$sql$,'22023','project patch cannot change workspace');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_project(pg_temp.personal_id('owner_context'),'aa100001-0000-4000-8000-000000000001',1,'{"owner_id":"f1000002-0000-4000-8000-000000000002"}')$sql$,'22023','project patch cannot forge provenance');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_project(pg_temp.personal_id('owner_context'),'aa100001-0000-4000-8000-000000000001',1,'{"version":999}')$sql$,'22023','project patch cannot forge version');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_project('ca100001-0000-4000-8000-000000000001','aa100001-0000-4000-8000-000000000001',1,'{"name":"Wrong scope"}')$sql$,'PT404','owned project still cannot be edited with the wrong workspace');
  v_task:=to_jsonb(public.tr8_v2_create_task(v_personal,'bb100001-0000-4000-8000-000000000001','aa100001-0000-4000-8000-000000000001','  Personal task  ','Description','todo','high','2026-10-23','2026-10-24'));
  perform pg_temp.remember('personal_task',v_task);
  perform pg_temp.assert_true(v_task->>'title'='Personal task' and (v_task->>'workspace_id')::uuid=v_personal and (v_task->>'task_number')::bigint>0 and (v_task->>'version')::int=1,'task creation returns normalized title, workspace and server number');
  v_retry:=to_jsonb(public.tr8_v2_create_task(v_personal,'bb100001-0000-4000-8000-000000000001','aa100001-0000-4000-8000-000000000001','Personal task','Description','todo','high','2026-10-23','2026-10-24'));
  perform pg_temp.assert_true(v_retry=v_task,'task retry retains UUID, number, times and version');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_task(pg_temp.personal_id('owner_context'),'bb100001-0000-4000-8000-000000000001','aa100001-0000-4000-8000-000000000001','Different','Description','todo','high','2026-10-23','2026-10-24')$sql$,'PT409','task ID cannot be reused for different content');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_task('ca100001-0000-4000-8000-000000000001',gen_random_uuid(),'aa100001-0000-4000-8000-000000000001','Wrong scope','','todo','none',null,null)$sql$,'PT404','task cannot cross workspace and project scopes');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_task(pg_temp.personal_id('owner_context'),gen_random_uuid(),'aa100001-0000-4000-8000-000000000001','   ','','todo','none',null,null)$sql$,'23514','blank task title rejected');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_task(pg_temp.personal_id('owner_context'),gen_random_uuid(),'aa100001-0000-4000-8000-000000000001','Dates','','todo','none','2026-10-25','2026-10-24')$sql$,'23514','inverted task dates rejected');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_task(pg_temp.personal_id('owner_context'),'bb100001-0000-4000-8000-000000000001',1,'{"project_id":"aa100099-0000-4000-8000-000000000099"}')$sql$,'22023','task patch cannot change parent');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_task(pg_temp.personal_id('owner_context'),'bb100001-0000-4000-8000-000000000001',1,'{"position":1.5}')$sql$,'22023','fractional position rejected');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_task(pg_temp.personal_id('owner_context'),'bb100001-0000-4000-8000-000000000001',1,'{"due_date":"tomorrow"}')$sql$,'22023','relative date rejected');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_task(pg_temp.personal_id('owner_context'),'bb100001-0000-4000-8000-000000000001',1,'{}')$sql$,'22023','empty task patch rejected');
  v_task:=to_jsonb(public.tr8_v2_update_task(v_personal,'bb100001-0000-4000-8000-000000000001',1,'{"status":"progress","position":123,"start_date":null}'));
  perform pg_temp.assert_true((v_task->>'version')::int=2 and v_task->>'status'='progress' and (v_task->>'position')::int=123 and v_task->'start_date'='null'::jsonb,'versioned task update supports nullable fields');
  perform pg_temp.assert_true(v_task->>'task_number'=pg_temp.recall('personal_task')->>'task_number' and v_task->>'created_at'=pg_temp.recall('personal_task')->>'created_at','ordinary update preserves server number and creation time');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_task(pg_temp.personal_id('owner_context'),'bb100001-0000-4000-8000-000000000001',1,'{"title":"Stale"}')$sql$,'PT409','stale task update rejected');
  perform pg_temp.expect_error($sql$select public.tr8_v2_delete_task(pg_temp.personal_id('owner_context'),'bb100001-0000-4000-8000-000000000001',1)$sql$,'PT409','stale task delete rejected');
  v_project:=to_jsonb(public.tr8_v2_update_project(v_personal,'aa100001-0000-4000-8000-000000000001',1,'{"archived_at":"2026-10-23T12:00:00Z"}'));
  perform pg_temp.assert_true((v_project->>'version')::int=2 and v_project->>'archived_at' is not null,'archive remains a versioned operation');
  perform pg_temp.assert_true((select count(*)=1 from public.tr8_workspace_tasks where id='bb100001-0000-4000-8000-000000000001'),'archive preserves readable tasks');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_task(pg_temp.personal_id('owner_context'),gen_random_uuid(),'aa100001-0000-4000-8000-000000000001','Archived','','todo','none',null,null)$sql$,'PT409','archived project rejects new tasks');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_task(pg_temp.personal_id('owner_context'),'bb100001-0000-4000-8000-000000000001',2,'{"title":"Archived"}')$sql$,'PT409','archived project rejects task edits');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_project(pg_temp.personal_id('owner_context'),'aa100001-0000-4000-8000-000000000001',1,'{"name":"Stale"}')$sql$,'PT409','stale project update rejected');
  v_project:=to_jsonb(public.tr8_v2_update_project(v_personal,'aa100001-0000-4000-8000-000000000001',2,'{"archived_at":null}'));
  perform pg_temp.assert_true((v_project->>'version')::int=3 and v_project->'archived_at'='null'::jsonb,'restoration preserves the project and advances version');
  perform public.tr8_v2_delete_task(v_personal,'bb100001-0000-4000-8000-000000000001',2);
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_tasks where id='bb100001-0000-4000-8000-000000000001'),'valid delete removes the intended task');
  perform pg_temp.expect_error($sql$select public.tr8_v2_delete_task(pg_temp.personal_id('owner_context'),'bb100001-0000-4000-8000-000000000001',2)$sql$,'PT404','repeated delete reports resource unavailable');
end;
$$;

-- Team-private data and independent personal data for RLS/IDOR checks.
do $$
begin
  perform public.tr8_v2_create_project('ca100001-0000-4000-8000-000000000001','aa100002-0000-4000-8000-000000000002','Team A private','','#5A67D8','active');
  perform public.tr8_v2_create_project('ca100001-0000-4000-8000-000000000001','aa100004-0000-4000-8000-000000000004','Team A second private','','#5A67D8','active');
  perform public.tr8_v2_create_task('ca100001-0000-4000-8000-000000000001','bb100002-0000-4000-8000-000000000002','aa100002-0000-4000-8000-000000000002','Team A task','','todo','none',null,null);
end;
$$;
select pg_temp.as_user('f1000002-0000-4000-8000-000000000002');
do $$
begin
  perform public.tr8_v2_create_project('ca100002-0000-4000-8000-000000000002','aa100003-0000-4000-8000-000000000003','Team B private','','#5A67D8','active');
  perform public.tr8_v2_create_task('ca100002-0000-4000-8000-000000000002','bb100003-0000-4000-8000-000000000003','aa100003-0000-4000-8000-000000000003','Team B task','','todo','none',null,null);
  perform public.tr8_v2_create_project(pg_temp.personal_id('other_context'),'aa100005-0000-4000-8000-000000000005','Other personal private','','#5A67D8','active');
end;
$$;
reset role;
insert into tr8_private.workspace_members(id,workspace_id,user_id,status)
values('ca200001-0000-4000-8000-000000000001','ca100001-0000-4000-8000-000000000001','f1000003-0000-4000-8000-000000000003','active');
insert into tr8_private.member_roles(workspace_id,member_id,role_id)
select workspace_id,'ca200001-0000-4000-8000-000000000001',id from tr8_private.workspace_roles
where workspace_id='ca100001-0000-4000-8000-000000000001' and template_key='admin';

set local role authenticated;
select pg_temp.as_user('f1000001-0000-4000-8000-000000000001');
do $$
begin
  perform pg_temp.assert_true((select count(*)=2 from public.tr8_workspace_projects where workspace_id='ca100001-0000-4000-8000-000000000001'),'team owner reads all its projects without explicit ACL');
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_projects where workspace_id='ca100002-0000-4000-8000-000000000002'),'team ownership does not open another team');
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_projects where workspace_id=pg_temp.personal_id('other_context')),'team ownership does not open another personal workspace');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_project('ca100002-0000-4000-8000-000000000002','aa100003-0000-4000-8000-000000000003',1,'{"name":"Foreign"}')$sql$,'PT404','direct RPC cannot edit a foreign team project');
  perform pg_temp.expect_error($sql$select public.tr8_v2_delete_task('ca100002-0000-4000-8000-000000000002','bb100003-0000-4000-8000-000000000003',1)$sql$,'PT404','direct RPC cannot delete a foreign team task');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_project('ca100002-0000-4000-8000-000000000002','aa100003-0000-4000-8000-000000000003','Team B private','','#5A67D8','active')$sql$,'PT404','idempotent create cannot retrieve a foreign project');
end;
$$;
select pg_temp.as_user('f1000003-0000-4000-8000-000000000003');
do $$
begin
  perform pg_temp.assert_true(jsonb_array_length(public.tr8_v2_get_context()->'workspaces')=2,'active member sees its own personal workspace and joined team');
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_projects where workspace_id='ca100001-0000-4000-8000-000000000001'),'administrator without project ACL cannot enumerate private projects');
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_tasks),'administrator without ACL cannot enumerate task contents');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_task('ca100001-0000-4000-8000-000000000001','bb100002-0000-4000-8000-000000000002',1,'{"title":"No ACL"}')$sql$,'PT404','admin role alone cannot edit a private task by UUID');
end;
$$;
reset role;
insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level)
values('ca100001-0000-4000-8000-000000000001','aa100002-0000-4000-8000-000000000002','ca200001-0000-4000-8000-000000000001','read');
set local role authenticated;
do $$
begin
  perform pg_temp.assert_true((select count(*)=1 from public.tr8_workspace_projects where workspace_id='ca100001-0000-4000-8000-000000000001'),'explicit read ACL opens exactly one private project');
  perform pg_temp.assert_true((select count(*)=1 from public.tr8_workspace_tasks where id='bb100002-0000-4000-8000-000000000002'),'explicit read ACL opens that project tasks');
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_projects where id='aa100004-0000-4000-8000-000000000004'),'ACL on one project does not open its sibling');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_task('ca100001-0000-4000-8000-000000000001','bb100002-0000-4000-8000-000000000002',1,'{"title":"Read ACL"}')$sql$,'PT404','read ACL cannot edit even with administrator permissions');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_project('ca100001-0000-4000-8000-000000000001','aa100002-0000-4000-8000-000000000002',1,'{"name":"Read ACL"}')$sql$,'PT404','read ACL cannot edit project metadata');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_task('ca100001-0000-4000-8000-000000000001',gen_random_uuid(),'aa100002-0000-4000-8000-000000000002','Read ACL','','todo','none',null,null)$sql$,'PT404','read ACL cannot create tasks');
end;
$$;
reset role;
update tr8_private.project_access set access_level='write' where workspace_id='ca100001-0000-4000-8000-000000000001' and member_id='ca200001-0000-4000-8000-000000000001';
set local role authenticated;
do $$
declare v_task jsonb;
begin
  v_task:=to_jsonb(public.tr8_v2_update_task('ca100001-0000-4000-8000-000000000001','bb100002-0000-4000-8000-000000000002',1,'{"title":"Authorized team edit"}'));
  perform pg_temp.assert_true((v_task->>'version')::int=2 and v_task->>'title'='Authorized team edit','write ACL plus role permits a versioned task edit');
end;
$$;
reset role;
delete from tr8_private.member_roles where workspace_id='ca100001-0000-4000-8000-000000000001' and member_id='ca200001-0000-4000-8000-000000000001';
set local role authenticated;
do $$
begin
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_projects),'ACL without roles does not grant project read');
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_tasks),'ACL without task.read does not grant task read');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_task('ca100001-0000-4000-8000-000000000001','bb100002-0000-4000-8000-000000000002',2,'{"title":"No role"}')$sql$,'PT404','write ACL alone cannot edit');
end;
$$;
reset role;
insert into tr8_private.member_roles(workspace_id,member_id,role_id)
select workspace_id,'ca200001-0000-4000-8000-000000000001',id from tr8_private.workspace_roles
where workspace_id='ca100001-0000-4000-8000-000000000001' and template_key='read';
set local role authenticated;
do $$
begin
  perform pg_temp.assert_true((select count(*)=1 from public.tr8_workspace_tasks),'read role and explicit ACL restore only authorized task visibility');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_task('ca100001-0000-4000-8000-000000000001','bb100002-0000-4000-8000-000000000002',2,'{"title":"Read role"}')$sql$,'PT404','read role remains unable to edit despite write ACL');
end;
$$;
reset role;
-- Add a minimal second fixture role to prove additive permissions, rather than
-- silently relying on a role name or a magic administrator flag.
insert into tr8_private.workspace_roles(id,workspace_id,name,template_key)
values('ca300001-0000-4000-8000-000000000001','ca100001-0000-4000-8000-000000000001','Synthetic task editor',null);
insert into tr8_private.role_permissions(workspace_id,role_id,permission)
values('ca100001-0000-4000-8000-000000000001','ca300001-0000-4000-8000-000000000001','task.edit');
insert into tr8_private.member_roles(workspace_id,member_id,role_id)
values('ca100001-0000-4000-8000-000000000001','ca200001-0000-4000-8000-000000000001','ca300001-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_task jsonb;
begin
  v_task:=to_jsonb(public.tr8_v2_update_task('ca100001-0000-4000-8000-000000000001','bb100002-0000-4000-8000-000000000002',2,'{"status":"progress"}'));
  perform pg_temp.assert_true((v_task->>'version')::int=3 and v_task->>'status'='progress','two role permission sets are combined for an authorized edit');
  perform pg_temp.expect_error($sql$select public.tr8_v2_delete_task('ca100001-0000-4000-8000-000000000001','bb100002-0000-4000-8000-000000000002',3)$sql$,'PT404','additive task.edit does not imply task.delete');
end;
$$;
reset role;
update tr8_private.workspace_members set status='removed' where id='ca200001-0000-4000-8000-000000000001';
set local role authenticated;
do $$
begin
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_projects),'removed member loses project visibility even if roles and ACL remain');
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_tasks),'removed member loses task visibility');
  perform pg_temp.expect_error($sql$select public.tr8_v2_update_task('ca100001-0000-4000-8000-000000000001','bb100002-0000-4000-8000-000000000002',3,'{"title":"Revoked"}')$sql$,'PT404','revoked member cannot perform a previously authorized edit');
  perform pg_temp.assert_true(jsonb_array_length(public.tr8_v2_get_context()->'workspaces')=1,'removed team is absent from current context');
end;
$$;

-- Structural integrity also rejects cross-team IDs under trusted fixture DML.
-- If an RPC validation regresses later, the database still rejects bad links.
reset role;
do $$
begin
  perform pg_temp.expect_error($sql$insert into tr8_private.member_roles(workspace_id,member_id,role_id) select 'ca100002-0000-4000-8000-000000000002','ca200001-0000-4000-8000-000000000001',id from tr8_private.workspace_roles where workspace_id='ca100002-0000-4000-8000-000000000002' and template_key='read'$sql$,'23503','composite FK rejects a member from another team');
  perform pg_temp.expect_error($sql$insert into tr8_private.member_roles(workspace_id,member_id,role_id) select 'ca100001-0000-4000-8000-000000000001','ca200001-0000-4000-8000-000000000001',id from tr8_private.workspace_roles where workspace_id='ca100002-0000-4000-8000-000000000002' and template_key='read'$sql$,'23503','composite FK rejects a role from another team');
  perform pg_temp.expect_error($sql$insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level) values('ca100001-0000-4000-8000-000000000001','aa100003-0000-4000-8000-000000000003','ca200001-0000-4000-8000-000000000001','read')$sql$,'23503','composite FK rejects a project from another team');
  perform pg_temp.expect_error($sql$update public.tr8_workspace_tasks set workspace_id='ca100002-0000-4000-8000-000000000002' where id='bb100002-0000-4000-8000-000000000002'$sql$,'22023','task guard rejects workspace tampering before changing its parent');
  perform pg_temp.assert_true((select count(*)=1 from pg_constraint where conrelid='public.tr8_workspace_tasks'::regclass and confrelid='public.tr8_workspace_projects'::regclass and contype='f' and cardinality(conkey)=2),'task parent additionally has a composite workspace/project foreign key');
end;
$$;

-- All client bypasses stay closed, including historical column grants and
-- sequence access. Grant introspection plus actual DML cover different paths.
set local role authenticated;
select pg_temp.as_user('f1000001-0000-4000-8000-000000000001');
do $$
declare v_sequence text;
begin
  perform pg_temp.expect_error($sql$insert into public.tr8_workspace_projects(workspace_id,name) values(pg_temp.personal_id('owner_context'),'Bypass')$sql$,'42501','even the owner cannot insert a project directly');
  perform pg_temp.expect_error($sql$update public.tr8_workspace_projects set name='Bypass' where id='aa100001-0000-4000-8000-000000000001'$sql$,'42501','historical project-name column grant is revoked');
  perform pg_temp.expect_error($sql$update public.tr8_workspace_projects set version=99 where id='aa100001-0000-4000-8000-000000000001'$sql$,'42501','owner cannot forge a project version directly');
  perform pg_temp.expect_error($sql$delete from public.tr8_workspace_projects where id='aa100001-0000-4000-8000-000000000001'$sql$,'42501','owner cannot delete projects directly');
  perform pg_temp.expect_error($sql$insert into public.tr8_workspace_tasks(workspace_id,project_id,title) values('ca100001-0000-4000-8000-000000000001','aa100002-0000-4000-8000-000000000002','Bypass')$sql$,'42501','owner cannot insert tasks directly');
  perform pg_temp.expect_error($sql$update public.tr8_workspace_tasks set title='Bypass' where id='bb100002-0000-4000-8000-000000000002'$sql$,'42501','historical task-title column grant is revoked');
  perform pg_temp.expect_error($sql$delete from public.tr8_workspace_tasks where id='bb100002-0000-4000-8000-000000000002'$sql$,'42501','owner cannot delete tasks directly');
  perform pg_temp.expect_error($sql$select tr8_private.v2_ensure_personal('f1000002-0000-4000-8000-000000000002')$sql$,'42501','private personal bootstrap cannot be called for another actor');
  perform pg_temp.expect_error($sql$select tr8_private.v2_permissions_for('ca100002-0000-4000-8000-000000000002','f1000002-0000-4000-8000-000000000002')$sql$,'42501','arbitrary-user authorization helper cannot enumerate another actor permissions');
  perform pg_temp.expect_error('select * from tr8_private.workspace_activity','42501','private administrative activity cannot be read without an authorized API');
  v_sequence:=pg_get_serial_sequence('public.tr8_workspace_tasks','task_number');
  perform pg_temp.assert_true(v_sequence is not null,'task numbering still uses the original identity sequence');
  perform pg_temp.expect_error(format('select nextval(%L::regclass)',v_sequence),'42501','owner has no direct sequence allocation privilege');
  perform pg_temp.assert_true(not has_any_column_privilege('authenticated','public.tr8_workspace_projects','INSERT,UPDATE,REFERENCES'),'no project column retains an authenticated write grant');
  perform pg_temp.assert_true(not has_any_column_privilege('authenticated','public.tr8_workspace_tasks','INSERT,UPDATE,REFERENCES'),'no task column retains an authenticated write grant');
end;
$$;

-- External onboarding is enabled solely inside this rolled-back test fixture.
-- Production remains disabled until an approved mail channel exists.
reset role;
update tr8_private.app_config set external_invites_enabled=true where singleton;
set local role authenticated;
select pg_temp.as_user('f1000001-0000-4000-8000-000000000001');
do $$
declare v_invite jsonb; v_retry jsonb; v_listing jsonb;
begin
  v_invite:=public.tr8_v2_create_invitation('ca100001-0000-4000-8000-000000000001','da100001-0000-4000-8000-000000000001','  TR8-STAGE1-INVITE@EXAMPLE.TEST  ');
  perform pg_temp.remember('invite',v_invite);
  perform pg_temp.assert_true(length(v_invite->>'token')=64 and v_invite->>'status'='pending' and (v_invite->>'version')::int=1,'new invitation returns a one-time high-entropy token and pending version');
  v_retry:=public.tr8_v2_create_invitation('ca100001-0000-4000-8000-000000000001','da100001-0000-4000-8000-000000000001','tr8-stage1-invite@example.test');
  perform pg_temp.assert_true(v_retry->'token'='null'::jsonb and v_retry->>'id'=v_invite->>'id' and (v_retry->>'version')::int=1,'invitation retry neither duplicates nor recovers the original token');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_invitation('ca100001-0000-4000-8000-000000000001','da100001-0000-4000-8000-000000000001','different@example.test')$sql$,'PT409','invitation ID cannot be rebound to another email');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_invitation('ca100001-0000-4000-8000-000000000001',gen_random_uuid(),'invalid-email')$sql$,'22023','malformed invitation address rejected');
  perform pg_temp.remember('expired_invite',public.tr8_v2_create_invitation('ca100001-0000-4000-8000-000000000001','da100009-0000-4000-8000-000000000009','tr8-stage1-expired@example.test'));
  perform pg_temp.remember('revoked_invite',public.tr8_v2_create_invitation('ca100001-0000-4000-8000-000000000001','da10000a-0000-4000-8000-00000000000a','tr8-stage1-revoked@example.test'));
  perform pg_temp.remember('issuer_invite',public.tr8_v2_create_invitation('ca100001-0000-4000-8000-000000000001','da10000b-0000-4000-8000-00000000000b','tr8-stage1-issuer-lost@example.test'));
  v_retry:=public.tr8_v2_revoke_invitation('ca100001-0000-4000-8000-000000000001','da10000a-0000-4000-8000-00000000000a',1);
  perform pg_temp.assert_true(v_retry->>'status'='revoked' and (v_retry->>'version')::int=2,'revoke changes the invitation state and increments its version');
  perform pg_temp.expect_error($sql$select public.tr8_v2_revoke_invitation('ca100001-0000-4000-8000-000000000001','da10000a-0000-4000-8000-00000000000a',1)$sql$,'PT409','stale invitation revoke rejected');
  perform pg_temp.expect_error($sql$select public.tr8_v2_revoke_invitation('ca100001-0000-4000-8000-000000000001','da100001-0000-4000-8000-000000000001',99)$sql$,'PT409','wrong expected version cannot revoke pending invitation');
  v_listing:=public.tr8_v2_list_invitations('ca100001-0000-4000-8000-000000000001');
  perform pg_temp.assert_true(jsonb_array_length(v_listing)=4,'owner can list its four issued invitations');
  perform pg_temp.assert_true(not jsonb_path_exists(v_listing,'$[*].token') and not jsonb_path_exists(v_listing,'$[*].token_hash'),'invitation listing never exposes tokens or digests');
  perform pg_temp.assert_true(not jsonb_path_exists(public.tr8_v2_list_members('ca100001-0000-4000-8000-000000000001'),'$[*].email'),'member directory never exposes private email addresses');
end;
$$;
reset role;
update tr8_private.invitations set expires_at=statement_timestamp()-interval '1 second' where id='da100009-0000-4000-8000-000000000009';
do $$
begin
  perform pg_temp.assert_true((select email='tr8-stage1-invite@example.test' and token_hash=encode(sha256(convert_to(pg_temp.recall('invite')->>'token','UTF8')),'hex') and token_hash<>pg_temp.recall('invite')->>'token' from tr8_private.invitations where id='da100001-0000-4000-8000-000000000001'),'only normalized email and token digest are stored durably');
  perform pg_temp.assert_true((select r.template_key='read' from tr8_private.invitations i join tr8_private.workspace_roles r on r.workspace_id=i.workspace_id and r.id=i.role_id where i.id='da100001-0000-4000-8000-000000000001'),'invitation proposes the read template without implicit administration');
end;
$$;
set local role authenticated;
select pg_temp.as_user('f1000008-0000-4000-8000-000000000008');
do $$
begin
  perform pg_temp.expect_error($sql$select public.tr8_v2_accept_invitation(pg_temp.recall('invite')->>'token')$sql$,'42501','forwarded token cannot be accepted by another email');
  perform pg_temp.expect_error($sql$select public.tr8_v2_accept_invitation('invalid-token')$sql$,'42501','malformed token denied');
end;
$$;
select pg_temp.as_user('f1000005-0000-4000-8000-000000000005');
do $$
begin
  perform pg_temp.expect_error($sql$select public.tr8_v2_accept_invitation(pg_temp.recall('invite')->>'token')$sql$,'42501','unconfirmed account cannot accept an invitation');
end;
$$;
select pg_temp.as_user('f1000009-0000-4000-8000-000000000009');
do $$
begin
  perform pg_temp.expect_error($sql$select public.tr8_v2_accept_invitation(pg_temp.recall('expired_invite')->>'token')$sql$,'42501','expired token denied even for its confirmed recipient');
end;
$$;
select pg_temp.as_user('f100000a-0000-4000-8000-00000000000a');
do $$
begin
  perform pg_temp.expect_error($sql$select public.tr8_v2_accept_invitation(pg_temp.recall('revoked_invite')->>'token')$sql$,'42501','revoked token denied for its confirmed recipient');
end;
$$;
reset role;
update tr8_private.app_users set enabled=false where user_id='f1000001-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.as_user('f100000b-0000-4000-8000-00000000000b');
do $$
begin
  perform pg_temp.expect_error($sql$select public.tr8_v2_accept_invitation(pg_temp.recall('issuer_invite')->>'token')$sql$,'42501','issuer losing application privileges invalidates pending acceptance');
end;
$$;
reset role;
update tr8_private.app_users set enabled=true where user_id='f1000001-0000-4000-8000-000000000001';
do $$
begin
  perform pg_temp.assert_true((select count(*)=0 from tr8_private.app_users where user_id in ('f1000007-0000-4000-8000-000000000007','f1000008-0000-4000-8000-000000000008','f1000009-0000-4000-8000-000000000009','f100000a-0000-4000-8000-00000000000a','f100000b-0000-4000-8000-00000000000b')),'all failed acceptance paths leave recipients unapproved');
  perform pg_temp.assert_true((select count(*)=0 from tr8_private.workspaces where owner_id in ('f1000007-0000-4000-8000-000000000007','f1000008-0000-4000-8000-000000000008','f1000009-0000-4000-8000-000000000009','f100000a-0000-4000-8000-00000000000a','f100000b-0000-4000-8000-00000000000b')),'failed acceptance never leaves a partial personal workspace');
end;
$$;
update tr8_private.app_config set external_invites_enabled=false where singleton;
set local role authenticated;
select pg_temp.as_user('f1000007-0000-4000-8000-000000000007');
do $$
begin
  perform pg_temp.expect_error($sql$select public.tr8_v2_accept_invitation(pg_temp.recall('invite')->>'token')$sql$,'42501','disabled external gate also blocks acceptance of a previously issued token');
end;
$$;
reset role;
update tr8_private.app_config set external_invites_enabled=true where singleton;
set local role authenticated;
do $$
declare v_result jsonb; v_retry jsonb; v_personal uuid; v_project jsonb;
begin
  v_result:=public.tr8_v2_accept_invitation(pg_temp.recall('invite')->>'token');
  perform pg_temp.remember('accepted',v_result);
  perform pg_temp.assert_true(v_result->>'status'='accepted' and (v_result->>'workspace_id')::uuid='ca100001-0000-4000-8000-000000000001' and (v_result->>'member_id')::uuid is not null,'valid acceptance returns a durable team membership');
  v_retry:=public.tr8_v2_accept_invitation(pg_temp.recall('invite')->>'token');
  perform pg_temp.assert_true(v_retry=v_result,'same recipient acceptance retry returns the same membership');
  perform pg_temp.remember('invited_context',public.tr8_v2_get_context());
  v_personal:=pg_temp.personal_id('invited_context');
  perform pg_temp.assert_true(v_personal<>pg_temp.personal_id('owner_context') and v_personal<>pg_temp.personal_id('other_context'),'accepted user owns an independent personal workspace');
  perform pg_temp.assert_true(jsonb_array_length(pg_temp.recall('invited_context')->'workspaces')=2,'acceptance exposes only recipient personal space and invited team');
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_projects),'acceptance alone grants no private project content');
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_tasks),'acceptance alone grants no private task content');
  perform pg_temp.expect_error($sql$select public.tr8_v2_create_project('ca100001-0000-4000-8000-000000000001',gen_random_uuid(),'Read invite','','#5A67D8','active')$sql$,'PT404','default read invitation does not grant project creation');
  perform pg_temp.expect_error($sql$select public.tr8_v2_list_invitations('ca100001-0000-4000-8000-000000000001')$sql$,'PT404','ordinary accepted member cannot list invitation addresses');
  v_project:=to_jsonb(public.tr8_v2_create_project(v_personal,'aa100007-0000-4000-8000-000000000007','Invited personal project','','#5A67D8','active'));
  perform pg_temp.assert_true((v_project->>'owner_id')::uuid=auth.uid() and (v_project->>'workspace_id')::uuid=v_personal,'accepted user has normal ownership in its own personal workspace');
end;
$$;
reset role;
do $$
begin
  perform pg_temp.assert_true((select count(*)=1 from tr8_private.app_users where user_id='f1000007-0000-4000-8000-000000000007' and enabled),'acceptance enabled exactly one recipient');
  perform pg_temp.assert_true((select count(*)=1 from tr8_private.workspaces where kind='personal' and owner_id='f1000007-0000-4000-8000-000000000007'),'acceptance and context retries create one personal workspace');
  perform pg_temp.assert_true((select count(*)=1 from tr8_private.workspace_members where workspace_id='ca100001-0000-4000-8000-000000000001' and user_id='f1000007-0000-4000-8000-000000000007' and status='active'),'acceptance retries create exactly one active membership');
  perform pg_temp.assert_true((select count(*)=1 from tr8_private.member_roles mr join tr8_private.workspace_roles r on r.workspace_id=mr.workspace_id and r.id=mr.role_id where mr.member_id=(pg_temp.recall('accepted')->>'member_id')::uuid and r.template_key='read'),'acceptance retries create exactly one read-role assignment');
  perform pg_temp.assert_true((select count(*)=0 from tr8_private.project_access where member_id=(pg_temp.recall('accepted')->>'member_id')::uuid),'acceptance creates no implicit project ACL');
  perform pg_temp.assert_true((select status='accepted' and version=2 and accepted_by='f1000007-0000-4000-8000-000000000007' and accepted_at is not null from tr8_private.invitations where id='da100001-0000-4000-8000-000000000001'),'token consumption and membership are recorded together exactly once');
  perform pg_temp.assert_true((select count(*)=1 from tr8_private.workspace_activity where action='invitation.accepted' and resource_id='da100001-0000-4000-8000-000000000001'),'idempotent acceptance emits one activity event');
end;
$$;
set local role authenticated;
select pg_temp.as_user('f1000008-0000-4000-8000-000000000008');
do $$
begin
  perform pg_temp.expect_error($sql$select public.tr8_v2_accept_invitation(pg_temp.recall('invite')->>'token')$sql$,'42501','another account cannot reuse a consumed token');
end;
$$;
select pg_temp.as_user('f1000001-0000-4000-8000-000000000001');
do $$
begin
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_projects where id='aa100007-0000-4000-8000-000000000007'),'team owner cannot read accepted member personal data');
end;
$$;
reset role;
update tr8_private.app_users set enabled=false where user_id='f1000007-0000-4000-8000-000000000007';
set local role authenticated;
select pg_temp.as_user('f1000007-0000-4000-8000-000000000007');
do $$
begin
  perform pg_temp.expect_error($sql$select public.tr8_v2_accept_invitation(pg_temp.recall('invite')->>'token')$sql$,'42501','accepted token never re-enables an administratively disabled account');
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_projects),'disabled account immediately loses its personal data access despite unchanged JWT');
end;
$$;
reset role;
update tr8_private.app_users set enabled=true where user_id='f1000007-0000-4000-8000-000000000007';
update tr8_private.workspace_members set status='removed' where id=(pg_temp.recall('accepted')->>'member_id')::uuid;
set local role authenticated;
do $$
begin
  perform pg_temp.expect_error($sql$select public.tr8_v2_accept_invitation(pg_temp.recall('invite')->>'token')$sql$,'42501','consumed token cannot restore a removed team membership');
end;
$$;

reset role;
update tr8_private.app_config set external_invites_enabled=false where singleton;
update auth.users set banned_until=statement_timestamp()+interval '1 hour' where id='f1000001-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.as_user('f1000001-0000-4000-8000-000000000001');
do $$
begin
  perform pg_temp.expect_error('select public.tr8_v2_get_context()','42501','newly banned user is rejected despite an unchanged JWT');
  perform pg_temp.assert_true((select count(*)=0 from public.tr8_workspace_projects),'newly banned owner cannot read personal or team projects');
end;
$$;
reset role;
update auth.users set banned_until=null,is_anonymous=true where id='f1000001-0000-4000-8000-000000000001';
set local role authenticated;
do $$
begin
  perform pg_temp.expect_error('select public.tr8_v2_get_context()','42501','anonymous Auth identity does not inherit authenticated-role access');
end;
$$;
reset role;
update auth.users set is_anonymous=false where id='f1000001-0000-4000-8000-000000000001';
do $$
begin
  perform pg_temp.expect_error($sql$delete from auth.users where id='f1000001-0000-4000-8000-000000000001'$sql$,'23503','deleting a creator account cannot cascade away team work');
  perform pg_temp.assert_true((select title='Team B task' and version=1 from public.tr8_workspace_tasks where id='bb100003-0000-4000-8000-000000000003'),'foreign team task stayed unchanged across adversarial operations');
  perform pg_temp.assert_true((select name='Team B private' and version=1 from public.tr8_workspace_projects where id='aa100003-0000-4000-8000-000000000003'),'foreign team project stayed unchanged across adversarial operations');
  perform pg_temp.assert_true((select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb) from public.tr8_workspace_projects p where owner_id not in ('f1000001-0000-4000-8000-000000000001','f1000002-0000-4000-8000-000000000002','f1000003-0000-4000-8000-000000000003','f1000007-0000-4000-8000-000000000007'))=(select payload from pg_temp.tr8_stage1_existing where entity='projects'),'all pre-existing project rows retain IDs, versions, times and fields');
  perform pg_temp.assert_true((select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.tr8_workspace_tasks t where owner_id not in ('f1000001-0000-4000-8000-000000000001','f1000002-0000-4000-8000-000000000002','f1000003-0000-4000-8000-000000000003','f1000007-0000-4000-8000-000000000007'))=(select payload from pg_temp.tr8_stage1_existing where entity='tasks'),'all pre-existing task rows retain IDs, versions, times and fields');
  perform pg_temp.assert_true((select not external_invites_enabled from tr8_private.app_config where singleton),'external onboarding finishes disabled even before rollback');
end;
$$;

reset role;
select 'workspace_stage1 assertions passed' as result, current_setting('tr8.stage1_test_count')::integer as assertions;
rollback;
