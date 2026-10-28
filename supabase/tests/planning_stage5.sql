-- TEST ONLY: synthetic projects/tasks/users, no Google HTTP or credentials.
-- Run only in isolated TEST; every fixture and mutation is rolled back.
begin;
select set_config('tr8.planning_checks','0',true);
create temporary table planning_values(k text primary key,v jsonb) on commit drop;
create temporary table planning_existing on commit drop as
 select 'projects' kind,md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) hash,array_agg(id) ids from public.tr8_workspace_projects p
 union all select 'tasks',md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')),array_agg(id) from public.tr8_workspace_tasks t
 union all select 'finances',md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')),array_agg(owner_id) from tr8_private.account_finances f;
create temporary table planning_config on commit drop as select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) hash from tr8_private.app_config c;
create function pg_temp.p_assert(ok boolean,label text) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'Planning assertion: %',label;end if;
 perform set_config('tr8.planning_checks',(current_setting('tr8.planning_checks')::integer+1)::text,true);
end;$$;
create function pg_temp.p_error(command text,code text,label text) returns void language plpgsql as $$begin
 begin execute command;exception when others then
  if sqlstate=code then perform pg_temp.p_assert(true,label);return;end if;
  raise exception 'Planning expected % got % (%) for %',code,sqlstate,sqlerrm,label;
 end;raise exception 'Planning unexpectedly allowed: %',label;
end;$$;
create function pg_temp.p_actor(a uuid) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',coalesce(a::text,''),true);
 perform set_config('request.jwt.claims',case when a is null then '{}' else jsonb_build_object('sub',a,'role','authenticated','session_id',a)::text end,true);
end;$$;
create function pg_temp.p(a text,i jsonb default '{}') returns jsonb language sql as $$select public.tr8_v2_planning('d9500000-0000-4000-8000-000000000001',a,i);$$;
create function pg_temp.p_dep(r uuid,s uuid,b uuid) returns jsonb language sql as $$
 select jsonb_build_object('id',r,'task_id',s,'task_version',st.version,'blocker_task_id',b,'blocker_version',bt.version)
 from public.tr8_workspace_tasks st,public.tr8_workspace_tasks bt where st.id=s and bt.id=b;
$$;
create function pg_temp.p_milestone(r uuid,p uuid,n text default 'Release') returns jsonb language sql as $$
 select jsonb_build_object('id',r,'project_id',p,'input',jsonb_build_object('name',n,'date','2026-11-20','completed',false));
$$;
do $$begin execute format('grant usage on schema %I to authenticated,anon',pg_my_temp_schema()::regnamespace);end;$$;
grant select,insert,update on planning_values to authenticated;
grant execute on function pg_temp.p_assert(boolean,text),pg_temp.p_error(text,text,text),pg_temp.p_actor(uuid),pg_temp.p(text,jsonb),
 pg_temp.p_dep(uuid,uuid,uuid),pg_temp.p_milestone(uuid,uuid,text) to authenticated,anon;

