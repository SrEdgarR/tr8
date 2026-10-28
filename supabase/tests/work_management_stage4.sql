-- TEST ONLY: synthetic fixtures, no Google HTTP, no credentials; everything rolls back.
begin;
select set_config('tr8.wm_checks','0',true);
create temporary table wm_values(k text primary key,v jsonb) on commit drop;
create temporary table wm_existing on commit drop as
 select 'projects' kind,md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) hash,array_agg(id) ids from public.tr8_workspace_projects p
 union all select 'tasks',md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')),array_agg(id) from public.tr8_workspace_tasks t
 union all select 'finances',md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')),array_agg(owner_id) from tr8_private.account_finances f;
create function pg_temp.wm_assert(ok boolean,label text) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'Work management assertion: %',label;end if;
 perform set_config('tr8.wm_checks',(current_setting('tr8.wm_checks')::integer+1)::text,true);
end;$$;
create function pg_temp.wm_error(command text,code text,label text) returns void language plpgsql as $$begin
 begin execute command;exception when others then
  if sqlstate=code then perform pg_temp.wm_assert(true,label);return;end if;
  raise exception 'Work management expected % got % (%) for %',code,sqlstate,sqlerrm,label;
 end;raise exception 'Work management unexpectedly allowed: %',label;
end;$$;
create function pg_temp.wm_actor(a uuid) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',coalesce(a::text,''),true);
 perform set_config('request.jwt.claims',case when a is null then '{}' else jsonb_build_object('sub',a,'role','authenticated','session_id',a)::text end,true);
end;$$;
create function pg_temp.wm_fields(name text default 'Synthetic project') returns jsonb language sql as $$
 select jsonb_build_object('name',name,'description','Synthetic context','color','#5A67D8','icon','globe','status','active','start_date',null,'due_date',null,'lead_member_id',null,'template_key',null);
$$;
create function pg_temp.wm(a text,i jsonb) returns jsonb language sql as $$select public.tr8_v2_work_management('d9400000-0000-4000-8000-000000000001',a,i);$$;
create function pg_temp.wm_value(k text) returns jsonb language sql as $$select v from wm_values where wm_values.k=$1;$$;
create function pg_temp.wm_task_args(id uuid,extra jsonb default '{}') returns jsonb language sql as $$select jsonb_build_object('id',$1,'version',t.version)||extra from public.tr8_workspace_tasks t where t.id=$1;$$;
do $$begin execute format('grant usage on schema %I to authenticated,anon',pg_my_temp_schema()::regnamespace);end;$$;
grant select,insert,update on wm_values to authenticated;
grant execute on function pg_temp.wm_assert(boolean,text),pg_temp.wm_error(text,text,text),pg_temp.wm_actor(uuid),pg_temp.wm_fields(text),pg_temp.wm(text,jsonb),pg_temp.wm_value(text),pg_temp.wm_task_args(uuid,jsonb) to authenticated,anon;

