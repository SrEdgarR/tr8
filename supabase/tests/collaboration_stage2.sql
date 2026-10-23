-- TR8 stage 2: adversarial integration checks for the disposable test project.
-- Execute as postgres after the stage-2 migration. NEVER run in production.
-- All synthetic identities use example.test; no passwords, emails or external
-- services are involved. The transaction rolls back every fixture and flag.
-- Sequences can consume values on rollback; gaps are normal. Concurrency is
-- verified separately by scripts/stage2/http-smoke.mjs with real HTTP sessions.
begin;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
select set_config('tr8.stage2_test_count', '0', true);
create temporary table tr8_s2_runtime(key text primary key, value jsonb) on commit drop;
create temporary table tr8_s2_existing on commit drop as
select 'projects'::text entity, coalesce(jsonb_agg(to_jsonb(p) order by id), '[]'::jsonb) payload
from public.tr8_workspace_projects p
union all
select 'tasks', coalesce(jsonb_agg(to_jsonb(t) order by id), '[]'::jsonb)
from public.tr8_workspace_tasks t;

create function pg_temp.s2_assert(p_ok boolean, p_label text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_ok is distinct from true then raise exception 'Assertion failed: %',p_label; end if;
  perform set_config('tr8.stage2_test_count',(current_setting('tr8.stage2_test_count')::integer+1)::text,true);
end;
$$;
create function pg_temp.s2_error(p_sql text,p_states text[],p_label text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  begin execute p_sql;
  exception when others then
    if sqlstate=any(p_states) then perform pg_temp.s2_assert(true,p_label); return; end if;
    raise exception 'Assertion failed: %; expected %, received % (%)',p_label,p_states,sqlstate,sqlerrm;
  end;
  raise exception 'Assertion failed: %; operation unexpectedly succeeded',p_label;
end;
$$;
create function pg_temp.s2_denied(p_sql text,p_label text)
returns void language sql security invoker set search_path = '' as $$
  select pg_temp.s2_error(p_sql,array['PT404','42501'],p_label);
$$;
create function pg_temp.s2_actor(p_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform set_config('request.jwt.claim.sub',coalesce(p_id::text,''),true);
  perform set_config('request.jwt.claims',case when p_id is null then '{}' else
    jsonb_build_object('sub',p_id,'role','authenticated','user_metadata',jsonb_build_object('role','Owner','permissions',array['*']))::text end,true);
end;
$$;
create function pg_temp.s2_put(p_key text,p_value jsonb)
returns void language sql security invoker set search_path = '' as $$
  insert into pg_temp.tr8_s2_runtime(key,value) values(p_key,p_value)
  on conflict(key) do update set value=excluded.value;
$$;
create function pg_temp.s2_get(p_key text)
returns jsonb language sql security invoker set search_path = '' as $$
  select value from pg_temp.tr8_s2_runtime where key=p_key;
$$;
create function pg_temp.s2_id(p_key text)
returns uuid language sql security invoker set search_path = '' as $$
  select (pg_temp.s2_get(p_key)->>'id')::uuid;
$$;
do $$ begin execute format('grant usage on schema %I to anon, authenticated',pg_my_temp_schema()::regnamespace::text); end $$;
grant select,insert,update on pg_temp.tr8_s2_runtime to authenticated;
grant execute on function pg_temp.s2_assert(boolean,text),pg_temp.s2_error(text,text[],text),pg_temp.s2_denied(text,text),
 pg_temp.s2_actor(uuid),pg_temp.s2_put(text,jsonb),pg_temp.s2_get(text),pg_temp.s2_id(text) to anon,authenticated;

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('f2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated',
 'tr8-stage2-'||n||'@example.test',statement_timestamp(),'{}','{"role":"Owner"}',statement_timestamp(),statement_timestamp()
from generate_series(1,8) n;
insert into tr8_private.app_users(user_id,enabled,display_name)
select ('f2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,true,'Synthetic stage 2 '||n
from generate_series(1,7) n;
update tr8_private.app_config set external_invites_enabled=false where singleton;

do $$
declare v_table text;
begin
  perform pg_temp.s2_assert((select not external_invites_enabled from tr8_private.app_config where singleton),'external onboarding starts disabled');
  perform pg_temp.s2_assert((select count(*)=0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'tr8_v2_%' and p.prosecdef),'public wrappers are invokers');
  perform pg_temp.s2_assert((select count(*)=2 from pg_class where oid in ('public.tr8_workspace_projects'::regclass,'public.tr8_workspace_tasks'::regclass) and relrowsecurity),'content tables retain RLS');
  foreach v_table in array array['tr8_workspace_projects','tr8_workspace_tasks'] loop
    perform pg_temp.s2_assert(not has_table_privilege('authenticated','public.'||v_table,'INSERT,UPDATE,DELETE'),'no direct authenticated DML on '||v_table);
    perform pg_temp.s2_assert(not exists(select 1 from information_schema.column_privileges where table_schema='public' and table_name=v_table and grantee in ('PUBLIC','authenticated','anon') and privilege_type in ('INSERT','UPDATE')),'no legacy column write grant on '||v_table);
  end loop;
  perform pg_temp.s2_assert(not has_sequence_privilege('authenticated','public.tr8_tasks_task_number_seq','USAGE,UPDATE'),'task identity sequence is closed');
end;
$$;
set local role anon;
select pg_temp.s2_actor(null);
select pg_temp.s2_error($sql$select public.tr8_v2_list_roles(gen_random_uuid())$sql$,array['42501'],'anonymous role listing denied');
set local role authenticated;
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000008');
select pg_temp.s2_error('select public.tr8_v2_get_context()',array['42501'],'forged Owner metadata cannot enable an outsider');

-- User 1 owns team A; user 7 owns another completely isolated team.
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000001');
select pg_temp.s2_put('owner-context',public.tr8_v2_get_context());
select pg_temp.s2_put('team',public.tr8_v2_create_team('c2000000-0000-4000-8000-000000000001','Stage 2 synthetic team'));
select pg_temp.s2_put('project',to_jsonb(public.tr8_v2_create_project(pg_temp.s2_id('team'),'a2000001-0000-4000-8000-000000000001','Shared test project','','#5A67D8','active')));
select pg_temp.s2_put('secret',to_jsonb(public.tr8_v2_create_project(pg_temp.s2_id('team'),'a2000002-0000-4000-8000-000000000002','PRIVATE PROJECT TITLE MUST NEVER LEAK','','#5A67D8','active')));
select pg_temp.s2_put('task',to_jsonb(public.tr8_v2_create_task(pg_temp.s2_id('team'),'e2000000-0000-4000-8000-000000000001',pg_temp.s2_id('project'),'Shared task','','todo','high',null,null)));
select pg_temp.s2_put('secret-task',to_jsonb(public.tr8_v2_create_task(pg_temp.s2_id('team'),'e2000000-0000-4000-8000-000000000002',pg_temp.s2_id('secret'),'PRIVATE TASK TITLE MUST NEVER LEAK','','todo','high',null,null)));
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000007');
select pg_temp.s2_put('other-context',public.tr8_v2_get_context());
select pg_temp.s2_put('other-team',public.tr8_v2_create_team('c2000000-0000-4000-8000-000000000007','Stage 2 other team'));
select pg_temp.s2_put('other-project',to_jsonb(public.tr8_v2_create_project(pg_temp.s2_id('other-team'),'a2000007-0000-4000-8000-000000000007','Other team project','','#5A67D8','active')));
reset role;

-- Trusted setup of already-enabled internal members bypasses no public gate.
-- No invitation or account is created through a client operation.
insert into tr8_private.workspace_members(id,workspace_id,user_id)
select ('b2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,pg_temp.s2_id('team'),
 ('f2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(2,6) n;
select pg_temp.s2_put('owner-member',to_jsonb(m)) from tr8_private.workspace_members m where workspace_id=pg_temp.s2_id('team') and user_id='f2000000-0000-4000-8000-000000000001';
select pg_temp.s2_put('other-member',to_jsonb(m)) from tr8_private.workspace_members m where workspace_id=pg_temp.s2_id('other-team') and user_id='f2000000-0000-4000-8000-000000000007';
select pg_temp.s2_put('read-role',to_jsonb(r)) from tr8_private.workspace_roles r where workspace_id=pg_temp.s2_id('team') and template_key='read';
select pg_temp.s2_put('admin-role',to_jsonb(r)) from tr8_private.workspace_roles r where workspace_id=pg_temp.s2_id('team') and template_key='admin';
select pg_temp.s2_put('other-role',to_jsonb(r)) from tr8_private.workspace_roles r where workspace_id=pg_temp.s2_id('other-team') and template_key='read';
set local role authenticated;
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000001');

select pg_temp.s2_put('editor-role',public.tr8_v2_create_role(pg_temp.s2_id('team'),'d2000000-0000-4000-8000-000000000001','Task editor',array['project.read','task.read','task.edit']));
select pg_temp.s2_put('assign-role',public.tr8_v2_create_role(pg_temp.s2_id('team'),'d2000000-0000-4000-8000-000000000002','Task assigner',array['project.read','task.read','task.assign']));
select pg_temp.s2_put('manager-role',public.tr8_v2_create_role(pg_temp.s2_id('team'),'d2000000-0000-4000-8000-000000000003','Limited manager',array['member.read','member.remove','role.read','role.manage','role.assign','project.read','project.access.manage','task.read','audit.read']));
select pg_temp.s2_put('mutable-read-role',public.tr8_v2_create_role(pg_temp.s2_id('team'),'d2000000-0000-4000-8000-000000000004','Mutable reading',array['project.read','task.read']));
do $$
declare v_retry jsonb;
begin
  v_retry:=public.tr8_v2_create_role(pg_temp.s2_id('team'),pg_temp.s2_id('editor-role'),'Task editor',array['task.edit','task.read','project.read']);
  perform pg_temp.s2_assert(v_retry=pg_temp.s2_get('editor-role'),'role creation retry is order-insensitive and idempotent');
  perform pg_temp.s2_error($sql$select public.tr8_v2_create_role(pg_temp.s2_id('team'),pg_temp.s2_id('editor-role'),'Changed name',array['project.read','task.read','task.edit'])$sql$,array['PT409'],'role ID reused with other content conflicts');
  perform pg_temp.s2_error($sql$select public.tr8_v2_create_role(pg_temp.s2_id('team'),gen_random_uuid(),'Unknown',array['superadmin'])$sql$,array['PT422','22023','23514','23503'],'unknown permission rejected');
end;
$$;

select pg_temp.s2_put('collab',public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),'b2000000-0000-4000-8000-000000000002',1,array[pg_temp.s2_id('read-role'),pg_temp.s2_id('editor-role'),pg_temp.s2_id('assign-role')]));
select pg_temp.s2_put('reader',public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),'b2000000-0000-4000-8000-000000000003',1,array[pg_temp.s2_id('read-role')]));
select pg_temp.s2_put('admin',public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),'b2000000-0000-4000-8000-000000000004',1,array[pg_temp.s2_id('admin-role')]));
select pg_temp.s2_put('manager',public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),'b2000000-0000-4000-8000-000000000005',1,array[pg_temp.s2_id('manager-role')]));
select pg_temp.s2_put('assigner',public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),'b2000000-0000-4000-8000-000000000006',1,array[pg_temp.s2_id('assign-role')]));
select pg_temp.s2_put('collab-access',public.tr8_v2_set_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('project'),pg_temp.s2_id('collab'),0,'write'));
select pg_temp.s2_put('reader-access',public.tr8_v2_set_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('project'),pg_temp.s2_id('reader'),0,'read'));
select pg_temp.s2_put('manager-access',public.tr8_v2_set_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('project'),pg_temp.s2_id('manager'),0,'write'));
select pg_temp.s2_put('assigner-access',public.tr8_v2_set_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('project'),pg_temp.s2_id('assigner'),0,'write'));

