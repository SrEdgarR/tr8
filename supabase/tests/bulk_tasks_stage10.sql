-- TEST ONLY: synthetic fixtures and browser sessions. No HTTP, no credentials.
-- Run only in isolated tr8-test. All fixtures and writes roll back.
begin;
select set_config('tr8.bulk_checks','0',true);
create temporary table bulk_values(k text primary key,v jsonb) on commit drop;
create temporary table bulk_existing on commit drop as
 select 'projects' kind,md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) hash,array_agg(id) ids from public.tr8_workspace_projects p
 union all select 'tasks',md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')),array_agg(id) from public.tr8_workspace_tasks t
 union all select 'finances',md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')),array_agg(owner_id) from tr8_private.account_finances f;
create temporary table bulk_config on commit drop as select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) hash from tr8_private.app_config c;
create function pg_temp.b_assert(ok boolean,label text) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'Bulk assertion: %',label;end if;
 perform set_config('tr8.bulk_checks',(current_setting('tr8.bulk_checks')::integer+1)::text,true);
end;$$;
create function pg_temp.b_error(command text,expected text,label text) returns void language plpgsql as $$begin
 begin execute command;exception when others then
  if sqlstate=expected then perform pg_temp.b_assert(true,label);return;end if;
  raise exception 'Bulk expected % got % (%) for %',expected,sqlstate,sqlerrm,label;
 end;raise exception 'Bulk unexpectedly allowed: %',label;
end;$$;
create function pg_temp.b_actor(a uuid) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',coalesce(a::text,''),true);
 perform set_config('request.jwt.claims',case when a is null then '{}' else jsonb_build_object('sub',a,'role','authenticated','session_id',a)::text end,true);
end;$$;
create function pg_temp.b_value(name text) returns jsonb language sql as $$select v from bulk_values where k=$1;$$;
create function pg_temp.b_items(ids uuid[]) returns jsonb language sql as $$
 select jsonb_agg(jsonb_build_object('id',t.id,'project_id',t.project_id,'version',t.version) order by u.ordinality)
 from unnest(ids) with ordinality u(id,ordinality) join public.tr8_workspace_tasks t on t.id=u.id;
