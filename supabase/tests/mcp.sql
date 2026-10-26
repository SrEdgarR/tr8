-- Disposable TEST project only. Synthetic fixtures; transaction rolls back all
-- content, connections and quota/audit changes. Task sequence gaps are expected.
begin;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
select set_config('tr8.mcp_test_count','0',true);
create temporary table mcp_test_values(key text primary key,value jsonb) on commit drop;
create temporary table mcp_existing on commit drop as
select 'projects' entity,md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) digest,coalesce(array_agg(id),array[]::uuid[]) ids from public.tr8_workspace_projects p
union all select 'tasks',md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')),coalesce(array_agg(id),array[]::uuid[]) from public.tr8_workspace_tasks t
union all select 'finance',md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')),coalesce(array_agg(owner_id),array[]::uuid[]) from tr8_private.account_finances f;
create function pg_temp.mcp_assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'MCP assertion failed: %',label; end if;
  perform set_config('tr8.mcp_test_count',(current_setting('tr8.mcp_test_count')::integer+1)::text,true);
end;
$$;
create function pg_temp.mcp_error(command text,expected text,label text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate=expected then perform pg_temp.mcp_assert(true,label); return; end if;
    raise exception 'MCP assertion failed: %; expected %, got % (%)',label,expected,sqlstate,sqlerrm;
  end;
  raise exception 'MCP assertion failed: %; operation unexpectedly succeeded',label;
end;
$$;
create function pg_temp.mcp_actor(actor uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',coalesce(actor::text,''),true);
  perform set_config('request.jwt.claims',case when actor is null then '{}' else jsonb_build_object('sub',actor,'role','authenticated')::text end,true);
end;
$$;
create function pg_temp.mcp_put(k text,v jsonb) returns void language sql as $$
  insert into pg_temp.mcp_test_values values(k,v) on conflict(key) do update set value=excluded.value;
$$;
create function pg_temp.mcp_get(k text) returns jsonb language sql as $$select value from pg_temp.mcp_test_values where key=k;$$;
create function pg_temp.mcp_id(k text) returns uuid language sql as $$select (pg_temp.mcp_get(k)->>'id')::uuid;$$;
create function pg_temp.mcp_call(k text,action text,input jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select public.tr8_mcp_dispatch(pg_temp.mcp_get(k)->>'token',action,input);
$$;
do $$begin execute format('grant usage on schema %I to anon,authenticated',pg_my_temp_schema()::regnamespace::text);end;$$;
grant select,insert,update on pg_temp.mcp_test_values to anon,authenticated;
grant execute on function pg_temp.mcp_assert(boolean,text),pg_temp.mcp_error(text,text,text),pg_temp.mcp_actor(uuid),
  pg_temp.mcp_put(text,jsonb),pg_temp.mcp_get(text),pg_temp.mcp_id(text),pg_temp.mcp_call(text,text,jsonb) to anon,authenticated;

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('f8000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated',
  'tr8-mcp-synthetic-'||n||'@example.test',statement_timestamp(),'{}','{}',statement_timestamp(),statement_timestamp() from generate_series(1,3)n;
insert into tr8_private.app_users(user_id,enabled,display_name)
select ('f8000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,true,'MCP synthetic '||n from generate_series(1,3)n;

set local role authenticated;
select pg_temp.mcp_actor('f8000000-0000-4000-8000-000000000001');
select pg_temp.mcp_put('team',public.tr8_v2_create_team('f8000010-0000-4000-8000-000000000001','MCP synthetic team'));
select pg_temp.mcp_put('project',to_jsonb(public.tr8_v2_create_project(pg_temp.mcp_id('team'),'f8000020-0000-4000-8000-000000000001','MCP shared synthetic','','#8B8CF8','active')));
select pg_temp.mcp_put('hidden',to_jsonb(public.tr8_v2_create_project(pg_temp.mcp_id('team'),'f8000021-0000-4000-8000-000000000002','MCP hidden synthetic','','#8B8CF8','active')));
select pg_temp.mcp_put('write',public.tr8_mcp_credentials('create',jsonb_build_object('name','MCP synthetic write','workspace_id',pg_temp.mcp_id('team'),'access','write','expires_in_days',7)));
select pg_temp.mcp_put('read',public.tr8_mcp_credentials('create',jsonb_build_object('name','MCP synthetic read','workspace_id',pg_temp.mcp_id('team'),'access','read','expires_in_days',7)));
select pg_temp.mcp_assert(pg_temp.mcp_get('write')->>'token' ~ '^tr8_mcp_[a-f0-9]{64}$','random opaque bearer format');
select pg_temp.mcp_assert(not (public.tr8_mcp_credentials('list')->0)?'token','list never returns bearer');
select pg_temp.mcp_assert(jsonb_array_length(public.tr8_mcp_credentials('list'))=2,'own connections listed');
select pg_temp.mcp_actor('f8000000-0000-4000-8000-000000000002');
select pg_temp.mcp_put('other_team',public.tr8_v2_create_team('f8000010-0000-4000-8000-000000000002','MCP isolated synthetic'));
select pg_temp.mcp_put('other_project',to_jsonb(public.tr8_v2_create_project(pg_temp.mcp_id('other_team'),'f8000022-0000-4000-8000-000000000003','MCP unrelated synthetic','','#8B8CF8','active')));
select pg_temp.mcp_assert(jsonb_array_length(public.tr8_mcp_credentials('list'))=0,'another user sees no connections');
select pg_temp.mcp_error($q$select public.tr8_mcp_credentials('revoke',jsonb_build_object('id',pg_temp.mcp_id('write')))$q$,'PT404','cannot revoke somebody else connection');
select pg_temp.mcp_error($q$select public.tr8_mcp_credentials('create',jsonb_build_object('name','bad','workspace_id',pg_temp.mcp_id('team'),'access','write','expires_in_days',7))$q$,'PT404','cannot mint outside workspace');
select pg_temp.mcp_assert((pg_temp.mcp_call('write','context')#>>'{workspace,id}')::uuid=pg_temp.mcp_id('team'),'credential fixes workspace despite other caller');
select pg_temp.mcp_assert(auth.uid()='f8000000-0000-4000-8000-000000000002'::uuid,'successful dispatch restores legacy sub');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('write','context','{"workspace_id":"f8000010-0000-4000-8000-000000000002"}')$q$,'22023','cannot override workspace');
select pg_temp.mcp_assert(auth.uid()='f8000000-0000-4000-8000-000000000002'::uuid,'failed dispatch restores caller identity');
reset role;
insert into tr8_private.workspace_members(id,workspace_id,user_id,status) values
  ('f8000030-0000-4000-8000-000000000003',pg_temp.mcp_id('team'),'f8000000-0000-4000-8000-000000000003','active');
insert into tr8_private.member_roles(workspace_id,member_id,role_id)
select pg_temp.mcp_id('team'),'f8000030-0000-4000-8000-000000000003',id from tr8_private.workspace_roles where workspace_id=pg_temp.mcp_id('team') and template_key='collaborator';
insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level)
values(pg_temp.mcp_id('team'),pg_temp.mcp_id('project'),'f8000030-0000-4000-8000-000000000003','read');
set local role authenticated;
select pg_temp.mcp_actor('f8000000-0000-4000-8000-000000000003');
select pg_temp.mcp_put('member',public.tr8_mcp_credentials('create',jsonb_build_object('name','MCP limited synthetic','workspace_id',pg_temp.mcp_id('team'),'access','write','expires_in_days',7)));
set local role anon;
select pg_temp.mcp_actor(null);
select pg_temp.mcp_assert(not has_function_privilege('anon','public.tr8_mcp_credentials(text,jsonb)','EXECUTE'),'management denies anon');
select pg_temp.mcp_assert(not has_function_privilege('anon','tr8_private.mcp_manage(text,jsonb)','EXECUTE'),'private management denies anon');
select pg_temp.mcp_assert(not has_function_privilege('anon','tr8_private.mcp_keys(jsonb,text[],text[])','EXECUTE'),'validation helper ungranted');
select pg_temp.mcp_assert(not has_function_privilege('authenticated','tr8_private.mcp_credential_json(tr8_private.mcp_credentials)','EXECUTE'),'credential serializer ungranted');
select pg_temp.mcp_error($q$select * from tr8_private.mcp_credentials$q$,'42501','credential table private');
select pg_temp.mcp_error($q$select * from tr8_private.mcp_activity$q$,'42501','audit table private');
select pg_temp.mcp_error($q$select public.tr8_mcp_dispatch('invalid','context')$q$,'PT401','malformed token fails');
select pg_temp.mcp_error($q$select public.tr8_mcp_dispatch('tr8_mcp_'||repeat('a',64),'context')$q$,'PT401','unknown token fails');
select pg_temp.mcp_assert(jsonb_array_length(pg_temp.mcp_call('member','list_projects')->'items')=1,'member only sees explicitly shared project');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('member','get_project',jsonb_build_object('id',pg_temp.mcp_id('hidden')))$q$,'PT404','private project remains hidden');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('write','get_project',jsonb_build_object('id',pg_temp.mcp_id('other_project')))$q$,'PT404','other workspace unavailable');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('member','update_project',jsonb_build_object('id',pg_temp.mcp_id('project'),'version',1,'patch',jsonb_build_object('name','changed')))$q$,'PT404','write credential cannot elevate project read access');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('read','create_project','{"request_id":"f8000029-0000-4000-8000-000000000009","name":"forbidden"}')$q$,'PT403','read credential rejects writes');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('write','delete_project','{}')$q$,'22023','delete not offered');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('write','finance','{}')$q$,'22023','finance not offered');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('write','create_team','{}')$q$,'22023','team administration not offered');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('write','list_tasks','{"limit":101}')$q$,'22023','page size bounded');
select pg_temp.mcp_put('project_page',pg_temp.mcp_call('write','list_projects','{"limit":1}'));
select pg_temp.mcp_assert(jsonb_array_length(pg_temp.mcp_get('project_page')->'items')=1 and pg_temp.mcp_get('project_page')->>'next_cursor' is not null,'project pagination bounded');
select pg_temp.mcp_assert(jsonb_array_length(pg_temp.mcp_call('write','list_projects',jsonb_build_object('limit',1,'cursor',pg_temp.mcp_get('project_page')->>'next_cursor'))->'items')=1,'second project page available');
select pg_temp.mcp_put('created',pg_temp.mcp_call('write','create_project','{"request_id":"f8000029-0000-4000-8000-000000000009","name":"MCP created synthetic"}'));
select pg_temp.mcp_assert(pg_temp.mcp_call('write','create_project','{"request_id":"f8000029-0000-4000-8000-000000000009","name":"MCP created synthetic"}')->>'id'=pg_temp.mcp_get('created')->>'id','create retry uses stable ID');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('write','create_project','{"request_id":"f8000029-0000-4000-8000-000000000009","name":"different"}')$q$,'PT409','request ID cannot be reused with new data');
select pg_temp.mcp_put('task_input',jsonb_build_object('request_id','f8000040-0000-4000-8000-000000000001','project_id',pg_temp.mcp_id('project'),'title','MCP task synthetic','due_date','2026-12-01'));
select pg_temp.mcp_put('task',pg_temp.mcp_call('write','create_task',pg_temp.mcp_get('task_input')));
select pg_temp.mcp_assert(pg_temp.mcp_call('write','create_task',pg_temp.mcp_get('task_input'))->>'id'=pg_temp.mcp_get('task')->>'id','task retry has no duplicate');
select pg_temp.mcp_assert(jsonb_array_length(pg_temp.mcp_call('read','list_tasks')->'items')=1,'read token reads tasks');
select pg_temp.mcp_assert(pg_temp.mcp_call('member','get_task',jsonb_build_object('id',pg_temp.mcp_id('task')))->>'title'='MCP task synthetic','member shared task available');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('write','update_task',jsonb_build_object('id',pg_temp.mcp_id('task'),'version',2,'patch',jsonb_build_object('status','done')))$q$,'PT409','version conflict preserved');
select pg_temp.mcp_put('task',pg_temp.mcp_call('write','update_task',jsonb_build_object('id',pg_temp.mcp_id('task'),'version',1,'patch',jsonb_build_object('status','done'))));
select pg_temp.mcp_assert(pg_temp.mcp_get('task')->>'status'='done' and (pg_temp.mcp_get('task')->>'version')::integer=2,'task completion uses existing command');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('write','update_project',jsonb_build_object('id',pg_temp.mcp_id('project'),'version',1,'patch',jsonb_build_object('owner_id','f8000000-0000-4000-8000-000000000002')))$q$,'22023','server managed project fields rejected');
select pg_temp.mcp_put('task',pg_temp.mcp_call('write','schedule_task',jsonb_build_object('id',pg_temp.mcp_id('task'),'version',2,'scheduled_start_at','2026-12-01T13:00:00Z','scheduled_end_at','2026-12-01T14:00:00Z','scheduled_time_zone','UTC')));
select pg_temp.mcp_assert(pg_temp.mcp_get('task')->>'scheduled_time_zone'='UTC','scheduling uses v3 boundary');
select pg_temp.mcp_assert(jsonb_array_length(pg_temp.mcp_call('read','calendar','{"date_from":"2026-12-01","date_to":"2026-12-03","time_zone":"UTC"}')->'items')>0,'calendar respects credential scope');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('read','calendar',jsonb_build_object('date_from','2026-12-01','date_to','2026-12-03','time_zone','UTC','project_ids',jsonb_build_array(pg_temp.mcp_id('other_project'))))$q$,'PT404','calendar cannot widen workspace');
select pg_temp.mcp_assert(auth.uid() is null,'anonymous identity restored after dispatch');
reset role;
select pg_temp.mcp_assert((select token_hash<>pg_temp.mcp_get('write')->>'token' and length(token_hash)=64 from tr8_private.mcp_credentials where id=pg_temp.mcp_id('write')),'only token hash stored');
select pg_temp.mcp_assert((select count(*)>=4 from tr8_private.mcp_activity where credential_id=pg_temp.mcp_id('write')),'MCP write metadata audited separately');
select pg_temp.mcp_assert((select count(*)=5 from information_schema.columns where table_schema='tr8_private' and table_name='mcp_activity'),'audit contains no business text');
update tr8_private.workspace_members set status='removed' where id='f8000030-0000-4000-8000-000000000003';
set local role anon;
select pg_temp.mcp_error($q$select pg_temp.mcp_call('member','context')$q$,'PT401','removed membership disables existing token');
reset role;
update tr8_private.workspace_members set status='active' where id='f8000030-0000-4000-8000-000000000003';
delete from tr8_private.project_access where workspace_id=pg_temp.mcp_id('team') and member_id='f8000030-0000-4000-8000-000000000003';
set local role anon;
select pg_temp.mcp_assert(jsonb_array_length(pg_temp.mcp_call('member','list_projects')->'items')=0,'project access removal takes effect immediately');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('member','get_task',jsonb_build_object('id',pg_temp.mcp_id('task')))$q$,'PT404','removed project access hides tasks');
reset role;
insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level)
values(pg_temp.mcp_id('team'),pg_temp.mcp_id('project'),'f8000030-0000-4000-8000-000000000003','read');
delete from tr8_private.role_permissions where workspace_id=pg_temp.mcp_id('team') and permission='task.read'
  and role_id=(select id from tr8_private.workspace_roles where workspace_id=pg_temp.mcp_id('team') and template_key='collaborator');