select pg_temp.p_assert(not has_function_privilege('anon','public.tr8_v2_planning(uuid,text,jsonb)','execute'),'anonymous RPC denied');
select pg_temp.p_assert(not has_function_privilege('service_role','public.tr8_v2_planning(uuid,text,jsonb)','execute'),'service role cannot impersonate browser');
select pg_temp.p_assert(has_function_privilege('authenticated','public.tr8_v2_planning(uuid,text,jsonb)','execute'),'signed-in wrapper exists');
select pg_temp.p_assert((select not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.tr8_v2_planning(uuid,text,jsonb)'::regprocedure),'public wrapper is invoker with empty search_path');
select pg_temp.p_assert((select prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='tr8_private.planning(uuid,text,jsonb)'::regprocedure),'private authorization gateway with empty search_path');
select pg_temp.p_assert((select bool_and(relrowsecurity) from pg_class where oid in('tr8_private.task_dependencies'::regclass,'tr8_private.project_milestones'::regclass,'tr8_private.planning_receipts'::regclass)),'all planning tables have RLS');
select pg_temp.p_assert(not has_table_privilege('authenticated','tr8_private.task_dependencies','select') and not has_table_privilege('authenticated','tr8_private.project_milestones','update'),'direct graph and milestone access denied');
select pg_temp.p_assert(not has_function_privilege('authenticated','tr8_private.planning_lock_tasks(uuid,uuid,uuid,boolean)','execute'),'private locking helper is not another browser endpoint');
select pg_temp.p_assert(not has_table_privilege('service_role','tr8_private.planning_receipts','select'),'receipts stay private');

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 select ('f9500000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','planning-'||n||'@example.test',now(),'{}','{}',now(),now() from generate_series(1,4)n;
insert into auth.sessions(id,user_id,created_at,updated_at) select id,id,now(),now() from auth.users where id::text like 'f9500000-%';
insert into tr8_private.app_users(user_id,enabled,display_name) select id,true,'Synthetic planning user' from auth.users where id::text like 'f9500000-%';
set local role authenticated;
select pg_temp.p_actor('f9500000-0000-4000-8000-000000000001');
select public.tr8_v2_get_context();
select public.tr8_v2_create_team('d9500000-0000-4000-8000-000000000001','Synthetic planning');
select public.tr8_v2_create_team('d9500000-0000-4000-8000-000000000002','Synthetic foreign workspace');
-- Unique first 12 hexadecimal characters: the project code generator uses them.
select public.tr8_v2_create_project('d9500000-0000-4000-8000-000000000001','a9501001-0001-4000-8000-000000000001','Writable project','','#5A67D8','active');
select public.tr8_v2_create_project('d9500000-0000-4000-8000-000000000001','a9501002-0002-4000-8000-000000000002','Readonly predecessor','','#0284C7','active');
select public.tr8_v2_create_project('d9500000-0000-4000-8000-000000000001','a9501003-0003-4000-8000-000000000003','Hidden graph segment','','#D97706','active');
select public.tr8_v2_create_project('d9500000-0000-4000-8000-000000000002','a9501004-0004-4000-8000-000000000004','Other workspace','','#16A34A','active');
select public.tr8_v2_create_task('d9500000-0000-4000-8000-000000000001','e9500000-0000-4000-8000-000000000001','a9501001-0001-4000-8000-000000000001','Task one','','todo','none','2026-10-28','2026-11-10');
select public.tr8_v2_create_task('d9500000-0000-4000-8000-000000000001','e9500000-0000-4000-8000-000000000002','a9501002-0002-4000-8000-000000000002','Task two','','todo','none',null,null);
select public.tr8_v2_create_task('d9500000-0000-4000-8000-000000000001','e9500000-0000-4000-8000-000000000003','a9501003-0003-4000-8000-000000000003','Hidden task','','todo','none',null,null);
select public.tr8_v2_create_task('d9500000-0000-4000-8000-000000000001','e9500000-0000-4000-8000-000000000004','a9501001-0001-4000-8000-000000000001','Independent task','','todo','none',null,null);
select public.tr8_v2_create_task('d9500000-0000-4000-8000-000000000002','e9500000-0000-4000-8000-000000000005','a9501004-0004-4000-8000-000000000004','Foreign task','','todo','none',null,null);
insert into planning_values select 'task_before',to_jsonb(t) from public.tr8_workspace_tasks t where id='e9500000-0000-4000-8000-000000000001';
select pg_temp.p_assert(pg_temp.p('load')='{"dependencies":[],"milestones":[]}'::jsonb,'new workspace starts without fabricated planning');
insert into planning_values values('hidden_edge_one',pg_temp.p('add_dependency',pg_temp.p_dep('c9500000-0000-4000-8000-000000000001','e9500000-0000-4000-8000-000000000002','e9500000-0000-4000-8000-000000000003')));
insert into planning_values values('hidden_edge_two',pg_temp.p('add_dependency',pg_temp.p_dep('c9500000-0000-4000-8000-000000000002','e9500000-0000-4000-8000-000000000003','e9500000-0000-4000-8000-000000000001')));
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'dependencies')=2,'owner sees cross-project dependencies');
select pg_temp.p_error($q$select pg_temp.p('add_dependency','{"id":"c9500000-0000-4000-8000-000000000009","task_id":"e9500000-0000-4000-8000-000000000001","task_version":1,"blocker_task_id":"e9500000-0000-4000-8000-000000000005","blocker_version":1}')$q$,'PT404','cross-workspace endpoints denied without revealing foreign row');
select pg_temp.p_error($q$select pg_temp.p('add_dependency',pg_temp.p_dep('c9500000-0000-4000-8000-000000000009','e9500000-0000-4000-8000-000000000001','e9500000-0000-4000-8000-000000000001'))$q$,'22023','self dependency rejected');
select pg_temp.p_error($q$select pg_temp.p('add_dependency',pg_temp.p_dep('c9500000-0000-4000-8000-000000000009','e9500000-0000-4000-8000-000000000001','e9500000-0000-4000-8000-000000000003'))$q$,'22023','direct cycle rejected');

reset role;
insert into tr8_private.workspace_members(id,workspace_id,user_id) values
 ('b9500000-0000-4000-8000-000000000002','d9500000-0000-4000-8000-000000000001','f9500000-0000-4000-8000-000000000002'),
 ('b9500000-0000-4000-8000-000000000003','d9500000-0000-4000-8000-000000000001','f9500000-0000-4000-8000-000000000003');
insert into tr8_private.member_roles(workspace_id,member_id,role_id)
 select workspace_id,case when template_key='collaborator' then 'b9500000-0000-4000-8000-000000000002'::uuid else 'b9500000-0000-4000-8000-000000000003'::uuid end,id
 from tr8_private.workspace_roles where workspace_id='d9500000-0000-4000-8000-000000000001' and template_key in('collaborator','read');
insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level) values
 ('d9500000-0000-4000-8000-000000000001','a9501001-0001-4000-8000-000000000001','b9500000-0000-4000-8000-000000000002','write'),
 ('d9500000-0000-4000-8000-000000000001','a9501002-0002-4000-8000-000000000002','b9500000-0000-4000-8000-000000000002','read'),
 ('d9500000-0000-4000-8000-000000000001','a9501001-0001-4000-8000-000000000001','b9500000-0000-4000-8000-000000000003','read');