-- Additive roles and ACL are independent conditions. No author/assignee bypass.
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000002');
do $$
declare v_caps jsonb; v_task jsonb;
begin
  v_caps:=public.tr8_v2_get_project_capabilities(pg_temp.s2_id('team'),pg_temp.s2_id('project'));
  perform pg_temp.s2_assert(v_caps->>'access_level'='write' and (v_caps->'permissions')?&array['project.read','task.read','task.edit','task.assign'],'permissions of multiple roles accumulate');
  perform pg_temp.s2_assert((select count(*)=1 from public.tr8_workspace_projects where workspace_id=pg_temp.s2_id('team')),'collaborator sees exactly its explicit project');
  perform pg_temp.s2_assert((select count(*)=0 from public.tr8_workspace_tasks where id=pg_temp.s2_id('secret-task')),'private task is invisible');
  v_task:=to_jsonb(public.tr8_v2_update_task(pg_temp.s2_id('team'),pg_temp.s2_id('task'),1,'{"title":"Collaborative edit"}'));
  perform pg_temp.s2_assert(v_task->>'title'='Collaborative edit' and (v_task->>'version')::int=2,'collaborative task edit succeeds');
  perform pg_temp.s2_put('task',v_task);
  perform pg_temp.s2_error($sql$select public.tr8_v2_update_task(pg_temp.s2_id('team'),pg_temp.s2_id('task'),1,'{"status":"done"}')$sql$,array['PT409'],'stale task edit rejected');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_get_project_capabilities(pg_temp.s2_id('team'),pg_temp.s2_id('secret'))$sql$,'private capabilities cannot be enumerated');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_update_project(pg_temp.s2_id('team'),pg_temp.s2_id('secret'),1,'{"name":"IDOR"}')$sql$,'private project update denied');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_update_project(pg_temp.s2_id('other-team'),pg_temp.s2_id('other-project'),1,'{"name":"IDOR"}')$sql$,'foreign workspace update denied');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),pg_temp.s2_id('collab'),(pg_temp.s2_get('collab')->>'version')::int,array[pg_temp.s2_id('admin-role')])$sql$,'ordinary collaborator cannot assign itself administration');