select pg_temp.wm_assert(not has_function_privilege('anon','public.tr8_v2_work_management(uuid,text,jsonb)','execute'),'anonymous endpoint denied');
select pg_temp.wm_assert(not has_function_privilege('service_role','public.tr8_v2_work_management(uuid,text,jsonb)','execute'),'service role gets no browser capability');
select pg_temp.wm_assert(has_function_privilege('authenticated','public.tr8_v2_work_management(uuid,text,jsonb)','execute'),'authenticated wrapper exists');
select pg_temp.wm_assert((select not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.tr8_v2_work_management(uuid,text,jsonb)'::regprocedure),'public wrapper invoker and empty search_path');
select pg_temp.wm_assert((select relrowsecurity from pg_class where oid='tr8_private.work_management_receipts'::regclass),'receipt table RLS');
select pg_temp.wm_assert(not has_table_privilege('authenticated','tr8_private.work_management_receipts','select'),'receipt content private');
select pg_temp.wm_assert(not has_table_privilege('authenticated','public.tr8_workspace_tasks','update'),'no direct task write grant');
select pg_temp.wm_assert(not has_table_privilege('authenticated','public.tr8_workspace_projects','insert'),'no direct project write grant');

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 select ('f9400000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','stage4-'||n||'@example.test',now(),'{}','{}',now(),now() from generate_series(1,3)n;
insert into auth.sessions(id,user_id,created_at,updated_at) select id,id,now(),now() from auth.users where id::text like 'f9400000-%';
insert into tr8_private.app_users(user_id,enabled,display_name) select id,true,'Synthetic stage four' from auth.users where id::text like 'f9400000-%';
set local role authenticated;
select pg_temp.wm_actor('f9400000-0000-4000-8000-000000000001');
insert into wm_values values('context',public.tr8_v2_get_context());
select public.tr8_v2_create_team('d9400000-0000-4000-8000-000000000001','Synthetic work management');
insert into wm_values values('projectA',pg_temp.wm('create_project',jsonb_build_object('id','a9401001-0000-4000-8000-000000000001','input',pg_temp.wm_fields())));
insert into wm_values values('projectB',pg_temp.wm('create_project',jsonb_build_object('id','a9401002-0000-4000-8000-000000000002','input',pg_temp.wm_fields('Synthetic target'))));
select pg_temp.wm_assert(pg_temp.wm_value('projectA')->>'version'='1' and pg_temp.wm_value('projectA')->'start_date'='null'::jsonb,'create adds planning without fake dates');
select pg_temp.wm_assert(pg_temp.wm('create_project',jsonb_build_object('id','a9401001-0000-4000-8000-000000000001','input',pg_temp.wm_fields()))=pg_temp.wm_value('projectA'),'exact project create retry');
select pg_temp.wm_error($q$select pg_temp.wm('create_project',jsonb_build_object('id','a9401001-0000-4000-8000-000000000001','input',pg_temp.wm_fields('Changed')))$q$,'PT409','reused UUID cannot duplicate or change a project');
select pg_temp.wm_error($q$select pg_temp.wm('create_project',jsonb_build_object('id','a9401009-0000-4000-8000-000000000009','input',pg_temp.wm_fields()||'{"owner_id":"f9400000-0000-4000-8000-000000000002"}'))$q$,'22023','unknown project ownership rejected');
select pg_temp.wm_error($q$select pg_temp.wm('create_project',jsonb_build_object('id','a9401009-0000-4000-8000-000000000009','input',pg_temp.wm_fields()||'{"start_date":"2026-12-01","due_date":"2026-11-01"}'))$q$,'22023','project date range validated');
select pg_temp.wm_error($q$select pg_temp.wm('create_project',jsonb_build_object('id','a9401009-0000-4000-8000-000000000009','input',pg_temp.wm_fields()||'{"template_key":"untrusted"}'))$q$,'22023','only finite project templates');
insert into wm_values values('template',pg_temp.wm('create_project',jsonb_build_object('id','a9401003-0000-4000-8000-000000000003','input',pg_temp.wm_fields('Synthetic template')||'{"template_key":"website"}')));
select pg_temp.wm_assert((select count(*)=5 from public.tr8_workspace_tasks where project_id='a9401003-0000-4000-8000-000000000003'),'template creates exactly five real tasks');
select pg_temp.wm('create_project',jsonb_build_object('id','a9401003-0000-4000-8000-000000000003','input',pg_temp.wm_fields('Synthetic template')||'{"template_key":"website"}'));
select pg_temp.wm_assert((select count(*)=5 from public.tr8_workspace_tasks where project_id='a9401003-0000-4000-8000-000000000003'),'template retry never duplicates tasks');
insert into wm_values values('taskA',to_jsonb(public.tr8_v2_create_task('d9400000-0000-4000-8000-000000000001','e9400000-0000-4000-8000-000000000001','a9401001-0000-4000-8000-000000000001','Synthetic task A','Context','done','high','2026-10-28','2026-11-01')));
select public.tr8_v2_create_task('d9400000-0000-4000-8000-000000000001','e9400000-0000-4000-8000-000000000002','a9401001-0000-4000-8000-000000000001','Synthetic task A2','','todo','none',null,null);
select public.tr8_v2_create_task('d9400000-0000-4000-8000-000000000001','e9400000-0000-4000-8000-000000000003','a9401001-0000-4000-8000-000000000001','Synthetic task A3','','todo','none',null,null);
select public.tr8_v2_create_task('d9400000-0000-4000-8000-000000000001','e9400000-0000-4000-8000-000000000004','a9401002-0000-4000-8000-000000000002','Synthetic unrelated task','','todo','none',null,null);
insert into wm_values values('other_task',to_jsonb((select t from public.tr8_workspace_tasks t where id='e9400000-0000-4000-8000-000000000004')));
insert into wm_values values('details','{"labels":["Diseño","Validación"],"estimate_minutes":90,"subtasks":[{"id":"b9400000-0000-4000-8000-000000000010","title":"Revisar teclado","done":true}]}');
update wm_values set v=pg_temp.wm('update_task_details',pg_temp.wm_task_args('e9400000-0000-4000-8000-000000000001',jsonb_build_object('input',pg_temp.wm_value('details')))) where k='taskA';
select pg_temp.wm_assert(pg_temp.wm_value('taskA')->>'version'='2' and pg_temp.wm_value('taskA')->'labels'='["Diseño","Validación"]'::jsonb,'details saved with normal task version');
select pg_temp.wm_assert(pg_temp.wm_value('taskA')->>'title'='Synthetic task A' and pg_temp.wm_value('taskA')->>'status'='done','details preserve base title/status');
select pg_temp.wm_error($q$select pg_temp.wm('update_task_details',jsonb_build_object('id','e9400000-0000-4000-8000-000000000001','version',1,'input',pg_temp.wm_value('details')))$q$,'PT409','details stale version denied');
do $$declare x jsonb;n integer:=0;begin
 for x in select value from jsonb_array_elements(jsonb_build_array(
  pg_temp.wm_value('details')||'{"labels":["A","a"]}',pg_temp.wm_value('details')||'{"estimate_minutes":-1}',pg_temp.wm_value('details')||'{"estimate_minutes":1.5}',
  pg_temp.wm_value('details')||'{"estimate_minutes":100001}',pg_temp.wm_value('details')||'{"owner_id":"forged"}',pg_temp.wm_value('details')||'{"subtasks":[{"id":"bad","title":"x","done":false}]}',
  pg_temp.wm_value('details')||'{"subtasks":[{"id":"b9400000-0000-4000-8000-000000000010","title":"x","done":"false"}]}',
  pg_temp.wm_value('details')||'{"subtasks":[{"id":"b9400000-0000-4000-8000-000000000010","title":"x","done":false,"owner":"forged"}]}'
 )) loop
  n:=n+1;perform pg_temp.wm_error(format('select pg_temp.wm(''update_task_details'',pg_temp.wm_task_args(''e9400000-0000-4000-8000-000000000001'',jsonb_build_object(''input'',%L::jsonb)))',x::text),'22023','closed task details '||n);
 end loop;
end;$$;

-- Build a synthetic Google Tasks identity and an in-flight request. No HTTP or real grant.
reset role;
insert into wm_values values('owner_member',to_jsonb((select id from tr8_private.workspace_members where workspace_id='d9400000-0000-4000-8000-000000000001' and user_id='f9400000-0000-4000-8000-000000000001')));
set local role authenticated;
select public.tr8_v2_assign_task('d9400000-0000-4000-8000-000000000001','e9400000-0000-4000-8000-000000000001',2,(pg_temp.wm_value('owner_member')#>>'{}')::uuid);
reset role;
insert into tr8_private.google_connections(id,user_id,generation,state,tasks_granted,calendar_id,credential_envelope) values('c9400000-0000-4000-8000-000000000001','f9400000-0000-4000-8000-000000000001',1,'connected',true,'synthetic-stage4@group.calendar.google.com','{"v":1,"kid":"synthetic","iv":"AAAAAAAAAAAAAAAA","ciphertext":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}');
insert into tr8_private.google_tasks_sync(connection_id,generation,enabled) values('c9400000-0000-4000-8000-000000000001',1,true);
insert into tr8_private.google_tasks_lists(connection_id,generation,list_id,title,selected) values('c9400000-0000-4000-8000-000000000001',1,'synthetic-list','Synthetic',true);
insert into tr8_private.google_tasks_links(id,connection_id,generation,list_id,remote_task_id,workspace_id,project_id,local_task_id,local_task_created_at,state,origin,creation_state,creation_marker,base_projection_hash,synced_local_hash)
 select 'c9400000-0000-4000-8000-000000000002','c9400000-0000-4000-8000-000000000001',1,'synthetic-list','synthetic-remote','d9400000-0000-4000-8000-000000000001',project_id,id,created_at,'synced','tr8','bound','tr8:c9400000-0000-4000-8000-000000000003',tr8_private.v6_projection_hash(tr8_private.v6_task_projection(id,created_at)),tr8_private.v6_projection_hash(tr8_private.v6_task_projection(id,created_at)) from public.tr8_workspace_tasks where id='e9400000-0000-4000-8000-000000000001';
insert into tr8_private.google_tasks_jobs(id,connection_id,generation,kind,link_id,list_id,state,lease_token,lease_expires_at,attempts,leased_revision)
 values('c9400000-0000-4000-8000-000000000004','c9400000-0000-4000-8000-000000000001',1,'patch','c9400000-0000-4000-8000-000000000002','synthetic-list','leased','c9400000-0000-4000-8000-000000000005',now()+interval '5 minutes',1,1);
insert into wm_values values('provider_before',to_jsonb((select l from tr8_private.google_tasks_links l where id='c9400000-0000-4000-8000-000000000002')));
set local role authenticated;
insert into wm_values values('archived',pg_temp.wm('archive_task',pg_temp.wm_task_args('e9400000-0000-4000-8000-000000000001','{"archived":true,"request_id":"09400000-0000-4000-8000-000000000001"}')));
select pg_temp.wm_assert(pg_temp.wm_value('archived')->>'archived_at' is not null,'task archived with timestamp');
select pg_temp.wm_assert(pg_temp.wm_value('archived')->>'id'='e9400000-0000-4000-8000-000000000001','archive preserves task identity');
select pg_temp.wm_assert(pg_temp.wm('archive_task',jsonb_build_object('id','e9400000-0000-4000-8000-000000000001','version',3,'archived',true,'request_id','09400000-0000-4000-8000-000000000001'))=pg_temp.wm_value('archived'),'exact archive replay ignores stale captured version without rewriting');
select pg_temp.wm_error($q$select public.tr8_v2_update_task('d9400000-0000-4000-8000-000000000001','e9400000-0000-4000-8000-000000000001',4,'{"title":"No rewrite"}')$q$,'PT409','legacy task editor cannot modify archived content');
select pg_temp.wm_error($q$select pg_temp.wm('update_task_details',pg_temp.wm_task_args('e9400000-0000-4000-8000-000000000001',jsonb_build_object('input',pg_temp.wm_value('details'))))$q$,'PT409','detail editor cannot modify archived content');
select pg_temp.wm_assert(not (public.tr8_v2_list_calendar(array['d9400000-0000-4000-8000-000000000001'::uuid],'2026-10-01','2026-12-01','UTC')->'items')@>'[{"task_id":"e9400000-0000-4000-8000-000000000001"}]','archived task excluded from calendar');
reset role;
select pg_temp.wm_assert((select state='cancelled' and lease_token is null and reason='task_archived' from tr8_private.google_tasks_jobs where id='c9400000-0000-4000-8000-000000000004'),'archive fences an in-flight Tasks lease');
select pg_temp.wm_assert(pg_temp.wm_value('provider_before')=to_jsonb((select l from tr8_private.google_tasks_links l where id='c9400000-0000-4000-8000-000000000002')),'archive preserves exact Google Tasks identity and common base');
select pg_temp.wm_assert(not tr8_private.v6_finish('c9400000-0000-4000-8000-000000000004','c9400000-0000-4000-8000-000000000005','{"outcome":"succeeded"}'),'late fenced worker response ignored');
select pg_temp.wm_assert(tr8_private.v6_observe('c9400000-0000-4000-8000-000000000001','synthetic-list','{"id":"synthetic-remote","etag":"synthetic-etag","deleted":false,"assigned":false,"title":"Remote edit while paused","completed":false,"start_date":null}')->>'reason'='task_archived','remote changes pause without editing or deleting archived task');
select pg_temp.wm_assert(pg_temp.wm_value('archived')=to_jsonb((select t from public.tr8_workspace_tasks t where id='e9400000-0000-4000-8000-000000000001')),'remote pause preserves archived content and version');
set local role authenticated;
select public.tr8_v2_productivity('d9400000-0000-4000-8000-000000000001','reorder_tasks','{"project_id":"a9401001-0000-4000-8000-000000000001","request_id":"09400000-0000-4000-8000-000000000002","items":[{"id":"e9400000-0000-4000-8000-000000000002","version":1,"position":2048},{"id":"e9400000-0000-4000-8000-000000000003","version":1,"position":1024}]}');
select pg_temp.wm_assert(pg_temp.wm_value('archived')=to_jsonb((select t from public.tr8_workspace_tasks t where id='e9400000-0000-4000-8000-000000000001')),'active reorder never rewrites archived task');
select pg_temp.wm_assert((select position=1024 from public.tr8_workspace_tasks where id='e9400000-0000-4000-8000-000000000003'),'active reorder works in a project containing archived tasks');
insert into wm_values values('restored',pg_temp.wm('archive_task',pg_temp.wm_task_args('e9400000-0000-4000-8000-000000000001','{"archived":false,"request_id":"09400000-0000-4000-8000-000000000003"}')));
select pg_temp.wm_assert(pg_temp.wm_value('restored')->'archived_at'='null'::jsonb,'restore removes archive timestamp');
select pg_temp.wm_assert((pg_temp.wm_value('restored')-array['archived_at','version','updated_at'])=(pg_temp.wm_value('archived')-array['archived_at','version','updated_at']),'restore preserves all content and identity');
reset role;
select pg_temp.wm_assert((select state='pending' from tr8_private.google_tasks_jobs where id='c9400000-0000-4000-8000-000000000004'),'restoring queues comparison on the existing Google link');
select pg_temp.wm_assert((select count(*)=1 from tr8_private.google_tasks_links where local_task_id='e9400000-0000-4000-8000-000000000001'),'restore never creates a second Google identity');
set local role authenticated;
insert into wm_values values('taskCopy',pg_temp.wm('duplicate_task',pg_temp.wm_task_args('e9400000-0000-4000-8000-000000000001','{"target_project_id":"a9401002-0000-4000-8000-000000000002","request_id":"e9400000-0000-4000-8000-000000000010"}')));
select pg_temp.wm_assert(pg_temp.wm_value('taskCopy')->>'id'='e9400000-0000-4000-8000-000000000010' and pg_temp.wm_value('taskCopy')->>'status'='todo','task copy new identity and pending state');
select pg_temp.wm_assert(pg_temp.wm_value('taskCopy')->'start_date'='null'::jsonb and pg_temp.wm_value('taskCopy')->'due_date'='null'::jsonb and pg_temp.wm_value('taskCopy')->'assignee_member_id'='null'::jsonb,'copy does not inherit schedules or responsibility');
select pg_temp.wm_assert(pg_temp.wm_value('taskCopy')->'labels'=pg_temp.wm_value('details')->'labels' and pg_temp.wm_value('taskCopy')->>'estimate_minutes'='90','copy retains descriptive task detail');
select pg_temp.wm_assert(pg_temp.wm_value('taskCopy')->'subtasks'->0->>'done'='false' and pg_temp.wm_value('taskCopy')->'subtasks'->0->>'id'<>'b9400000-0000-4000-8000-000000000010','copied checklist resets completion and child identity');
select pg_temp.wm_assert(pg_temp.wm('duplicate_task',jsonb_build_object('id','e9400000-0000-4000-8000-000000000001','version',(pg_temp.wm_value('restored')->>'version')::integer,'target_project_id','a9401002-0000-4000-8000-000000000002','request_id','e9400000-0000-4000-8000-000000000010'))=pg_temp.wm_value('taskCopy'),'task copy exact replay creates no duplicate');
reset role;
select pg_temp.wm_assert(not exists(select 1 from tr8_private.google_tasks_links where local_task_id='e9400000-0000-4000-8000-000000000010'),'copy never inherits the original Google link');
set local role authenticated;
insert into wm_values values('projectCopy',pg_temp.wm('duplicate_project',jsonb_build_object('id','a9401001-0000-4000-8000-000000000001','version',1,'request_id','a9401010-0000-4000-8000-000000000010','name','Synthetic project copy','include_tasks',true)));
select pg_temp.wm_assert((select count(*)=3 from public.tr8_workspace_tasks where project_id='a9401010-0000-4000-8000-000000000010'),'project copy contains its active task set');
select pg_temp.wm_assert(pg_temp.wm_value('projectCopy')->>'status'='planning' and pg_temp.wm_value('projectCopy')->'lead_member_id'='null'::jsonb,'project copy starts planning without delegated ownership');
select pg_temp.wm_assert((select bool_and(status='todo' and due_date is null and start_date is null and assignee_member_id is null) from public.tr8_workspace_tasks where project_id='a9401010-0000-4000-8000-000000000010'),'copied project tasks reset state and scheduling');
select pg_temp.wm('duplicate_project',jsonb_build_object('id','a9401001-0000-4000-8000-000000000001','version',1,'request_id','a9401010-0000-4000-8000-000000000010','name','Synthetic project copy','include_tasks',true));
select pg_temp.wm_assert((select count(*)=3 from public.tr8_workspace_tasks where project_id='a9401010-0000-4000-8000-000000000010'),'project copy retry does not repeat children');
select pg_temp.wm_error($q$select pg_temp.wm('move_task',pg_temp.wm_task_args('e9400000-0000-4000-8000-000000000001',jsonb_build_object('target_project_id','a9401001-0000-4000-8000-000000000001','request_id','09400000-0000-4000-8000-000000000004','clear_assignee',false)))$q$,'22023','move requires another project');

-- Membership alone does not open private projects or new write operations.
reset role;
insert into tr8_private.workspace_members(id,workspace_id,user_id) values('b9400000-0000-4000-8000-000000000002','d9400000-0000-4000-8000-000000000001','f9400000-0000-4000-8000-000000000002');
insert into tr8_private.member_roles(workspace_id,member_id,role_id) select workspace_id,'b9400000-0000-4000-8000-000000000002',id from tr8_private.workspace_roles where workspace_id='d9400000-0000-4000-8000-000000000001' and template_key='read';
insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level) values('d9400000-0000-4000-8000-000000000001','a9401001-0000-4000-8000-000000000001','b9400000-0000-4000-8000-000000000002','read');
set local role authenticated;
select pg_temp.wm_actor('f9400000-0000-4000-8000-000000000002');
select pg_temp.wm_error($q$select pg_temp.wm('archive_task','{"id":"e9400000-0000-4000-8000-000000000001","version":5,"archived":true,"request_id":"09400000-0000-4000-8000-000000000005"}')$q$,'PT404','reader cannot archive');
select pg_temp.wm_error($q$select pg_temp.wm('duplicate_task','{"id":"e9400000-0000-4000-8000-000000000001","version":5,"target_project_id":"a9401002-0000-4000-8000-000000000002","request_id":"e9400000-0000-4000-8000-000000000011"}')$q$,'PT404','source read does not grant destination access');
select pg_temp.wm_error($q$select pg_temp.wm('duplicate_project','{"id":"a9401001-0000-4000-8000-000000000001","version":1,"name":"Denied","include_tasks":false,"request_id":"a9401011-0000-4000-8000-000000000011"}')$q$,'PT404','reader cannot create projects by copying');
select pg_temp.wm_actor('f9400000-0000-4000-8000-000000000001');
-- Set a real authorized lead, then revoke their access using the same cleanup
-- routine called by collaboration administration.
update wm_values set v=pg_temp.wm('update_project',jsonb_build_object('id','a9401001-0000-4000-8000-000000000001','version',1,'input',(pg_temp.wm_fields()-'template_key')||'{"lead_member_id":"b9400000-0000-4000-8000-000000000002","start_date":"2026-10-28","due_date":"2026-11-30"}')) where k='projectA';
select pg_temp.wm_assert(pg_temp.wm_value('projectA')->>'lead_member_id'='b9400000-0000-4000-8000-000000000002','lead requires existing project access');
select pg_temp.wm_error($q$select pg_temp.wm('update_project',jsonb_build_object('id','a9401001-0000-4000-8000-000000000001','version',1,'input',pg_temp.wm_fields()-'template_key'))$q$,'PT409','project planning uses expected version');
reset role;
delete from tr8_private.project_access where project_id='a9401001-0000-4000-8000-000000000001' and member_id='b9400000-0000-4000-8000-000000000002';
select tr8_private.v2_cleanup_assignments('d9400000-0000-4000-8000-000000000001');
select pg_temp.wm_assert((select lead_member_id is null and version=3 from public.tr8_workspace_projects where id='a9401001-0000-4000-8000-000000000001'),'access cleanup clears a stale lead with a new version');
set local role authenticated;
select pg_temp.wm_actor('f9400000-0000-4000-8000-000000000001');
select pg_temp.wm('update_project',jsonb_build_object('id','a9401001-0000-4000-8000-000000000001','version',3,'input',(pg_temp.wm_fields()-'template_key')||'{"name":"Updated after lead removal","start_date":"2026-10-28","due_date":"2026-11-30"}'));
select pg_temp.wm_assert((select name='Updated after lead removal' from public.tr8_workspace_projects where id='a9401001-0000-4000-8000-000000000001'),'ordinary editing still works after lead revocation');

-- Move retains ID/created_at/number and provider/favorite identities.
select public.tr8_v2_productivity('d9400000-0000-4000-8000-000000000001','set_favorite','{"kind":"task","id":"e9400000-0000-4000-8000-000000000001","favorite":true}');
insert into wm_values values('moved',pg_temp.wm('move_task',pg_temp.wm_task_args('e9400000-0000-4000-8000-000000000001','{"target_project_id":"a9401002-0000-4000-8000-000000000002","request_id":"09400000-0000-4000-8000-000000000006","clear_assignee":false}')));
select pg_temp.wm_assert(pg_temp.wm_value('moved')->>'id'=pg_temp.wm_value('restored')->>'id' and pg_temp.wm_value('moved')->>'created_at'=pg_temp.wm_value('restored')->>'created_at' and pg_temp.wm_value('moved')->>'task_number'=pg_temp.wm_value('restored')->>'task_number','move preserves complete historical identity');
select pg_temp.wm_assert(pg_temp.wm_value('moved')->>'project_id'='a9401002-0000-4000-8000-000000000002','move uses the requested authorized destination');
select pg_temp.wm_assert(pg_temp.wm('move_task',jsonb_build_object('id','e9400000-0000-4000-8000-000000000001','version',(pg_temp.wm_value('restored')->>'version')::integer,'target_project_id','a9401002-0000-4000-8000-000000000002','request_id','09400000-0000-4000-8000-000000000006','clear_assignee',false))=pg_temp.wm_value('moved'),'move retry is idempotent after changing parent');
reset role;
select pg_temp.wm_assert((select project_id='a9401002-0000-4000-8000-000000000002' and remote_task_id='synthetic-remote' from tr8_private.google_tasks_links where id='c9400000-0000-4000-8000-000000000002'),'moving rebinds Google context but preserves remote task ID');
select pg_temp.wm_assert((select project_id='a9401002-0000-4000-8000-000000000002' from tr8_private.productivity_favorites where task_id='e9400000-0000-4000-8000-000000000001'),'moving follows favorites to the new authorized context');
select pg_temp.wm_assert(pg_temp.wm_value('other_task')=to_jsonb((select t from public.tr8_workspace_tasks t where id='e9400000-0000-4000-8000-000000000004')),'all operations preserve unrelated task');
set local role authenticated;
select pg_temp.wm_actor('f9400000-0000-4000-8000-000000000002');
select pg_temp.wm_error($q$select pg_temp.wm('move_task',jsonb_build_object('id','e9400000-0000-4000-8000-000000000001','version',5,'target_project_id','a9401002-0000-4000-8000-000000000002','request_id','09400000-0000-4000-8000-000000000006','clear_assignee',false))$q$,'PT404','other user cannot replay an owner receipt to expose private data');
select pg_temp.wm_actor(null);
select pg_temp.wm_error($q$select pg_temp.wm('archive_task','{"id":"e9400000-0000-4000-8000-000000000001","version":6,"archived":true,"request_id":"09400000-0000-4000-8000-000000000007"}')$q$,'42501','browser session required independently of RPC grant');
reset role;
select pg_temp.wm_actor('f9400000-0000-4000-8000-000000000001');
delete from auth.sessions where id='f9400000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.wm_error($q$select pg_temp.wm('archive_task','{"id":"e9400000-0000-4000-8000-000000000001","version":6,"archived":true,"request_id":"09400000-0000-4000-8000-000000000007"}')$q$,'42501','terminated session cannot replay a write');
reset role;
select pg_temp.wm_assert((select hash from wm_existing where kind='projects')=(select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p where p.id in(select unnest(ids) from wm_existing where kind='projects')),'pre-existing project rows preserved');
select pg_temp.wm_assert((select hash from wm_existing where kind='tasks')=(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t where t.id in(select unnest(ids) from wm_existing where kind='tasks')),'pre-existing task rows preserved');
select pg_temp.wm_assert((select hash from wm_existing where kind='finances')=(select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f where f.owner_id in(select unnest(ids) from wm_existing where kind='finances')),'all financial documents preserved');
select current_setting('tr8.wm_checks')::integer as passed_stage4_assertions;
rollback;