set local role authenticated;
select pg_temp.p_actor('f9500000-0000-4000-8000-000000000002');
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'dependencies')=0,'an edge with either hidden endpoint is not disclosed');
select pg_temp.p_error($q$select pg_temp.p('add_dependency',pg_temp.p_dep('c9500000-0000-4000-8000-000000000009','e9500000-0000-4000-8000-000000000001','e9500000-0000-4000-8000-000000000002'))$q$,'22023','indirect cycle rejected across invisible graph segment');
insert into planning_values values('edge',pg_temp.p('add_dependency',pg_temp.p_dep('c9500000-0000-4000-8000-000000000003','e9500000-0000-4000-8000-000000000004','e9500000-0000-4000-8000-000000000002')));
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'dependencies')=1,'editing successor plus readonly predecessor is sufficient');
select pg_temp.p_assert(pg_temp.p('add_dependency',pg_temp.p_dep('c9500000-0000-4000-8000-000000000003','e9500000-0000-4000-8000-000000000004','e9500000-0000-4000-8000-000000000002'))=(select v from planning_values where k='edge'),'stable retry returns exactly one dependency');
select pg_temp.p_error($q$select pg_temp.p('add_dependency',pg_temp.p_dep('c9500000-0000-4000-8000-000000000003','e9500000-0000-4000-8000-000000000001','e9500000-0000-4000-8000-000000000002'))$q$,'PT409','receipt cannot be reused with another task');
select pg_temp.p_error($q$select pg_temp.p('add_dependency',pg_temp.p_dep('c9500000-0000-4000-8000-000000000010','e9500000-0000-4000-8000-000000000004','e9500000-0000-4000-8000-000000000002'))$q$,'23505','duplicate endpoint pair rejected');
select pg_temp.p_error($q$select pg_temp.p('add_dependency',pg_temp.p_dep('c9500000-0000-4000-8000-000000000010','e9500000-0000-4000-8000-000000000001','e9500000-0000-4000-8000-000000000004')||'{"task_version":999}')$q$,'PT409','stale task version rejected');
select pg_temp.p_error($q$select pg_temp.p('add_dependency',pg_temp.p_dep('c9500000-0000-4000-8000-000000000010','e9500000-0000-4000-8000-000000000001','e9500000-0000-4000-8000-000000000004')||'{"owner_id":"forged"}')$q$,'22023','unknown dependency keys rejected');
select pg_temp.p_error($q$select pg_temp.p('remove_dependency','{"id":"c9500000-0000-4000-8000-000000000001","version":1}')$q$,'PT404','cannot delete edge exposing hidden endpoint');