end;
$$;
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000003');
do $$
declare v_directory jsonb; v_page jsonb;
begin
  perform pg_temp.s2_assert((select count(*)=1 from public.tr8_workspace_tasks where workspace_id=pg_temp.s2_id('team')),'read ACL permits task visibility');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_update_task(pg_temp.s2_id('team'),pg_temp.s2_id('task'),(pg_temp.s2_get('task')->>'version')::int,'{"title":"Read bypass"}')$sql$,'read ACL cannot mutate task');
  v_directory:=public.tr8_v2_list_members(pg_temp.s2_id('team'));
  v_page:=public.tr8_v2_list_members_page(pg_temp.s2_id('team'),null,100);
  perform pg_temp.s2_assert(not exists(select 1 from jsonb_array_elements(v_directory) m where coalesce(m->'permissions','null'::jsonb)<>'[]'::jsonb or coalesce(m->'roles','null'::jsonb)<>'[]'::jsonb),'member.read alone does not reveal role assignments or detailed target permissions through legacy directory');
  perform pg_temp.s2_assert(not exists(select 1 from jsonb_array_elements(v_page->'items') m where coalesce(m->'permissions','null'::jsonb)<>'[]'::jsonb or coalesce(m->'roles','null'::jsonb)<>'[]'::jsonb),'member.read alone does not reveal role metadata through paginated directory');
  perform pg_temp.s2_assert(exists(select 1 from jsonb_array_elements(v_page->'items') m where m->>'id'=pg_temp.s2_id('admin')::text and m->>'display_name'='Synthetic stage 2 4'),'minimal member directory retains normal display names without role.read');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_list_roles(pg_temp.s2_id('team'))$sql$,'member.read alone cannot list role catalogue');
end;
$$;