set local role anon;
select pg_temp.mcp_assert(pg_temp.mcp_call('member','get_project',jsonb_build_object('id',pg_temp.mcp_id('project')))->>'name'='MCP shared synthetic','project read survives unrelated task role removal');
select pg_temp.mcp_assert(not (pg_temp.mcp_call('member','context')->'scopes')?'tasks:read','context scopes reflect live role removal');
select pg_temp.mcp_assert(not (pg_temp.mcp_call('member','context')->'scopes')?'tasks:write','write capability requires live task read');
select pg_temp.mcp_error($q$select pg_temp.mcp_call('member','list_tasks')$q$,'PT404','task role removal prevents access');
reset role;
insert into tr8_private.role_permissions(workspace_id,role_id,permission)
select pg_temp.mcp_id('team'),id,'task.read' from tr8_private.workspace_roles where workspace_id=pg_temp.mcp_id('team') and template_key='collaborator';
update tr8_private.app_users set enabled=false where user_id='f8000000-0000-4000-8000-000000000001';
set local role anon;
select pg_temp.mcp_error($q$select pg_temp.mcp_call('write','context')$q$,'PT401','disabled owner disables token');
reset role;
update tr8_private.app_users set enabled=true where user_id='f8000000-0000-4000-8000-000000000001';
update auth.users set banned_until=statement_timestamp()+interval '1 day' where id='f8000000-0000-4000-8000-000000000001';
set local role anon;
select pg_temp.mcp_error($q$select pg_temp.mcp_call('write','context')$q$,'PT401','banned auth owner disables token');
reset role;
update auth.users set banned_until=null where id='f8000000-0000-4000-8000-000000000001';
update tr8_private.mcp_credentials set minute_count=60 where id=pg_temp.mcp_id('write');
set local role anon;
select pg_temp.mcp_error($q$select pg_temp.mcp_call('write','context')$q$,'PT429','minute quota bounded');
reset role;
update tr8_private.mcp_credentials set minute_count=0,day_count=1000 where id=pg_temp.mcp_id('write');
set local role anon;
select pg_temp.mcp_error($q$select pg_temp.mcp_call('write','context')$q$,'PT429','daily quota bounded');
reset role;
update tr8_private.mcp_credentials set day_count=0,created_at=statement_timestamp()-interval '2 days',expires_at=statement_timestamp()-interval '1 day' where id=pg_temp.mcp_id('read');
set local role anon;
select pg_temp.mcp_error($q$select pg_temp.mcp_call('read','context')$q$,'PT401','expired token disabled');
set local role authenticated;
select pg_temp.mcp_actor('f8000000-0000-4000-8000-000000000001');
select pg_temp.mcp_assert(public.tr8_mcp_credentials('revoke',jsonb_build_object('id',pg_temp.mcp_id('write')))->>'revoked_at' is not null,'revocation returns metadata');
set local role anon;
select pg_temp.mcp_actor(null);
select pg_temp.mcp_error($q$select pg_temp.mcp_call('write','context')$q$,'PT401','revocation disables next dispatch');
reset role;
select pg_temp.mcp_assert((select not external_invites_enabled from tr8_private.app_config where singleton),'external onboarding remains disabled');
select pg_temp.mcp_assert((select count(*)=0 from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'tr8_mcp_%' and p.prosecdef),'public MCP wrappers remain invokers');
select pg_temp.mcp_assert((select count(*)=2 from pg_class where oid in ('tr8_private.mcp_credentials'::regclass,'tr8_private.mcp_activity'::regclass) and relrowsecurity),'new private tables have RLS');
select pg_temp.mcp_assert((select digest=(select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p where id=any(e.ids)) from pg_temp.mcp_existing e where entity='projects'),'existing projects unchanged');
select pg_temp.mcp_assert((select digest=(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t where id=any(e.ids)) from pg_temp.mcp_existing e where entity='tasks'),'existing tasks unchanged');
select pg_temp.mcp_assert((select digest=(select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f where owner_id=any(e.ids)) from pg_temp.mcp_existing e where entity='finance'),'all account finances unchanged');
select jsonb_build_object('result','passed','assertions',current_setting('tr8.mcp_test_count')::integer) as mcp_test_result;
rollback;