insert into planning_values values('milestone',pg_temp.p('create_milestone',pg_temp.p_milestone('c9500000-0000-4000-8000-000000000020','a9501001-0001-4000-8000-000000000001')));
select pg_temp.p_assert(pg_temp.p('create_milestone',pg_temp.p_milestone('c9500000-0000-4000-8000-000000000020','a9501001-0001-4000-8000-000000000001'))=(select v from planning_values where k='milestone'),'milestone create retry does not duplicate');
select pg_temp.p_error($q$select pg_temp.p('create_milestone',pg_temp.p_milestone('c9500000-0000-4000-8000-000000000020','a9501001-0001-4000-8000-000000000001','Another name'))$q$,'PT409','milestone receipt binds payload');
select pg_temp.p_error($q$select pg_temp.p('create_milestone',pg_temp.p_milestone('c9500000-0000-4000-8000-000000000021','a9501002-0002-4000-8000-000000000002'))$q$,'PT404','project read access does not allow creating milestones');
select pg_temp.p_error($q$select pg_temp.p('create_milestone',pg_temp.p_milestone('c9500000-0000-4000-8000-000000000021','a9501001-0001-4000-8000-000000000001')||'{"input":{"name":"Invalid","date":"2027-02-29","completed":false}}')$q$,'22023','impossible civil milestone date rejected');
select pg_temp.p_error($q$select pg_temp.p('create_milestone',pg_temp.p_milestone('c9500000-0000-4000-8000-000000000021','a9501001-0001-4000-8000-000000000001')||'{"input":{"name":"Invalid","date":"2026-11-20","completed":false,"owner":"forged"}}')$q$,'22023','closed milestone payload');
update planning_values set v=pg_temp.p('update_milestone','{"id":"c9500000-0000-4000-8000-000000000020","version":1,"input":{"name":"Released","date":"2026-11-21","completed":true}}') where k='milestone';
select pg_temp.p_assert((select v->>'version'='2' and v->>'completed'='true' and v->>'date'='2026-11-21' from planning_values where k='milestone'),'milestone edits use independent version and civil date');
select pg_temp.p_error($q$select pg_temp.p('update_milestone','{"id":"c9500000-0000-4000-8000-000000000020","version":1,"input":{"name":"Stale","date":"2026-11-21","completed":true}}')$q$,'PT409','milestone stale edit denied');
select pg_temp.p_error($q$select pg_temp.p('delete_milestone','{"id":"c9500000-0000-4000-8000-000000000020","version":1}')$q$,'PT409','milestone stale deletion denied');
select pg_temp.p_actor('f9500000-0000-4000-8000-000000000003');
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'milestones')=1 and jsonb_array_length(pg_temp.p('load')->'dependencies')=0,'project reader sees milestone but not relation to inaccessible project');
select pg_temp.p_error($q$select pg_temp.p('delete_milestone','{"id":"c9500000-0000-4000-8000-000000000020","version":2}')$q$,'PT404','reader cannot delete milestones');
select pg_temp.p_actor('f9500000-0000-4000-8000-000000000004');
select pg_temp.p_error($q$select pg_temp.p('load')$q$,'PT404','outsider cannot load workspace graph');