-- Administrator status grants no implicit content and cannot bootstrap own ACL.
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000004');
do $$
declare v_activity jsonb;
begin
  perform pg_temp.s2_assert((select count(*)=0 from public.tr8_workspace_projects where workspace_id=pg_temp.s2_id('team')),'administrator without ACL sees no project');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_set_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('secret'),pg_temp.s2_id('admin'),0,'write')$sql$,'administrator cannot self-grant private project');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_list_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('secret'))$sql$,'administrator cannot enumerate private project ACL');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_list_activity(pg_temp.s2_id('team'),pg_temp.s2_id('secret'),null,50)$sql$,'administrator cannot audit private project explicitly');
  v_activity:=public.tr8_v2_list_activity(pg_temp.s2_id('team'),null,null,250);
  perform pg_temp.s2_assert(not exists(select 1 from jsonb_array_elements(v_activity->'items') x where x->>'project_id' is not null),'unscoped audit excludes all inaccessible project events');
  perform pg_temp.s2_assert(v_activity::text not like '%PRIVATE PROJECT%' and v_activity::text not like '%PRIVATE TASK%' and not (v_activity?'total'),'audit reveals no private titles or total counts');
end;
$$;
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000001');
select pg_temp.s2_put('admin-access',public.tr8_v2_set_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('project'),pg_temp.s2_id('admin'),0,'read'));
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000004');
select pg_temp.s2_denied($sql$select public.tr8_v2_set_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('project'),pg_temp.s2_id('admin'),1,'write')$sql$,'administrator cannot raise its own read access');
select pg_temp.s2_denied($sql$select public.tr8_v2_update_task(pg_temp.s2_id('team'),pg_temp.s2_id('task'),(pg_temp.s2_get('task')->>'version')::int,'{"title":"Read ACL versus admin edit"}')$sql$,'read ACL blocks task.edit even with all eighteen role permissions');
select pg_temp.s2_denied($sql$select public.tr8_v2_update_project(pg_temp.s2_id('team'),pg_temp.s2_id('project'),1,'{"name":"Read ACL versus admin edit"}')$sql$,'read ACL blocks project.edit even with all role permissions');

-- A restricted delegate cannot change superior roles or acquire missing powers.
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000005');
do $$
declare v_directory jsonb; v_roles jsonb;
begin
  v_directory:=public.tr8_v2_list_members_page(pg_temp.s2_id('team'),null,100);
  v_roles:=public.tr8_v2_list_roles(pg_temp.s2_id('team'));
  perform pg_temp.s2_assert(exists(select 1 from jsonb_array_elements(v_directory->'items') m where m->>'id'=pg_temp.s2_id('admin')::text and jsonb_array_length(m->'permissions')=18 and m?'roles'),'role.read explicitly permits viewing role assignments and target permissions');
  perform pg_temp.s2_assert(exists(select 1 from jsonb_array_elements(v_roles->'items') r where r->>'id'=pg_temp.s2_id('admin-role')::text),'role.read permits consulting role catalogue without opening project content');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_update_role(pg_temp.s2_id('team'),pg_temp.s2_id('admin-role'),1,'Downgraded admin',array['project.read','task.read'])$sql$,'cannot degrade a superior role to take control');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_delete_role(pg_temp.s2_id('team'),pg_temp.s2_id('admin-role'),1)$sql$,'cannot delete superior assigned role');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_update_role(pg_temp.s2_id('team'),pg_temp.s2_id('manager-role'),1,'Self escalation',array['member.read','member.remove','role.read','role.manage','role.assign','project.read','project.access.manage','task.read','audit.read','task.edit'])$sql$,'editing own assigned role cannot add missing capabilities');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),pg_temp.s2_id('manager'),(pg_temp.s2_get('manager')->>'version')::int,array[pg_temp.s2_id('admin-role')])$sql$,'cannot assign superior role to self');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),pg_temp.s2_id('admin'),(pg_temp.s2_get('admin')->>'version')::int,array[pg_temp.s2_id('read-role')])$sql$,'cannot control a superior member by removing roles');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_remove_member(pg_temp.s2_id('team'),pg_temp.s2_id('admin'),(pg_temp.s2_get('admin')->>'version')::int)$sql$,'cannot remove superior member');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_remove_member(pg_temp.s2_id('team'),pg_temp.s2_id('owner-member'),1)$sql$,'team owner remains protected');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),pg_temp.s2_id('owner-member'),1,array[]::uuid[])$sql$,'team owner authority cannot be edited as roles');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_set_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('secret'),pg_temp.s2_id('manager'),0,'write')$sql$,'delegate cannot self-open a private project');
end;
$$;

-- Assignment-only permission is deliberately narrower than ordinary editing.
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000006');
do $$
declare v_task jsonb; v_members jsonb;
begin
  v_members:=public.tr8_v2_list_assignable_members(pg_temp.s2_id('team'),pg_temp.s2_id('project'));
  perform pg_temp.s2_assert(exists(select 1 from jsonb_array_elements(v_members->'items') m where m->>'id'=pg_temp.s2_id('reader')::text),'read-only member is eligible as task assignee');
  v_task:=to_jsonb(public.tr8_v2_assign_task(pg_temp.s2_id('team'),pg_temp.s2_id('task'),(pg_temp.s2_get('task')->>'version')::int,pg_temp.s2_id('reader')));
  perform pg_temp.s2_assert(v_task->>'assignee_member_id'=pg_temp.s2_id('reader')::text,'assign-only role may assign eligible reader');
  perform pg_temp.s2_put('task',v_task);
  perform pg_temp.s2_denied($sql$select public.tr8_v2_update_task(pg_temp.s2_id('team'),pg_temp.s2_id('task'),(pg_temp.s2_get('task')->>'version')::int,'{"title":"Assignment grants no editing"}')$sql$,'task.assign does not imply task.edit');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_assign_task(pg_temp.s2_id('team'),pg_temp.s2_id('secret-task'),1,pg_temp.s2_id('reader'))$sql$,'assign-only role cannot touch private task');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_assign_task(pg_temp.s2_id('team'),pg_temp.s2_id('task'),(pg_temp.s2_get('task')->>'version')::int,pg_temp.s2_id('other-member'))$sql$,'assignee cannot come from another workspace');