$$;
create function pg_temp.b_run(operation jsonb,items jsonb,request uuid default gen_random_uuid()) returns jsonb language sql as $$
 select public.tr8_v2_bulk_tasks('da100000-0000-4000-8000-000000000001',request,(pg_temp.b_value('requested_at')#>>'{}')::timestamptz,operation,items);
$$;
create function pg_temp.b_row(result jsonb,id uuid) returns jsonb language sql as $$select value from jsonb_array_elements(result->'results') where value->>'id'=$2::text;$$;
do $$begin execute format('grant usage on schema %I to authenticated,anon',pg_my_temp_schema()::regnamespace);end;$$;
grant select,insert,update on bulk_values to authenticated;
grant execute on function pg_temp.b_assert(boolean,text),pg_temp.b_error(text,text,text),pg_temp.b_actor(uuid),pg_temp.b_value(text),
 pg_temp.b_items(uuid[]),pg_temp.b_run(jsonb,jsonb,uuid),pg_temp.b_row(jsonb,uuid) to authenticated,anon;
insert into bulk_values values('requested_at',to_jsonb(clock_timestamp()));

select pg_temp.b_assert(not has_function_privilege('anon','public.tr8_v2_bulk_tasks(uuid,uuid,timestamptz,jsonb,jsonb)','execute'),'anonymous endpoint denied');
select pg_temp.b_assert(not has_function_privilege('service_role','public.tr8_v2_bulk_tasks(uuid,uuid,timestamptz,jsonb,jsonb)','execute'),'service role gets no browser capability');
select pg_temp.b_assert(has_function_privilege('authenticated','public.tr8_v2_bulk_tasks(uuid,uuid,timestamptz,jsonb,jsonb)','execute'),'signed-in wrapper available');
select pg_temp.b_assert((select not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.tr8_v2_bulk_tasks(uuid,uuid,timestamptz,jsonb,jsonb)'::regprocedure),'public function is invoker with empty search path');
select pg_temp.b_assert((select relrowsecurity from pg_class where oid='tr8_private.bulk_task_receipts'::regclass),'receipt RLS enabled');
select pg_temp.b_assert(not has_table_privilege('authenticated','tr8_private.bulk_task_receipts','select,insert,update,delete'),'receipt contents private');
select pg_temp.b_assert(not has_table_privilege('authenticated','public.tr8_workspace_tasks','update,delete'),'no direct task write capability');

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 select ('fa100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','bulk-stage10-'||n||'@example.test',now(),'{}','{}',now(),now() from generate_series(1,4)n;
insert into auth.sessions(id,user_id,created_at,updated_at) select id,id,now(),now() from auth.users where id::text like 'fa100000-%';
insert into tr8_private.app_users(user_id,enabled,display_name) select id,true,'Synthetic bulk stage ten' from auth.users where id::text like 'fa100000-%';
set local role authenticated;
select pg_temp.b_actor('fa100000-0000-4000-8000-000000000001');
select public.tr8_v2_get_context();
select public.tr8_v2_create_team('da100000-0000-4000-8000-000000000001','Synthetic bulk workspace');
select public.tr8_v2_create_team('da100000-0000-4000-8000-000000000002','Synthetic unrelated workspace');
select public.tr8_v2_create_project('da100000-0000-4000-8000-000000000001','aa100001-0000-4000-8000-000000000001','Bulk project A','','#5A67D8','active');
select public.tr8_v2_create_project('da100000-0000-4000-8000-000000000001','aa100002-0000-4000-8000-000000000002','Bulk private project B','','#5A67D8','active');
select public.tr8_v2_create_project('da100000-0000-4000-8000-000000000001','aa100003-0000-4000-8000-000000000003','Bulk archived project C','','#5A67D8','active');
select public.tr8_v2_create_project('da100000-0000-4000-8000-000000000002','aa100004-0000-4000-8000-000000000004','Other workspace project','','#5A67D8','active');
select public.tr8_v2_create_task('da100000-0000-4000-8000-000000000001',('ea100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 case when n in (3,4) then 'aa100002-0000-4000-8000-000000000002'::uuid when n=5 then 'aa100003-0000-4000-8000-000000000003'::uuid else 'aa100001-0000-4000-8000-000000000001'::uuid end,
 'Synthetic bulk task '||n,'Synthetic context','todo','none',null,null) from generate_series(1,8)n;
select public.tr8_v2_create_task('da100000-0000-4000-8000-000000000002','ea100000-0000-4000-8000-000000000009','aa100004-0000-4000-8000-000000000004','Synthetic unrelated tenant task','','todo','none',null,null);
insert into bulk_values values('untouched',to_jsonb((select t from public.tr8_workspace_tasks t where id='ea100000-0000-4000-8000-000000000004')));
insert into bulk_values values('other_workspace',to_jsonb((select t from public.tr8_workspace_tasks t where id='ea100000-0000-4000-8000-000000000009')));
insert into bulk_values values('foreign_items',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000009'::uuid]));
reset role;
insert into tr8_private.workspace_members(id,workspace_id,user_id) values
 ('ba100000-0000-4000-8000-000000000002','da100000-0000-4000-8000-000000000001','fa100000-0000-4000-8000-000000000002'),
 ('ba100000-0000-4000-8000-000000000003','da100000-0000-4000-8000-000000000001','fa100000-0000-4000-8000-000000000003');
insert into tr8_private.workspace_roles(id,workspace_id,name) values
 ('ca100000-0000-4000-8000-000000000002','da100000-0000-4000-8000-000000000001','Synthetic edit only'),
 ('ca100000-0000-4000-8000-000000000003','da100000-0000-4000-8000-000000000001','Synthetic assign only');
insert into tr8_private.role_permissions(workspace_id,role_id,permission)
 select 'da100000-0000-4000-8000-000000000001'::uuid,'ca100000-0000-4000-8000-000000000002'::uuid,unnest(array['project.read','task.read','task.edit'])
 union all select 'da100000-0000-4000-8000-000000000001'::uuid,'ca100000-0000-4000-8000-000000000003'::uuid,unnest(array['project.read','task.read','task.assign']);
insert into tr8_private.member_roles(workspace_id,member_id,role_id) values
 ('da100000-0000-4000-8000-000000000001','ba100000-0000-4000-8000-000000000002','ca100000-0000-4000-8000-000000000002'),
 ('da100000-0000-4000-8000-000000000001','ba100000-0000-4000-8000-000000000003','ca100000-0000-4000-8000-000000000003');
insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level) values
 ('da100000-0000-4000-8000-000000000001','aa100001-0000-4000-8000-000000000001','ba100000-0000-4000-8000-000000000002','write'),
 ('da100000-0000-4000-8000-000000000001','aa100001-0000-4000-8000-000000000001','ba100000-0000-4000-8000-000000000003','write');
-- Synthetic Google identity, no network or usable grant. Existing captures must
-- see bulk writes through exactly the same path as individual writes.
insert into tr8_private.google_connections(id,user_id,generation,state,tasks_granted,calendar_id,credential_envelope)
 values('cfa10000-0000-4000-8000-000000000001','fa100000-0000-4000-8000-000000000001',1,'connected',true,'synthetic-bulk@group.calendar.google.com','{"v":1,"kid":"synthetic","iv":"AAAAAAAAAAAAAAAA","ciphertext":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}');
insert into tr8_private.google_tasks_sync(connection_id,generation,enabled) values('cfa10000-0000-4000-8000-000000000001',1,true);
insert into tr8_private.google_tasks_lists(connection_id,generation,list_id,title,selected) values('cfa10000-0000-4000-8000-000000000001',1,'synthetic-bulk-list','Synthetic',true);
insert into bulk_values values('owner_member',to_jsonb((select id from tr8_private.workspace_members where workspace_id='da100000-0000-4000-8000-000000000001' and user_id='fa100000-0000-4000-8000-000000000001')));
set local role authenticated;
select public.tr8_v2_assign_task('da100000-0000-4000-8000-000000000001','ea100000-0000-4000-8000-000000000006',1,(pg_temp.b_value('owner_member')#>>'{}')::uuid);
reset role;
insert into tr8_private.google_tasks_links(id,connection_id,generation,list_id,remote_task_id,workspace_id,project_id,local_task_id,local_task_created_at,state,origin,creation_state,creation_marker,base_projection_hash,synced_local_hash)
 select 'cfa10000-0000-4000-8000-000000000002','cfa10000-0000-4000-8000-000000000001',1,'synthetic-bulk-list','synthetic-bulk-remote','da100000-0000-4000-8000-000000000001',project_id,id,created_at,'synced','tr8','bound','tr8:cfa10000-0000-4000-8000-000000000003',tr8_private.v6_projection_hash(tr8_private.v6_task_projection(id,created_at)),tr8_private.v6_projection_hash(tr8_private.v6_task_projection(id,created_at))
 from public.tr8_workspace_tasks where id='ea100000-0000-4000-8000-000000000001';
insert into tr8_private.google_tasks_links(id,connection_id,generation,list_id,remote_task_id,workspace_id,project_id,local_task_id,local_task_created_at,state,origin,creation_state,creation_marker,base_projection_hash,synced_local_hash)
 select 'cfa10000-0000-4000-8000-000000000006','cfa10000-0000-4000-8000-000000000001',1,'synthetic-bulk-list','synthetic-bulk-archive','da100000-0000-4000-8000-000000000001',project_id,id,created_at,'synced','tr8','bound','tr8:cfa10000-0000-4000-8000-000000000006',tr8_private.v6_projection_hash(tr8_private.v6_task_projection(id,created_at)),tr8_private.v6_projection_hash(tr8_private.v6_task_projection(id,created_at))
 from public.tr8_workspace_tasks where id='ea100000-0000-4000-8000-000000000006';
insert into tr8_private.google_tasks_jobs(id,connection_id,generation,kind,link_id,list_id,state,lease_token,lease_expires_at,attempts,leased_revision)
 values('cfa10000-0000-4000-8000-000000000007','cfa10000-0000-4000-8000-000000000001',1,'patch','cfa10000-0000-4000-8000-000000000006','synthetic-bulk-list','leased','cfa10000-0000-4000-8000-000000000008',now()+interval '5 minutes',1,1);
set local role authenticated;
insert into bulk_values values('pair',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000001'::uuid,'ea100000-0000-4000-8000-000000000003'::uuid]));
insert into bulk_values values('status',pg_temp.b_run('{"kind":"status","status":"done"}',pg_temp.b_value('pair'),'0a100000-0000-4000-8000-000000000001'));
select pg_temp.b_assert((select bool_and(value->>'outcome'='applied' and value->'code'='null'::jsonb) from jsonb_array_elements(pg_temp.b_value('status')->'results')),'status applies to two authorized projects');
select pg_temp.b_assert((select count(*)=2 from jsonb_object_keys(pg_temp.b_value('status'))) and not exists(select 1 from jsonb_array_elements(pg_temp.b_value('status')->'results')r where (select count(*) from jsonb_object_keys(r))<>3),'results contain only request identifier and minimal per-task outcomes');
select pg_temp.b_assert((select bool_and(status='done') from public.tr8_workspace_tasks where id in('ea100000-0000-4000-8000-000000000001','ea100000-0000-4000-8000-000000000003')),'task status persisted');
select pg_temp.b_assert(pg_temp.b_run('{"kind":"status","status":"done"}',pg_temp.b_value('pair'),'0a100000-0000-4000-8000-000000000001')=pg_temp.b_value('status'),'exact replay returns same result after versions advanced');
select pg_temp.b_assert((select bool_and(version=2) from public.tr8_workspace_tasks where id in('ea100000-0000-4000-8000-000000000001','ea100000-0000-4000-8000-000000000003')),'replay does not increment versions again');
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"status","status":"review"}',pg_temp.b_value('pair'),'0a100000-0000-4000-8000-000000000001')$q$,'PT409','request id cannot change operation');
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"status","status":"done"}',jsonb_build_array(pg_temp.b_value('pair')->1,pg_temp.b_value('pair')->0),'0a100000-0000-4000-8000-000000000001')$q$,'PT409','request id cannot change captured item order');
select pg_temp.b_error($q$select public.tr8_v2_bulk_tasks('da100000-0000-4000-8000-000000000001','0a100000-0000-4000-8000-000000000001',(pg_temp.b_value('requested_at')#>>'{}')::timestamptz+interval '1 second','{"kind":"status","status":"done"}',pg_temp.b_value('pair'))$q$,'PT409','request id cannot silently refresh its captured request time');
reset role;
select pg_temp.b_assert((select count(*)=2 from tr8_private.workspace_activity where workspace_id='da100000-0000-4000-8000-000000000001' and action='task.updated'),'exact retry does not duplicate audit');
select pg_temp.b_assert(exists(select 1 from tr8_private.google_tasks_jobs where connection_id='cfa10000-0000-4000-8000-000000000001' and kind='patch' and state='pending'),'completion preserves Google Tasks outbox');
set local role authenticated;
insert into bulk_values values('partial',pg_temp.b_run('{"kind":"priority","priority":"high"}',jsonb_build_array(pg_temp.b_value('pair')->0)||pg_temp.b_items(array['ea100000-0000-4000-8000-000000000002'::uuid])));
select pg_temp.b_assert(pg_temp.b_row(pg_temp.b_value('partial'),'ea100000-0000-4000-8000-000000000001')->>'code'='PT409','stale first task explicitly rejected');
select pg_temp.b_assert(pg_temp.b_row(pg_temp.b_value('partial'),'ea100000-0000-4000-8000-000000000002')->>'outcome'='applied','valid second task applies in partial batch');
select pg_temp.b_assert((select priority='none' from public.tr8_workspace_tasks where id='ea100000-0000-4000-8000-000000000001'),'stale row untouched');
select pg_temp.b_assert((select priority='high' from public.tr8_workspace_tasks where id='ea100000-0000-4000-8000-000000000002'),'valid priority persists');
insert into bulk_values values('current_pair',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000001'::uuid,'ea100000-0000-4000-8000-000000000003'::uuid]));
insert into bulk_values values('assigned',pg_temp.b_run('{"kind":"assign","assignee_member_id":"ba100000-0000-4000-8000-000000000002"}',pg_temp.b_value('current_pair'),'0a100000-0000-4000-8000-000000000002'));
select pg_temp.b_assert(pg_temp.b_row(pg_temp.b_value('assigned'),'ea100000-0000-4000-8000-000000000001')->>'outcome'='applied','eligible assignee accepted');
select pg_temp.b_assert(pg_temp.b_row(pg_temp.b_value('assigned'),'ea100000-0000-4000-8000-000000000003')->>'code'='22023','same assignee denied in inaccessible private project');
select pg_temp.b_assert(pg_temp.b_run('{"kind":"assign","assignee_member_id":"ba100000-0000-4000-8000-000000000002"}',pg_temp.b_value('current_pair'),'0a100000-0000-4000-8000-000000000002')=pg_temp.b_value('assigned'),'assignment partial replay exact');
reset role;
select pg_temp.b_assert((select count(*)=1 from tr8_private.communication_notifications where workspace_id='da100000-0000-4000-8000-000000000001' and kind='assignment'),'assignment captures one notification without duplicates');
set local role authenticated;
select pg_temp.b_run('{"kind":"assign","assignee_member_id":null}',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000001'::uuid]));
reset role;
select pg_temp.b_assert(not exists(select 1 from tr8_private.communication_notifications where workspace_id='da100000-0000-4000-8000-000000000001' and kind='assignment'),'unassignment retires assignment notification');
set local role authenticated;
select pg_temp.b_actor('fa100000-0000-4000-8000-000000000003');
select pg_temp.b_assert((pg_temp.b_run('{"kind":"assign","assignee_member_id":"ba100000-0000-4000-8000-000000000003"}',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000002'::uuid]))->'results'->0->>'outcome')='applied','assign-only delegate does not need task.edit');
select pg_temp.b_assert((pg_temp.b_run('{"kind":"priority","priority":"urgent"}',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000002'::uuid]))->'results'->0->>'code')='PT404','assign-only delegate cannot edit priority');
select pg_temp.b_assert((pg_temp.b_run('{"kind":"delete"}',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000002'::uuid]))->'results'->0->>'code')='PT404','assign-only delegate cannot delete');
select pg_temp.b_actor('fa100000-0000-4000-8000-000000000001');
insert into bulk_values values('archive_items',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000006'::uuid,'ea100000-0000-4000-8000-000000000001'::uuid]));
insert into bulk_values values('archived',pg_temp.b_run('{"kind":"archive"}',pg_temp.b_value('archive_items'),'0a100000-0000-4000-8000-000000000003'));
select pg_temp.b_assert((select bool_and(archived_at is not null) from public.tr8_workspace_tasks where id in('ea100000-0000-4000-8000-000000000006','ea100000-0000-4000-8000-000000000001')),'bulk archive persists without deleting tasks');
select pg_temp.b_assert(pg_temp.b_run('{"kind":"archive"}',pg_temp.b_value('archive_items'),'0a100000-0000-4000-8000-000000000003')=pg_temp.b_value('archived'),'archive exact replay no second mutation');
select pg_temp.b_assert((pg_temp.b_run('{"kind":"status","status":"todo"}',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000006'::uuid]))->'results'->0->>'code')='PT409','archived task cannot change status');
select pg_temp.b_assert((pg_temp.b_run('{"kind":"assign","assignee_member_id":null}',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000006'::uuid]))->'results'->0->>'code')='PT409','archived task cannot change assignee');
select pg_temp.b_assert((pg_temp.b_run('{"kind":"delete"}',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000006'::uuid]))->'results'->0->>'code')='PT409','archived task outside active bulk deletion');
reset role;
select pg_temp.b_assert((select state='cancelled' and lease_token is null and reason='task_archived' from tr8_private.google_tasks_jobs where id='cfa10000-0000-4000-8000-000000000007'),'archive fences eligible provider lease through existing path');
set local role authenticated;
select public.tr8_v2_update_project('da100000-0000-4000-8000-000000000001','aa100003-0000-4000-8000-000000000003',1,jsonb_build_object('archived_at',clock_timestamp()));
select pg_temp.b_assert((pg_temp.b_run('{"kind":"delete"}',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000005'::uuid]))->'results'->0->>'code')='PT409','archived project rejects bulk writes');
insert into bulk_values values('delete_items',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000008'::uuid])||jsonb_build_array(jsonb_build_object('id','ea100000-0000-4000-8000-000000000002','project_id','aa100001-0000-4000-8000-000000000001','version',1)));
insert into bulk_values values('deleted',pg_temp.b_run('{"kind":"delete"}',pg_temp.b_value('delete_items'),'0a100000-0000-4000-8000-000000000004'));
select pg_temp.b_assert(pg_temp.b_row(pg_temp.b_value('deleted'),'ea100000-0000-4000-8000-000000000008')->>'outcome'='applied','selected valid task deleted');
select pg_temp.b_assert(pg_temp.b_row(pg_temp.b_value('deleted'),'ea100000-0000-4000-8000-000000000002')->>'code'='PT409','stale selected task not deleted');
select pg_temp.b_assert(not exists(select 1 from public.tr8_workspace_tasks where id='ea100000-0000-4000-8000-000000000008'),'deleted row really absent');
select pg_temp.b_assert(exists(select 1 from public.tr8_workspace_tasks where id='ea100000-0000-4000-8000-000000000002'),'other row survives partial deletion');
select pg_temp.b_assert(pg_temp.b_run('{"kind":"delete"}',pg_temp.b_value('delete_items'),'0a100000-0000-4000-8000-000000000004')=pg_temp.b_value('deleted'),'delete replay recognizes result although task no longer exists');
insert into bulk_values values('moved_capture',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000007'::uuid]));
select public.tr8_v2_work_management('da100000-0000-4000-8000-000000000001','move_task','{"id":"ea100000-0000-4000-8000-000000000007","version":1,"target_project_id":"aa100002-0000-4000-8000-000000000002","request_id":"0a100000-0000-4000-8000-000000000007","clear_assignee":false}');
select pg_temp.b_assert((pg_temp.b_run('{"kind":"priority","priority":"urgent"}',jsonb_set(pg_temp.b_value('moved_capture'),'{0,version}','2'))->'results'->0->>'code')='PT404','moved task cannot mutate via captured project even with current version');
select pg_temp.b_assert((select priority='none' from public.tr8_workspace_tasks where id='ea100000-0000-4000-8000-000000000007'),'moved task preserved');
insert into bulk_values values('cross_workspace',pg_temp.b_run('{"kind":"priority","priority":"medium"}',pg_temp.b_value('foreign_items')||pg_temp.b_items(array['ea100000-0000-4000-8000-000000000002'::uuid])));
select pg_temp.b_assert(pg_temp.b_row(pg_temp.b_value('cross_workspace'),'ea100000-0000-4000-8000-000000000009')->>'code'='PT404','foreign workspace item indistinguishable from absent');
select pg_temp.b_assert(pg_temp.b_row(pg_temp.b_value('cross_workspace'),'ea100000-0000-4000-8000-000000000002')->>'outcome'='applied','same-workspace valid row still succeeds');

-- Unknown failures must abort all earlier writes in this request. A synthetic
-- trigger raises only for the fixture id and is removed before the next checks.
insert into bulk_values values('unexpected_before',to_jsonb((select t from public.tr8_workspace_tasks t where id='ea100000-0000-4000-8000-000000000003')));
insert into bulk_values values('unexpected_items',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000003'::uuid,'ea100000-0000-4000-8000-000000000002'::uuid]));
reset role;
create function pg_temp.b_explode() returns trigger language plpgsql as $$begin raise exception using errcode='XX000',message='Synthetic bulk infrastructure failure';end;$$;
create trigger synthetic_bulk_infrastructure_failure before update on public.tr8_workspace_tasks
 for each row when (new.id='ea100000-0000-4000-8000-000000000002'::uuid) execute function pg_temp.b_explode();
set local role authenticated;
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"priority","priority":"urgent"}',pg_temp.b_value('unexpected_items'),'0a100000-0000-4000-8000-000000000030')$q$,'XX000','unknown failure propagates instead of a fabricated partial success');
select pg_temp.b_assert(pg_temp.b_value('unexpected_before')=to_jsonb((select t from public.tr8_workspace_tasks t where id='ea100000-0000-4000-8000-000000000003')),'unknown failure rolls back earlier valid row');
reset role;
drop trigger synthetic_bulk_infrastructure_failure on public.tr8_workspace_tasks;
select pg_temp.b_assert(not exists(select 1 from tr8_private.bulk_task_receipts where owner_id='fa100000-0000-4000-8000-000000000001' and request_id='0a100000-0000-4000-8000-000000000030'),'failed transaction creates no receipt');
set local role authenticated;

-- A malformed final element rejects the entire envelope before any task write.
insert into bulk_values values('validation_task',to_jsonb((select t from public.tr8_workspace_tasks t where id='ea100000-0000-4000-8000-000000000002')));
insert into bulk_values values('validation_items',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000002'::uuid]));
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"status","status":"done"}',pg_temp.b_value('validation_items')||'[{"id":"bad","project_id":"aa100001-0000-4000-8000-000000000001","version":1}]')$q$,'22023','bad last identifier rejects whole batch');
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"status","status":"done"}',pg_temp.b_value('validation_items')||pg_temp.b_value('validation_items'))$q$,'22023','duplicate task identifiers rejected');
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"status","status":"done"}',jsonb_set(pg_temp.b_value('validation_items'),'{0,version}','1.5'))$q$,'22023','fractional expected version rejected');
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"status","status":"done"}',jsonb_set(pg_temp.b_value('validation_items'),'{0,version}','2147483648'))$q$,'22023','out-of-range version rejected');
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"status","status":"done","owner_id":"forged"}',pg_temp.b_value('validation_items'))$q$,'22023','unknown operation field rejected');
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"status","status":null}',pg_temp.b_value('validation_items'))$q$,'22023','null status rejected');
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"assign"}',pg_temp.b_value('validation_items'))$q$,'22023','missing assignment field rejected');
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"assign","assignee_member_id":"not-a-member"}',pg_temp.b_value('validation_items'))$q$,'22023','malformed assignee globally rejected');
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"delete"}','[]')$q$,'22023','empty batch rejected');
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"delete"}','{}')$q$,'22023','nonarray batch rejected');
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"delete"}',(select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'project_id','aa100001-0000-4000-8000-000000000001','version',1)) from generate_series(1,51)))$q$,'22023','fifty-one items rejected');
select pg_temp.b_assert(pg_temp.b_value('validation_task')=to_jsonb((select t from public.tr8_workspace_tasks t where id='ea100000-0000-4000-8000-000000000002')),'all malformed batches preserve every valid first item');
select pg_temp.b_error($q$select public.tr8_v2_bulk_tasks('da100000-0000-4000-8000-000000000001',gen_random_uuid(),clock_timestamp()-interval '25 hours','{"kind":"delete"}',pg_temp.b_value('validation_items'))$q$,'PT410','expired request cannot execute');
select pg_temp.b_error($q$select public.tr8_v2_bulk_tasks('da100000-0000-4000-8000-000000000001',gen_random_uuid(),clock_timestamp()+interval '6 minutes','{"kind":"delete"}',pg_temp.b_value('validation_items'))$q$,'PT410','excessively future request cannot execute');
select pg_temp.b_error($q$select public.tr8_v2_bulk_tasks('da100000-0000-4000-8000-000000000001',gen_random_uuid(),null,'{"kind":"delete"}',pg_temp.b_value('validation_items'))$q$,'22023','missing request time rejected');
select pg_temp.b_assert(pg_temp.b_value('validation_task')=to_jsonb((select t from public.tr8_workspace_tasks t where id='ea100000-0000-4000-8000-000000000002')),'expired requests do not delete or edit tasks');
insert into bulk_values values('fifty',(select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'project_id','aa100001-0000-4000-8000-000000000001','version',1)) from generate_series(1,50)));
select pg_temp.b_assert(jsonb_array_length(pg_temp.b_run('{"kind":"delete"}',pg_temp.b_value('fifty'))->'results')=50,'fifty-item boundary accepted with explicit unavailable results');

-- Project and membership access is checked again even for exact receipt retries.
select pg_temp.b_actor('fa100000-0000-4000-8000-000000000002');
insert into bulk_values values('member_items',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000002'::uuid]));
insert into bulk_values values('member_result',pg_temp.b_run('{"kind":"priority","priority":"low"}',pg_temp.b_value('member_items'),'0a100000-0000-4000-8000-000000000020'));
select pg_temp.b_assert(pg_temp.b_value('member_result')->'results'->0->>'outcome'='applied','authorized member edits own explicit project');
select pg_temp.b_assert((pg_temp.b_run('{"kind":"priority","priority":"urgent"}',jsonb_build_array(jsonb_build_object('id','ea100000-0000-4000-8000-000000000003','project_id','aa100002-0000-4000-8000-000000000002','version',2)))->'results'->0->>'code')='PT404','team membership does not open private project');
reset role;
delete from tr8_private.project_access where workspace_id='da100000-0000-4000-8000-000000000001' and member_id='ba100000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.b_assert((pg_temp.b_run('{"kind":"priority","priority":"low"}',pg_temp.b_value('member_items'),'0a100000-0000-4000-8000-000000000020')->'results'->0->>'code')='PT404','revoked ACL redacts even an exact applied receipt');
reset role;
update tr8_private.workspace_members set status='removed' where id='ba100000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"priority","priority":"low"}',pg_temp.b_value('member_items'),'0a100000-0000-4000-8000-000000000020')$q$,'PT404','removed member cannot replay workspace batch');
select pg_temp.b_actor('fa100000-0000-4000-8000-000000000004');
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"delete"}',pg_temp.b_value('validation_items'))$q$,'PT404','unrelated live user cannot use workspace');
select pg_temp.b_actor('fa100000-0000-4000-8000-000000000001');

-- Rolling request budget: no partial mutation, no permanent lifetime cap, and
-- an exact replay still works at the limit without charging another request.
reset role;
insert into tr8_private.bulk_task_receipts(owner_id,workspace_id,request_id,payload_hash,results)
 select 'fa100000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000001',gen_random_uuid(),repeat('0',64),
 '[{"id":"ea100000-0000-4000-8000-000000000002","outcome":"rejected","code":"PT404"}]'::jsonb
 from generate_series(1,1000-(select count(*)::integer from tr8_private.bulk_task_receipts where owner_id='fa100000-0000-4000-8000-000000000001' and workspace_id='da100000-0000-4000-8000-000000000001'));
insert into bulk_values values('budget_before',to_jsonb((select t from public.tr8_workspace_tasks t where id='ea100000-0000-4000-8000-000000000002')));
set local role authenticated;
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"delete"}',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000002'::uuid]))$q$,'PT429','new request at rolling limit denied globally before deletion');
select pg_temp.b_assert(pg_temp.b_value('budget_before')=to_jsonb((select t from public.tr8_workspace_tasks t where id='ea100000-0000-4000-8000-000000000002')),'budget failure leaves selected task intact');
select pg_temp.b_assert(pg_temp.b_run('{"kind":"delete"}',pg_temp.b_value('delete_items'),'0a100000-0000-4000-8000-000000000004')=pg_temp.b_value('deleted'),'exact replay allowed while budget exhausted');
reset role;
select pg_temp.b_assert((select count(*)=1000 from tr8_private.bulk_task_receipts where owner_id='fa100000-0000-4000-8000-000000000001' and workspace_id='da100000-0000-4000-8000-000000000001'),'retries and quota rejections consume no further receipts');
update tr8_private.bulk_task_receipts set created_at=clock_timestamp()-interval '25 hours'
 where owner_id='fa100000-0000-4000-8000-000000000001' and workspace_id='da100000-0000-4000-8000-000000000001' and payload_hash=repeat('0',64);
insert into tr8_private.bulk_task_receipts(owner_id,workspace_id,request_id,payload_hash,results,created_at) values
 ('fa100000-0000-4000-8000-000000000001','da100000-0000-4000-8000-000000000001','0a100000-0000-4000-8000-000000000099',repeat('0',64),'[{"id":"ea100000-0000-4000-8000-000000000002","outcome":"rejected","code":"PT404"}]',clock_timestamp()-interval '8 days');
set local role authenticated;
select pg_temp.b_assert((pg_temp.b_run('{"kind":"priority","priority":"high"}',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000002'::uuid]))->'results'->0->>'outcome')='applied','budget resets as twenty-four-hour window advances');
reset role;
select pg_temp.b_assert(not exists(select 1 from tr8_private.bulk_task_receipts where owner_id='fa100000-0000-4000-8000-000000000001' and request_id='0a100000-0000-4000-8000-000000000099'),'seven-day cleanup removes expired receipt');
select pg_temp.b_assert(exists(select 1 from tr8_private.bulk_task_receipts where owner_id='fa100000-0000-4000-8000-000000000001' and request_id='0a100000-0000-4000-8000-000000000004'),'cleanup retains still-supported receipt');
set local role authenticated;
select pg_temp.b_error($q$select public.tr8_v2_bulk_tasks('da100000-0000-4000-8000-000000000001','0a100000-0000-4000-8000-000000000099',clock_timestamp()-interval '8 days','{"kind":"delete"}',pg_temp.b_items(array['ea100000-0000-4000-8000-000000000002'::uuid]))$q$,'PT410','receipt removed by cleanup never re-executes expired input');
reset role;
delete from auth.sessions where id='fa100000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"delete"}',pg_temp.b_value('delete_items'),'0a100000-0000-4000-8000-000000000004')$q$,'42501','terminated browser session cannot replay successful delete');
select pg_temp.b_actor(null);
select pg_temp.b_error($q$select pg_temp.b_run('{"kind":"delete"}',pg_temp.b_value('validation_items'))$q$,'42501','missing browser actor denied');
reset role;
select pg_temp.b_assert(pg_temp.b_value('untouched')=to_jsonb((select t from public.tr8_workspace_tasks t where id='ea100000-0000-4000-8000-000000000004')),'unselected task in same project preserved exactly');
select pg_temp.b_assert(pg_temp.b_value('other_workspace')=to_jsonb((select t from public.tr8_workspace_tasks t where id='ea100000-0000-4000-8000-000000000009')),'other workspace task preserved exactly');
select pg_temp.b_assert((select hash from bulk_existing where kind='projects')=(select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p where p.id=any((select ids from bulk_existing where kind='projects')::uuid[])),'all pre-existing project rows preserved');
select pg_temp.b_assert((select hash from bulk_existing where kind='tasks')=(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t where t.id=any((select ids from bulk_existing where kind='tasks')::uuid[])),'all pre-existing task rows preserved');
select pg_temp.b_assert((select hash from bulk_existing where kind='finances')=(select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f where f.owner_id=any((select ids from bulk_existing where kind='finances')::uuid[])),'financial documents preserved');
select pg_temp.b_assert((select hash from bulk_config)=(select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c),'feature and signup configuration preserved');
select current_setting('tr8.bulk_checks')::integer as passed_bulk_checks;
rollback;