select pg_temp.p_actor('f9500000-0000-4000-8000-000000000001');
select pg_temp.p_assert((select v from planning_values where k='task_before')=to_jsonb((select t from public.tr8_workspace_tasks t where id='e9500000-0000-4000-8000-000000000001')),'planning never rewrites task dates, status or version');
select public.tr8_v2_update_task('d9500000-0000-4000-8000-000000000001','e9500000-0000-4000-8000-000000000002',1,'{"status":"done"}');
select pg_temp.p_assert((select status='done' from public.tr8_workspace_tasks where id='e9500000-0000-4000-8000-000000000002'),'dependencies do not hard-block completion');
select public.tr8_v2_work_management('d9500000-0000-4000-8000-000000000001','archive_task','{"id":"e9500000-0000-4000-8000-000000000004","version":1,"archived":true,"request_id":"09500000-0000-4000-8000-000000000001"}');
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'dependencies')=3,'archive retains readable relations for task detail');
select pg_temp.p_error($q$select pg_temp.p('remove_dependency','{"id":"c9500000-0000-4000-8000-000000000003","version":1}')$q$,'55000','archived successor dependencies readonly');
select public.tr8_v2_work_management('d9500000-0000-4000-8000-000000000001','archive_task','{"id":"e9500000-0000-4000-8000-000000000004","version":2,"archived":false,"request_id":"09500000-0000-4000-8000-000000000002"}');
select public.tr8_v2_work_management('d9500000-0000-4000-8000-000000000001','move_task','{"id":"e9500000-0000-4000-8000-000000000004","version":3,"target_project_id":"a9501002-0002-4000-8000-000000000002","clear_assignee":false,"request_id":"09500000-0000-4000-8000-000000000003"}');
select pg_temp.p_assert(exists(select 1 from jsonb_array_elements(pg_temp.p('load')->'dependencies') x where x->>'id'='c9500000-0000-4000-8000-000000000003'),'same-workspace move preserves dependency identity');
select pg_temp.p_actor('f9500000-0000-4000-8000-000000000002');
select pg_temp.p_error($q$select pg_temp.p('remove_dependency','{"id":"c9500000-0000-4000-8000-000000000003","version":1}')$q$,'PT404','moved successor uses current destination write permission');
select pg_temp.p_actor('f9500000-0000-4000-8000-000000000001');
select pg_temp.p_error($q$select pg_temp.p('remove_dependency','{"id":"c9500000-0000-4000-8000-000000000003","version":2}')$q$,'PT409','dependency deletion exact own version');
select pg_temp.p('remove_dependency','{"id":"c9500000-0000-4000-8000-000000000003","version":1}');
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'dependencies')=2,'only selected relation removed');
select pg_temp.p_actor('f9500000-0000-4000-8000-000000000002');
select pg_temp.p_error($q$select pg_temp.p('add_dependency','{"id":"c9500000-0000-4000-8000-000000000003","task_id":"e9500000-0000-4000-8000-000000000004","task_version":1,"blocker_task_id":"e9500000-0000-4000-8000-000000000002","blocker_version":1}')$q$,'PT409','retry cannot resurrect deleted dependency');
select pg_temp.p_actor('f9500000-0000-4000-8000-000000000001');
select public.tr8_v2_update_project('d9500000-0000-4000-8000-000000000001','a9501001-0001-4000-8000-000000000001',1,jsonb_build_object('archived_at',clock_timestamp()));
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'milestones')=1,'archived project milestone remains visible');
select pg_temp.p_error($q$select pg_temp.p('delete_milestone','{"id":"c9500000-0000-4000-8000-000000000020","version":2}')$q$,'55000','archived project milestone readonly');
select public.tr8_v2_update_project('d9500000-0000-4000-8000-000000000001','a9501001-0001-4000-8000-000000000001',2,'{"archived_at":null}');
select public.tr8_v2_work_management('d9500000-0000-4000-8000-000000000001','duplicate_project','{"id":"a9501001-0001-4000-8000-000000000001","version":3,"name":"Independent copy","include_tasks":true,"request_id":"a9501005-0005-4000-8000-000000000005"}');
reset role;
select pg_temp.p_assert(not exists(select 1 from tr8_private.project_milestones where project_id='a9501005-0005-4000-8000-000000000005'),'project duplicate copies no milestones');
select pg_temp.p_assert(not exists(select 1 from tr8_private.task_dependencies d join public.tr8_workspace_tasks t on t.id=d.task_id or t.id=d.blocker_task_id where t.project_id='a9501005-0005-4000-8000-000000000005'),'project duplicate copies no task dependencies');