end;
$$;

-- Closed patches and strong FKs are tested even when a user is privileged.
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000001');
do $$
begin
  perform pg_temp.s2_error($sql$select public.tr8_v2_update_task(pg_temp.s2_id('team'),pg_temp.s2_id('task'),(pg_temp.s2_get('task')->>'version')::int,jsonb_build_object('title','Mixed patch','assignee_member_id',pg_temp.s2_id('collab')))$sql$,array['PT422','22023'],'mixed generic patch cannot bypass the assignment operation');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),pg_temp.s2_id('reader'),(pg_temp.s2_get('reader')->>'version')::int,array[pg_temp.s2_id('other-role')])$sql$,'role from foreign workspace rejected');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_set_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('project'),pg_temp.s2_id('other-member'),0,'read')$sql$,'ACL cannot reference foreign member');
  perform pg_temp.s2_error($sql$select public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),pg_temp.s2_id('reader'),1,array[pg_temp.s2_id('read-role')])$sql$,array['PT409'],'stale membership version conflicts');
  perform pg_temp.s2_error($sql$select public.tr8_v2_set_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('project'),pg_temp.s2_id('reader'),0,'write')$sql$,array['PT409'],'existing ACL cannot be overwritten as a create');
end;
$$;

-- An ACL removal revokes a downloaded token immediately and disassigns atomically.
select pg_temp.s2_put('removed-access',public.tr8_v2_remove_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('project'),pg_temp.s2_id('reader'),1));
reset role;
do $$
declare v_task jsonb;
begin
  select to_jsonb(t) into v_task from public.tr8_workspace_tasks t where id=pg_temp.s2_id('task');
  perform pg_temp.s2_assert(v_task->>'assignee_member_id' is null and (v_task->>'version')::int=(pg_temp.s2_get('task')->>'version')::int+1,'ACL removal clears assignee and increments version once');
  perform pg_temp.s2_assert((v_task->>'updated_at')::timestamptz >= (pg_temp.s2_get('task')->>'updated_at')::timestamptz,'automatic disassignment uses server time');
  perform pg_temp.s2_put('task',v_task);
  perform pg_temp.s2_assert(exists(select 1 from tr8_private.workspace_activity where project_id=pg_temp.s2_id('project') and resource_id=pg_temp.s2_id('task') and action like '%assign%'),'automatic disassignment creates a minimal activity event');
end;
$$;
set local role authenticated;
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000003');
do $$
begin
  perform pg_temp.s2_assert((select count(*)=0 from public.tr8_workspace_projects where id=pg_temp.s2_id('project')),'same unchanged JWT loses project read after ACL revocation');
  perform pg_temp.s2_assert((select count(*)=0 from public.tr8_workspace_tasks where id=pg_temp.s2_id('task')),'same unchanged JWT loses task read after ACL revocation');
end;
$$;

-- Losing task.read through an assigned role also disassigns archived tasks.
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000001');
select pg_temp.s2_put('reader',public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),pg_temp.s2_id('reader'),(pg_temp.s2_get('reader')->>'version')::int,array[pg_temp.s2_id('mutable-read-role')]));
select pg_temp.s2_put('reader-access',public.tr8_v2_set_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('project'),pg_temp.s2_id('reader'),0,'read'));
select pg_temp.s2_put('task',to_jsonb(public.tr8_v2_assign_task(pg_temp.s2_id('team'),pg_temp.s2_id('task'),(pg_temp.s2_get('task')->>'version')::int,pg_temp.s2_id('reader'))));
select pg_temp.s2_put('project',to_jsonb(public.tr8_v2_update_project(pg_temp.s2_id('team'),pg_temp.s2_id('project'),1,jsonb_build_object('archived_at',statement_timestamp()))));
select pg_temp.s2_put('mutable-read-role',public.tr8_v2_update_role(pg_temp.s2_id('team'),pg_temp.s2_id('mutable-read-role'),1,'No task access',array['project.read']));
reset role;
do $$
declare v_task jsonb;
begin
  select to_jsonb(t) into v_task from public.tr8_workspace_tasks t where id=pg_temp.s2_id('task');
  perform pg_temp.s2_assert(v_task->>'assignee_member_id' is null and (v_task->>'version')::int=(pg_temp.s2_get('task')->>'version')::int+1,'role permission removal disassigns even on archived project');
  perform pg_temp.s2_put('task',v_task);
  perform pg_temp.s2_assert((select archived_at is not null from public.tr8_workspace_projects where id=pg_temp.s2_id('project')),'disassignment does not restore or alter archive');