-- Revocation rechecks current ACL even for an otherwise valid create receipt.
delete from tr8_private.project_access where workspace_id='d9500000-0000-4000-8000-000000000001' and member_id='b9500000-0000-4000-8000-000000000002' and project_id='a9501001-0001-4000-8000-000000000001';
set local role authenticated;
select pg_temp.p_actor('f9500000-0000-4000-8000-000000000002');
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'milestones')=0,'revoked project disappears on next load');
select pg_temp.p_error($q$select pg_temp.p('create_milestone',pg_temp.p_milestone('c9500000-0000-4000-8000-000000000020','a9501001-0001-4000-8000-000000000001'))$q$,'PT404','receipt replay rechecks current project permission');
select pg_temp.p_actor('f9500000-0000-4000-8000-000000000001');
select public.tr8_v2_delete_task('d9500000-0000-4000-8000-000000000001','e9500000-0000-4000-8000-000000000003',1);
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'dependencies')=0,'task deletion cascades both incoming and outgoing edges');
select public.tr8_v2_delete_project('a9501001-0001-4000-8000-000000000001',3,'Writable project');
select pg_temp.p_assert(jsonb_array_length(pg_temp.p('load')->'milestones')=0,'actual project deletion cascades only its milestones');

-- Deterministic bounded fixtures exercise limits without 1,000 browser calls.
-- The second workspace contains no user data and rolls back with this suite.
do $$declare n integer;begin
 for n in 1..47 loop
  perform public.tr8_v2_create_task('d9500000-0000-4000-8000-000000000002',('e9500000-0000-4000-8000-1'||lpad(n::text,11,'0'))::uuid,
   'a9501004-0004-4000-8000-000000000004','Limit fixture '||n,'','todo','none',null,null);
 end loop;
end;$$;
select public.tr8_v2_create_project('d9500000-0000-4000-8000-000000000002','a9501006-0006-4000-8000-000000000006','Limit two','','#16A34A','active');
select public.tr8_v2_create_project('d9500000-0000-4000-8000-000000000002','a9501007-0007-4000-8000-000000000007','Limit three','','#16A34A','active');
select public.tr8_v2_create_project('d9500000-0000-4000-8000-000000000002','a9501008-0008-4000-8000-000000000008','Limit four','','#16A34A','active');
select public.tr8_v2_create_project('d9500000-0000-4000-8000-000000000002','a9501009-0009-4000-8000-000000000009','Limit five','','#16A34A','active');
reset role;
insert into tr8_private.task_dependencies(id,workspace_id,task_id,blocker_task_id)
 select ('c9500000-0000-4000-8000-2'||lpad(n::text,11,'0'))::uuid,'d9500000-0000-4000-8000-000000000002',
  ('e9500000-0000-4000-8000-1'||lpad(s::text,11,'0'))::uuid,('e9500000-0000-4000-8000-1'||lpad(b::text,11,'0'))::uuid
 from(select s,b,row_number() over(order by s,b)n from generate_series(1,47)s,generate_series(1,47)b where s>b)q where n<=1000;