end;
$$;
set local role authenticated;
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000003');
do $$
begin
  perform pg_temp.s2_assert((select count(*)=1 from public.tr8_workspace_projects where id=pg_temp.s2_id('project')),'project.read remains after removing task.read');
  perform pg_temp.s2_assert((select count(*)=0 from public.tr8_workspace_tasks where id=pg_temp.s2_id('task')),'live role change removes task visibility without refreshing JWT');
end;
$$;

-- Deleting a role checks the effective union, not a single assignment row.
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000001');
select pg_temp.s2_put('project',to_jsonb(public.tr8_v2_update_project(pg_temp.s2_id('team'),pg_temp.s2_id('project'),(pg_temp.s2_get('project')->>'version')::int,'{"archived_at":null}')));
select pg_temp.s2_put('mutable-read-role',public.tr8_v2_update_role(pg_temp.s2_id('team'),pg_temp.s2_id('mutable-read-role'),2,'Read restored',array['project.read','task.read']));
select pg_temp.s2_put('task',to_jsonb(public.tr8_v2_assign_task(pg_temp.s2_id('team'),pg_temp.s2_id('task'),(pg_temp.s2_get('task')->>'version')::int,pg_temp.s2_id('reader'))));
select public.tr8_v2_delete_role(pg_temp.s2_id('team'),pg_temp.s2_id('mutable-read-role'),3);
reset role;
do $$
declare v_task jsonb;
begin
  select to_jsonb(t) into v_task from public.tr8_workspace_tasks t where id=pg_temp.s2_id('task');
  perform pg_temp.s2_assert(v_task->>'assignee_member_id' is null and (v_task->>'version')::int=(pg_temp.s2_get('task')->>'version')::int+1,'deleting assigned reading role disassigns exactly once');
  perform pg_temp.s2_put('task',v_task);
  perform pg_temp.s2_put('reader',to_jsonb(m)) from tr8_private.workspace_members m where id=pg_temp.s2_id('reader');
end;
$$;
set local role authenticated;
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000003');
select pg_temp.s2_assert((select count(*)=0 from public.tr8_workspace_projects where id=pg_temp.s2_id('project')),'ACL without any role grants no effective project access');
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000001');
select pg_temp.s2_put('reader',public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),pg_temp.s2_id('reader'),(pg_temp.s2_get('reader')->>'version')::int,array[pg_temp.s2_id('read-role'),pg_temp.s2_id('editor-role')]));
select pg_temp.s2_put('task',to_jsonb(public.tr8_v2_assign_task(pg_temp.s2_id('team'),pg_temp.s2_id('task'),(pg_temp.s2_get('task')->>'version')::int,pg_temp.s2_id('reader'))));
select pg_temp.s2_put('reader',public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),pg_temp.s2_id('reader'),(pg_temp.s2_get('reader')->>'version')::int,array[pg_temp.s2_id('read-role')]));
reset role;
do $$
begin
  perform pg_temp.s2_assert((select assignee_member_id=pg_temp.s2_id('reader') and version=(pg_temp.s2_get('task')->>'version')::int from public.tr8_workspace_tasks where id=pg_temp.s2_id('task')),'removing one additive role preserves assignment when reading remains');
end;
$$;
set local role authenticated;
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000001');
select pg_temp.s2_put('reader',public.tr8_v2_set_member_roles(pg_temp.s2_id('team'),pg_temp.s2_id('reader'),(pg_temp.s2_get('reader')->>'version')::int,array[]::uuid[]));
reset role;
do $$
declare v_task jsonb;
begin
  select to_jsonb(t) into v_task from public.tr8_workspace_tasks t where id=pg_temp.s2_id('task');
  perform pg_temp.s2_assert(v_task->>'assignee_member_id' is null and (v_task->>'version')::int=(pg_temp.s2_get('task')->>'version')::int+1,'removing last reading role disassigns in the same transaction');
  perform pg_temp.s2_put('task',v_task);
end;
$$;
set local role authenticated;

-- Removing a member clears assignments, roles and ACL without deleting work.
select pg_temp.s2_put('task',to_jsonb(public.tr8_v2_assign_task(pg_temp.s2_id('team'),pg_temp.s2_id('task'),(pg_temp.s2_get('task')->>'version')::int,pg_temp.s2_id('collab'))));
select pg_temp.s2_put('collab',public.tr8_v2_remove_member(pg_temp.s2_id('team'),pg_temp.s2_id('collab'),(pg_temp.s2_get('collab')->>'version')::int));
reset role;
do $$
begin
  perform pg_temp.s2_assert((select assignee_member_id is null and version=(pg_temp.s2_get('task')->>'version')::int+1 from public.tr8_workspace_tasks where id=pg_temp.s2_id('task')),'member removal disassigns and versions affected task atomically');
  perform pg_temp.s2_assert((select status='removed' from tr8_private.workspace_members where id=pg_temp.s2_id('collab')),'member is marked removed');
  perform pg_temp.s2_assert((select count(*)=0 from tr8_private.member_roles where member_id=pg_temp.s2_id('collab')),'removed membership has no residual role assignments');
  perform pg_temp.s2_assert((select count(*)=0 from tr8_private.project_access where member_id=pg_temp.s2_id('collab')),'removed membership has no residual project ACL');
end;
$$;
set local role authenticated;
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000002');
do $$
begin
  perform pg_temp.s2_assert((select count(*)=0 from public.tr8_workspace_projects where workspace_id=pg_temp.s2_id('team')),'removed member immediately loses project reads');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_update_task(pg_temp.s2_id('team'),pg_temp.s2_id('task'),(pg_temp.s2_get('task')->>'version')::int,'{"title":"Late revoked write"}')$sql$,'removed member cannot write with the same old JWT');
  perform pg_temp.s2_denied($sql$select public.tr8_v2_list_members(pg_temp.s2_id('team'))$sql$,'removed member loses team directory');
end;
$$;

-- Owner can edit/delete custom roles with version checks; ownership stays fixed.
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000001');
select pg_temp.s2_put('disposable-role',public.tr8_v2_create_role(pg_temp.s2_id('team'),'d2000000-0000-4000-8000-000000000009','Disposable',array['project.read']));
select pg_temp.s2_put('disposable-role',public.tr8_v2_update_role(pg_temp.s2_id('team'),pg_temp.s2_id('disposable-role'),1,'Renamed',array['project.read','task.read']));
do $$
begin
  perform pg_temp.s2_assert((pg_temp.s2_get('disposable-role')->>'version')::int=2,'role edit increments expected version');
  perform pg_temp.s2_error($sql$select public.tr8_v2_delete_role(pg_temp.s2_id('team'),pg_temp.s2_id('disposable-role'),1)$sql$,array['PT409'],'stale role deletion rejected');
  perform pg_temp.s2_assert((public.tr8_v2_delete_role(pg_temp.s2_id('team'),pg_temp.s2_id('disposable-role'),2)->>'deleted')::boolean,'role deletion succeeds with current version');
  perform pg_temp.s2_error($sql$select public.tr8_v2_create_invitation(pg_temp.s2_id('team'),gen_random_uuid(),'disabled-stage2@example.test')$sql$,array['42501'],'external invitation creation stays disabled');
  perform pg_temp.s2_error($sql$select public.tr8_v2_accept_invitation('synthetic-disabled-token')$sql$,array['42501'],'invitation acceptance stays disabled');
  perform pg_temp.s2_error($sql$update public.tr8_workspace_tasks set title='Direct bypass' where id=pg_temp.s2_id('task')$sql$,array['42501'],'direct DML remains denied even to team owner');
  perform pg_temp.s2_error($sql$select nextval('public.tr8_tasks_task_number_seq')$sql$,array['42501'],'client cannot consume task identity sequence');
  perform pg_temp.s2_error($sql$select * from tr8_private.project_access$sql$,array['42501'],'private ACL rows cannot be enumerated directly');
  perform pg_temp.s2_error($sql$update tr8_private.app_config set external_invites_enabled=true$sql$,array['42501'],'team owner cannot activate external signup gate');
end;
$$;

-- Every paginated collection validates limits and cursor scope, then returns
-- only authorized rows. Its continuation must not repeat the last row.
do $$
declare v_first jsonb; v_next jsonb;
begin
  v_first:=public.tr8_v2_list_roles(pg_temp.s2_id('team'),null,1);
  v_next:=public.tr8_v2_list_roles(pg_temp.s2_id('team'),v_first->>'next_cursor',1);
  perform pg_temp.s2_assert(jsonb_array_length(v_first->'items')=1 and v_first->>'next_cursor' is not null and v_first->'items'->0->>'id'<>v_next->'items'->0->>'id','role pages are bounded and do not repeat');
  perform pg_temp.s2_put('roles-first',v_first);
  perform pg_temp.s2_error($sql$select public.tr8_v2_list_roles(pg_temp.s2_id('team'),'not-base64',100)$sql$,array['22023'],'malformed role cursor rejected');
  perform pg_temp.s2_error($sql$select public.tr8_v2_list_roles(pg_temp.s2_id('team'),null,251)$sql$,array['22023'],'excessive role limit rejected');
  v_first:=public.tr8_v2_list_members_page(pg_temp.s2_id('team'),null,1);
  v_next:=public.tr8_v2_list_members_page(pg_temp.s2_id('team'),v_first->>'next_cursor',1);
  perform pg_temp.s2_assert(jsonb_array_length(v_first->'items')=1 and v_first->>'next_cursor' is not null and v_first->'items'->0->>'id'<>v_next->'items'->0->>'id','member pages are bounded and do not repeat');
  perform pg_temp.s2_error($sql$select public.tr8_v2_list_members_page(pg_temp.s2_id('team'),pg_temp.s2_get('roles-first')->>'next_cursor',1)$sql$,array['22023'],'role cursor cannot paginate member list');
  perform pg_temp.s2_error($sql$select public.tr8_v2_list_members_page(pg_temp.s2_id('team'),null,0)$sql$,array['22023'],'zero member limit rejected');
  v_first:=public.tr8_v2_list_project_capabilities(pg_temp.s2_id('team'),null,1);
  v_next:=public.tr8_v2_list_project_capabilities(pg_temp.s2_id('team'),v_first->>'next_cursor',1);
  perform pg_temp.s2_assert(jsonb_array_length(v_first->'items')=1 and v_first->>'next_cursor' is not null and v_first->'items'->0->>'project_id'<>v_next->'items'->0->>'project_id','capability pages are bounded and do not repeat');
  perform pg_temp.s2_error($sql$select public.tr8_v2_list_project_capabilities(pg_temp.s2_id('team'),'not-base64',100)$sql$,array['22023'],'malformed capability cursor rejected');
  perform pg_temp.s2_error($sql$select public.tr8_v2_list_project_capabilities(pg_temp.s2_id('team'),pg_temp.s2_get('roles-first')->>'next_cursor',1)$sql$,array['22023'],'role cursor cannot paginate project capabilities');
  v_first:=public.tr8_v2_list_assignable_members(pg_temp.s2_id('team'),pg_temp.s2_id('project'),null,1);
  v_next:=public.tr8_v2_list_assignable_members(pg_temp.s2_id('team'),pg_temp.s2_id('project'),v_first->>'next_cursor',1);
  perform pg_temp.s2_assert(jsonb_array_length(v_first->'items')=1 and v_first->>'next_cursor' is not null and v_first->'items'->0->>'id'<>v_next->'items'->0->>'id','eligible-member pages are bounded and do not repeat');
  perform pg_temp.s2_put('assignees-first',v_first);
  perform pg_temp.s2_error($sql$select public.tr8_v2_list_assignable_members(pg_temp.s2_id('team'),pg_temp.s2_id('secret'),pg_temp.s2_get('assignees-first')->>'next_cursor',1)$sql$,array['22023'],'eligible cursor cannot be reused on another project');
  perform pg_temp.s2_error($sql$select public.tr8_v2_list_assignable_members(pg_temp.s2_id('team'),pg_temp.s2_id('project'),'not-base64',100)$sql$,array['22023'],'malformed eligible-member cursor rejected');
  v_first:=public.tr8_v2_list_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('project'),null,1);
  v_next:=public.tr8_v2_list_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('project'),v_first->>'next_cursor',1);
  perform pg_temp.s2_assert(jsonb_array_length(v_first->'items')=1 and v_first->>'next_cursor' is not null and v_first->'items'->0->>'member_id'<>v_next->'items'->0->>'member_id','ACL pages are bounded and do not repeat');
  perform pg_temp.s2_error($sql$select public.tr8_v2_list_project_access(pg_temp.s2_id('team'),pg_temp.s2_id('project'),'not-base64',100)$sql$,array['22023'],'malformed ACL cursor rejected');
  perform pg_temp.s2_error($sql$select public.tr8_v2_list_activity(pg_temp.s2_id('team'),null,-1,50)$sql$,array['22023'],'negative activity cursor rejected');