insert into tr8_private.project_milestones(id,workspace_id,project_id,name,date)
 select ('c9500000-0000-4000-8000-3'||lpad(n::text,11,'0'))::uuid,'d9500000-0000-4000-8000-000000000002','a9501004-0004-4000-8000-000000000004','Limit milestone '||n,'2026-11-20' from generate_series(1,50)n;
set local role authenticated;
select pg_temp.p_error($q$select public.tr8_v2_planning('d9500000-0000-4000-8000-000000000002','add_dependency','{"id":"c9500000-0000-4000-8000-000000000090","task_id":"e9500000-0000-4000-8000-100000000047","task_version":1,"blocker_task_id":"e9500000-0000-4000-8000-000000000005","blocker_version":1}')$q$,'22023','workspace dependency cap is enforced');
select pg_temp.p_error($q$select public.tr8_v2_planning('d9500000-0000-4000-8000-000000000002','create_milestone',pg_temp.p_milestone('c9500000-0000-4000-8000-000000000091','a9501004-0004-4000-8000-000000000004'))$q$,'22023','per-project milestone cap is enforced');
reset role;
insert into tr8_private.project_milestones(id,workspace_id,project_id,name,date)
 select ('c9500000-0000-4000-8000-3'||lpad(n::text,11,'0'))::uuid,'d9500000-0000-4000-8000-000000000002',
  case when n<=100 then 'a9501006-0006-4000-8000-000000000006'::uuid when n<=150 then 'a9501007-0007-4000-8000-000000000007'::uuid else 'a9501008-0008-4000-8000-000000000008'::uuid end,
  'Limit milestone '||n,'2026-11-20' from generate_series(51,200)n;
set local role authenticated;
select pg_temp.p_error($q$select public.tr8_v2_planning('d9500000-0000-4000-8000-000000000002','create_milestone',pg_temp.p_milestone('c9500000-0000-4000-8000-000000000092','a9501009-0009-4000-8000-000000000009'))$q$,'22023','workspace milestone cap is enforced independently of project cap');
reset role;
insert into tr8_private.planning_receipts(owner_id,workspace_id,request_id,action,payload_hash,created_at)
 select 'f9500000-0000-4000-8000-000000000001','d9500000-0000-4000-8000-000000000001',
  ('c9500000-0000-4000-8000-4'||lpad(n::text,11,'0'))::uuid,'create_milestone',repeat('a',64),now()-interval '1 day' from generate_series(1,1000)n;
set local role authenticated;
select pg_temp.p('create_milestone',pg_temp.p_milestone('c9500000-0000-4000-8000-000000000093','a9501002-0002-4000-8000-000000000002','Bounded receipts'));
reset role;
select pg_temp.p_assert((select count(*)=1000 from tr8_private.planning_receipts where owner_id='f9500000-0000-4000-8000-000000000001' and workspace_id='d9500000-0000-4000-8000-000000000001'),'create receipt retention stays bounded');
set local role authenticated;

select pg_temp.p_actor(null);
select pg_temp.p_error($q$select pg_temp.p('load')$q$,'42501','a live browser session is required independently of grants');
reset role;
select pg_temp.p_actor('f9500000-0000-4000-8000-000000000001');
delete from auth.sessions where id='f9500000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.p_error($q$select pg_temp.p('load')$q$,'42501','terminated browser session cannot read planning');
reset role;
select pg_temp.p_assert((select hash from planning_existing where kind='projects')=(select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p where p.id in(select unnest(ids) from planning_existing where kind='projects')),'preexisting projects preserved byte-for-byte');
select pg_temp.p_assert((select hash from planning_existing where kind='tasks')=(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t where t.id in(select unnest(ids) from planning_existing where kind='tasks')),'preexisting tasks preserved byte-for-byte');
select pg_temp.p_assert((select hash from planning_existing where kind='finances')=(select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f where f.owner_id in(select unnest(ids) from planning_existing where kind='finances')),'all existing financial documents preserved');
select pg_temp.p_assert((select hash from planning_config)=(select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c),'auth and signup settings preserved');
select current_setting('tr8.planning_checks')::integer as passed_stage5_assertions;
rollback;