end;
$$;
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000007');
select pg_temp.s2_error($sql$select public.tr8_v2_list_roles(pg_temp.s2_id('other-team'),pg_temp.s2_get('roles-first')->>'next_cursor',1)$sql$,array['22023'],'role cursor cannot cross workspaces even when both requests are authorized');

-- Live Auth status is checked again by the new APIs, independent of an old JWT.
reset role;
update auth.users set email_confirmed_at=null where id='f2000000-0000-4000-8000-000000000005';
set local role authenticated;
select pg_temp.s2_actor('f2000000-0000-4000-8000-000000000005');
select pg_temp.s2_denied($sql$select public.tr8_v2_list_roles(pg_temp.s2_id('team'))$sql$,'unconfirmed account cannot use role API with previously valid claims');
select pg_temp.s2_assert((select count(*)=0 from public.tr8_workspace_projects where workspace_id=pg_temp.s2_id('team')),'unconfirmed manager cannot read projects with old JWT');
reset role;
update auth.users set email_confirmed_at=statement_timestamp(),deleted_at=statement_timestamp() where id='f2000000-0000-4000-8000-000000000005';
set local role authenticated;
select pg_temp.s2_denied($sql$select public.tr8_v2_list_members_page(pg_temp.s2_id('team'))$sql$,'soft-deleted account cannot use member API with previously valid claims');
select pg_temp.s2_assert((select count(*)=0 from public.tr8_workspace_tasks where workspace_id=pg_temp.s2_id('team')),'soft-deleted manager cannot read tasks with old JWT');
reset role;
update auth.users set deleted_at=null where id='f2000000-0000-4000-8000-000000000005';
reset role;
do $$
begin
  perform pg_temp.s2_assert((select owner_id='f2000000-0000-4000-8000-000000000001' from tr8_private.workspaces where id=pg_temp.s2_id('team')),'all administrative operations preserve protected owner');
  perform pg_temp.s2_assert((select name='Other team project' and version=1 from public.tr8_workspace_projects where id=pg_temp.s2_id('other-project')),'other team project remains unchanged');
  perform pg_temp.s2_assert((select name='PRIVATE PROJECT TITLE MUST NEVER LEAK' and version=1 from public.tr8_workspace_projects where id=pg_temp.s2_id('secret')),'private untouched project remains unchanged');
  perform pg_temp.s2_assert((select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb) from public.tr8_workspace_projects p where owner_id not in ('f2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000007'))=(select payload from pg_temp.tr8_s2_existing where entity='projects'),'all pre-existing projects preserve full content, versions and server times');
  perform pg_temp.s2_assert((select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.tr8_workspace_tasks t where owner_id not in ('f2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000007'))=(select payload from pg_temp.tr8_s2_existing where entity='tasks'),'all pre-existing tasks preserve full content, versions and server times');
  perform pg_temp.s2_assert((select not external_invites_enabled from tr8_private.app_config where singleton),'external onboarding ends disabled before rollback');
end;
$$;
select 'collaboration_stage2 assertions passed' result,current_setting('tr8.stage2_test_count')::integer assertions;
rollback;
