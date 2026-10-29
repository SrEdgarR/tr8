-- TEST ONLY. Run in isolated tr8-test. Fixtures, schema and data roll back.
-- No provider HTTP calls, usable credentials, mail or registrations are used.
begin;
select set_config('tr8.recurrence_checks','0',true);
create temporary table recurrence_values(k text primary key,v jsonb) on commit drop;
create temporary table recurrence_existing on commit drop as
 select 'projects' kind,md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) hash,array_agg(id) ids from public.tr8_workspace_projects p
 union all select 'tasks',md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')),array_agg(id) from public.tr8_workspace_tasks t
 union all select 'finances',md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')),array_agg(owner_id) from tr8_private.account_finances f;
create temporary table recurrence_config on commit drop as select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) hash from tr8_private.app_config c;
create function pg_temp.r_assert(ok boolean,label text) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'Recurrence assertion: %',label;end if;
 perform set_config('tr8.recurrence_checks',(current_setting('tr8.recurrence_checks')::integer+1)::text,true);
end;$$;
create function pg_temp.r_error(command text,expected text,label text) returns void language plpgsql as $$begin
 begin execute command;exception when others then
  if sqlstate=expected then perform pg_temp.r_assert(true,label);return;end if;
  raise exception 'Recurrence expected % got % (%) for %',expected,sqlstate,sqlerrm,label;
 end;raise exception 'Recurrence unexpectedly allowed: %',label;
end;$$;
create function pg_temp.r_actor(a uuid) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',coalesce(a::text,''),true);
 perform set_config('request.jwt.claims',case when a is null then '{}' else jsonb_build_object('sub',a,'role','authenticated','session_id',a)::text end,true);
end;$$;
create function pg_temp.r_value(name text) returns jsonb language sql as $$select v from recurrence_values where k=$1;$$;
create function pg_temp.r_id(n integer) returns uuid language sql immutable as $$select ('ea110000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.r_rule(f text default 'daily',n integer default 1,days jsonb default '[]',ending date default null,z text default 'America/Santo_Domingo') returns jsonb
 language sql as $$select jsonb_build_object('frequency',f,'interval',n,'weekdays',days,'time_zone',z,'until_date',ending);$$;
create function pg_temp.r_input(id uuid,rule jsonb,sv integer default null,rid uuid default gen_random_uuid()) returns jsonb language sql as $$
 select jsonb_build_object('id',t.id,'project_id',t.project_id,'created_at',t.created_at,'task_version',t.version,'series_version',sv,'request_id',rid,'rule',rule)
 from public.tr8_workspace_tasks t where t.id=$1;
$$;
create function pg_temp.r_save(id uuid,rule jsonb,sv integer default null,rid uuid default gen_random_uuid()) returns jsonb language sql as $$
 select public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','save',pg_temp.r_input(id,rule,sv,rid));
$$;
create function pg_temp.r_state(id uuid) returns jsonb language sql as $$
 select public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','state',jsonb_build_object('id',t.id,'project_id',t.project_id,'created_at',t.created_at))
 from public.tr8_workspace_tasks t where t.id=$1;
$$;
create function pg_temp.r_complete(id uuid,status text default 'done') returns public.tr8_workspace_tasks language sql as $$
 select public.tr8_v2_update_task(t.workspace_id,t.id,t.version,jsonb_build_object('status',$2)) from public.tr8_workspace_tasks t where t.id=$1;
$$;
do $$begin execute format('grant usage on schema %I to authenticated,anon',pg_my_temp_schema()::regnamespace);end;$$;
grant select,insert,update on recurrence_values to authenticated;
grant execute on function pg_temp.r_assert(boolean,text),pg_temp.r_error(text,text,text),pg_temp.r_actor(uuid),pg_temp.r_value(text),pg_temp.r_id(integer),
 pg_temp.r_rule(text,integer,jsonb,date,text),pg_temp.r_input(uuid,jsonb,integer,uuid),pg_temp.r_save(uuid,jsonb,integer,uuid),pg_temp.r_state(uuid),pg_temp.r_complete(uuid,text) to authenticated,anon;

-- Capabilities and private storage are closed by default.
select pg_temp.r_assert(not has_function_privilege('anon','public.tr8_v2_recurrence(uuid,text,jsonb)','execute'),'anonymous endpoint denied');
select pg_temp.r_assert(not has_function_privilege('service_role','public.tr8_v2_recurrence(uuid,text,jsonb)','execute'),'service role gets no browser configuration');
select pg_temp.r_assert(has_function_privilege('authenticated','public.tr8_v2_recurrence(uuid,text,jsonb)','execute'),'authenticated wrapper granted');
select pg_temp.r_assert((select not prosecdef and proconfig=array['search_path=""'] from pg_proc where oid='public.tr8_v2_recurrence(uuid,text,jsonb)'::regprocedure),'public wrapper is invoker with empty search path');
select pg_temp.r_assert((select bool_and(relrowsecurity) from pg_class where oid in('tr8_private.task_recurrence_series'::regclass,'tr8_private.task_recurrence_occurrences'::regclass,'tr8_private.task_recurrence_receipts'::regclass)),'private tables have RLS');
select pg_temp.r_assert(not has_table_privilege('authenticated','tr8_private.task_recurrence_series','select,insert,update,delete') and not has_table_privilege('authenticated','tr8_private.task_recurrence_occurrences','select,insert,update,delete'),'clients cannot bypass recurrence authorization');
select pg_temp.r_assert(not has_function_privilege('authenticated','tr8_private.recurrence_generate(public.tr8_workspace_tasks)','execute'),'generation helper remains internal');

-- Civil-date arithmetic retains its original anchor and skips missed periods.
select pg_temp.r_assert(tr8_private.recurrence_next_date('2026-01-31','monthly',1,'{}',null,'2026-01-31')='2026-02-28','month 31 clamps in February');
select pg_temp.r_assert(tr8_private.recurrence_next_date('2026-01-31','monthly',1,'{}',null,'2026-02-28')='2026-03-31','monthly 31 returns after February without drift');
select pg_temp.r_assert(tr8_private.recurrence_next_date('2024-01-31','monthly',1,'{}',null,'2024-01-31')='2024-02-29','leap year month clamp');
select pg_temp.r_assert(tr8_private.recurrence_next_date('2026-01-31','monthly',3,'{}',null,'2026-06-15')='2026-07-31','multi-month cadence stays anchored');
select pg_temp.r_assert(tr8_private.recurrence_next_date('2026-01-01','daily',3,'{}',null,'2026-10-29')='2026-10-31','daily misses skipped with bounded arithmetic');
select pg_temp.r_assert(tr8_private.recurrence_next_date('2026-10-28','weekly',2,array[1,3,5],null,'2026-10-28')='2026-10-30','weekly same anchored week');
select pg_temp.r_assert(tr8_private.recurrence_next_date('2026-10-28','weekly',2,array[1,3,5],null,'2026-10-30')='2026-11-09','weekly interval skips inactive week');
select pg_temp.r_assert(tr8_private.recurrence_next_date('2026-10-28','weekly',2,array[1],null,'2026-10-28')='2026-11-09','weekdays before initial anchor are not emitted');
select pg_temp.r_assert(tr8_private.recurrence_next_date('2026-03-07','daily',1,'{}',null,'2026-03-08')='2026-03-09','DST boundary retains civil day cadence');
select pg_temp.r_assert(tr8_private.recurrence_next_date('2026-01-31','monthly',1,'{}','2026-02-28','2026-01-31')='2026-02-28','end date is inclusive');
select pg_temp.r_assert(tr8_private.recurrence_next_date('2026-01-31','monthly',1,'{}','2026-02-28','2026-02-28') is null,'series stops beyond inclusive end');
select pg_temp.r_assert(tr8_private.recurrence_next_date('9999-12-31','daily',1,'{}',null,'9999-12-31') is null,'daily year boundary returns null');
select pg_temp.r_assert(tr8_private.recurrence_next_date('9999-12-31','monthly',1,'{}',null,'9999-12-31') is null,'monthly year boundary returns null');
select pg_temp.r_assert(tr8_private.recurrence_next_date('9999-12-31','weekly',1,array[1],null,'9999-12-31') is null,'weekly year boundary returns null');

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 select ('fa110000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','recurrence-stage11-'||n||'@example.test',now(),'{}','{}',now(),now() from generate_series(1,4)n;
insert into auth.sessions(id,user_id,created_at,updated_at) select id,id,now(),now() from auth.users where id::text like 'fa110000-%';
insert into tr8_private.app_users(user_id,enabled,display_name) select id,true,'Synthetic recurrence stage eleven' from auth.users where id::text like 'fa110000-%';
set local role authenticated;
select pg_temp.r_actor('fa110000-0000-4000-8000-000000000001');
select public.tr8_v2_get_context();
select public.tr8_v2_create_team('da110000-0000-4000-8000-000000000001','Synthetic recurrence workspace');
select public.tr8_v2_create_project('da110000-0000-4000-8000-000000000001','aa110001-0000-4000-8000-000000000001','Recurring tasks','','#5A67D8','active');
select public.tr8_v2_create_project('da110000-0000-4000-8000-000000000001','aa110002-0000-4000-8000-000000000002','Private source','','#5A67D8','active');
select public.tr8_v2_create_task('da110000-0000-4000-8000-000000000001',pg_temp.r_id(n),
 case when n=10 then 'aa110002-0000-4000-8000-000000000002'::uuid else 'aa110001-0000-4000-8000-000000000001'::uuid end,
 'Synthetic recurring task '||n,'Keep this description','todo','high',
 case when n=8 then null else (clock_timestamp() at time zone 'America/Santo_Domingo')::date-1 end,
 case when n=8 then null else (clock_timestamp() at time zone 'America/Santo_Domingo')::date+1 end) from generate_series(1,12)n;
reset role;
-- Two delegates: author may create/edit but not assign; completer can only edit.
insert into tr8_private.workspace_members(id,workspace_id,user_id) values
 ('ba110000-0000-4000-8000-000000000002','da110000-0000-4000-8000-000000000001','fa110000-0000-4000-8000-000000000002'),
 ('ba110000-0000-4000-8000-000000000003','da110000-0000-4000-8000-000000000001','fa110000-0000-4000-8000-000000000003');
insert into tr8_private.workspace_roles(id,workspace_id,name) values
 ('ca110000-0000-4000-8000-000000000002','da110000-0000-4000-8000-000000000001','Synthetic recurrence author'),
 ('ca110000-0000-4000-8000-000000000003','da110000-0000-4000-8000-000000000001','Synthetic recurrence completer');
insert into tr8_private.role_permissions(workspace_id,role_id,permission)
 select 'da110000-0000-4000-8000-000000000001'::uuid,'ca110000-0000-4000-8000-000000000002'::uuid,unnest(array['project.read','task.read','task.edit','task.create'])
 union all select 'da110000-0000-4000-8000-000000000001'::uuid,'ca110000-0000-4000-8000-000000000003'::uuid,unnest(array['project.read','task.read','task.edit']);
insert into tr8_private.member_roles(workspace_id,member_id,role_id) values
 ('da110000-0000-4000-8000-000000000001','ba110000-0000-4000-8000-000000000002','ca110000-0000-4000-8000-000000000002'),
 ('da110000-0000-4000-8000-000000000001','ba110000-0000-4000-8000-000000000003','ca110000-0000-4000-8000-000000000003');
insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level) values
 ('da110000-0000-4000-8000-000000000001','aa110001-0000-4000-8000-000000000001','ba110000-0000-4000-8000-000000000002','write'),
 ('da110000-0000-4000-8000-000000000001','aa110001-0000-4000-8000-000000000001','ba110000-0000-4000-8000-000000000003','write');
update public.tr8_workspace_tasks set labels='["Personal"]',estimate_minutes=20,
 subtasks='[{"id":"0a110000-0000-4000-8000-000000000001","title":"Checklist item","done":true}]',
 scheduled_start_at='2026-11-01T12:00:00Z',scheduled_end_at='2026-11-01T13:00:00Z',scheduled_time_zone='America/Santo_Domingo' where id=pg_temp.r_id(1);
insert into recurrence_values values('owner_member',(select to_jsonb(id) from tr8_private.workspace_members where workspace_id='da110000-0000-4000-8000-000000000001' and user_id='fa110000-0000-4000-8000-000000000001')) on conflict(k) do update set v=excluded.v;
set local role authenticated;
select public.tr8_v2_assign_task('da110000-0000-4000-8000-000000000001',t.id,t.version,(pg_temp.r_value('owner_member')#>>'{}')::uuid)
 from public.tr8_workspace_tasks t where t.id in(pg_temp.r_id(1),pg_temp.r_id(2),pg_temp.r_id(5));
insert into recurrence_values values('source_before',to_jsonb((select t from public.tr8_workspace_tasks t where id=pg_temp.r_id(1))));
insert into recurrence_values values('save_input',pg_temp.r_input(pg_temp.r_id(1),pg_temp.r_rule(),null,'0a110000-0000-4000-8000-000000000001'));
insert into recurrence_values values('saved',public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','save',pg_temp.r_value('save_input')));
select pg_temp.r_assert(pg_temp.r_value('source_before')=to_jsonb((select t from public.tr8_workspace_tasks t where id=pg_temp.r_id(1))),'configuration preserves task version and every task field');
select pg_temp.r_assert(pg_temp.r_value('saved')->'series'->>'state'='active','first save activates series');
select pg_temp.r_assert(public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','save',pg_temp.r_value('save_input'))=pg_temp.r_value('saved'),'exact configuration retry stable');
select pg_temp.r_error($q$select public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','save',jsonb_set(pg_temp.r_value('save_input'),'{rule,interval}','2'))$q$,'PT409','request id cannot change rule');
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(1),pg_temp.r_rule())$q$,'PT409','initial null expected version cannot overwrite existing series');
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(8),pg_temp.r_rule())$q$,'22023','recurrence requires due date');
select pg_temp.r_complete(pg_temp.r_id(11));
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(11),pg_temp.r_rule())$q$,'PT409','initial completed task rejected');
select pg_temp.r_save(pg_temp.r_id(2),pg_temp.r_rule());
-- Replace author by explicit authorized save; the completer is edit-only.
select pg_temp.r_actor('fa110000-0000-4000-8000-000000000002');
select pg_temp.r_save(pg_temp.r_id(2),pg_temp.r_rule(),1);
select pg_temp.r_save(pg_temp.r_id(3),pg_temp.r_rule());
select pg_temp.r_actor('fa110000-0000-4000-8000-000000000003');
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(12),pg_temp.r_rule())$q$,'PT404','edit-only user cannot authorize creation');
select pg_temp.r_complete(pg_temp.r_id(1));
select pg_temp.r_complete(pg_temp.r_id(2));
insert into recurrence_values values('child1',pg_temp.r_state(pg_temp.r_id(1))->'successor_task_id');
insert into recurrence_values values('child2',pg_temp.r_state(pg_temp.r_id(2))->'successor_task_id');
select pg_temp.r_assert(pg_temp.r_value('child1')<>'null'::jsonb,'edit-only completion generates under explicitly configured author');
select pg_temp.r_assert((select owner_id='fa110000-0000-4000-8000-000000000001' and status='todo' and title='Synthetic recurring task 1' and description='Keep this description' and priority='high'
 and labels='["Personal"]' and estimate_minutes=20 and subtasks->0->>'done'='false' and subtasks->0->>'id'<>'0a110000-0000-4000-8000-000000000001'
 and due_date=(pg_temp.r_value('saved')->'series'->>'anchor_date')::date+1 and start_date=due_date-2
 and scheduled_start_at is null and scheduled_end_at is null and scheduled_time_zone is null
 and assignee_member_id=(pg_temp.r_value('owner_member')#>>'{}')::uuid
 from public.tr8_workspace_tasks where id=(pg_temp.r_value('child1')#>>'{}')::uuid),'successor copies content, resets checklist, shifts civil dates and omits blocks');
select pg_temp.r_assert((select assignee_member_id is null from public.tr8_workspace_tasks where id=(pg_temp.r_value('child2')#>>'{}')::uuid)
 and pg_temp.r_state(pg_temp.r_id(2))->'series'->>'reason'='assignee_not_inherited','no assignment privilege means unassigned successor with explanation');
select pg_temp.r_assert(pg_temp.r_state(pg_temp.r_id(1))->'series'->>'current_task_id'=pg_temp.r_value('child1')#>>'{}','state points to current successor');
select pg_temp.r_complete(pg_temp.r_id(1),'todo');select pg_temp.r_complete(pg_temp.r_id(1));
select pg_temp.r_assert(pg_temp.r_state(pg_temp.r_id(1))->'successor_task_id'=pg_temp.r_value('child1'),'reopen and recomplete creates no duplicate');
select pg_temp.r_actor('fa110000-0000-4000-8000-000000000001');
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(1),pg_temp.r_rule(),2)$q$,'PT409','historical occurrence cannot edit active series');
select public.tr8_v2_delete_task(t.workspace_id,t.id,t.version) from public.tr8_workspace_tasks t where id=(pg_temp.r_value('child1')#>>'{}')::uuid;
select pg_temp.r_complete(pg_temp.r_id(1),'todo');select pg_temp.r_complete(pg_temp.r_id(1));
select pg_temp.r_assert(not exists(select 1 from public.tr8_workspace_tasks where id=(pg_temp.r_value('child1')#>>'{}')::uuid),'deleted next occurrence is not resurrected');
select pg_temp.r_assert(pg_temp.r_state(pg_temp.r_id(1))->'successor_task_id'=pg_temp.r_value('child1'),'tombstone retains successor identity after deletion');
select pg_temp.r_assert(public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','save',pg_temp.r_value('save_input'))=pg_temp.r_value('saved'),'receipt retry stays stable after completion and child deletion');

-- Current author permission loss blocks generation but preserves completion.
reset role;
delete from tr8_private.role_permissions where role_id='ca110000-0000-4000-8000-000000000002' and permission='task.create';
set local role authenticated;
select pg_temp.r_actor('fa110000-0000-4000-8000-000000000003');
select pg_temp.r_complete(pg_temp.r_id(3));
select pg_temp.r_assert((select status='done' from public.tr8_workspace_tasks where id=pg_temp.r_id(3)) and pg_temp.r_state(pg_temp.r_id(3))->'series'->>'state'='blocked'
 and pg_temp.r_state(pg_temp.r_id(3))->'successor_task_id'='null'::jsonb,'revoked author create permission leaves completion committed and series blocked');
select pg_temp.r_actor('fa110000-0000-4000-8000-000000000001');
select pg_temp.r_save(pg_temp.r_id(3),pg_temp.r_rule(),2);
select pg_temp.r_assert(pg_temp.r_state(pg_temp.r_id(3))->'successor_task_id'<>'null'::jsonb,'authorized explicit save retries blocked completed head once');
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(3),pg_temp.r_rule(),2)$q$,'PT409','stale blocked retry cannot create another successor');

-- Pause works even after the due date is cleared. Archive/restore stays paused.
select pg_temp.r_save(pg_temp.r_id(4),pg_temp.r_rule());
select public.tr8_v2_update_task(t.workspace_id,t.id,t.version,'{"due_date":null}') from public.tr8_workspace_tasks t where id=pg_temp.r_id(4);
select pg_temp.r_save(pg_temp.r_id(4),null,1);
select pg_temp.r_assert(pg_temp.r_state(pg_temp.r_id(4))->'series'->>'state'='paused','pause without due date works');
select public.tr8_v2_update_task(t.workspace_id,t.id,t.version,jsonb_build_object('due_date',(clock_timestamp() at time zone 'America/Santo_Domingo')::date+1)) from public.tr8_workspace_tasks t where id=pg_temp.r_id(4);
select pg_temp.r_complete(pg_temp.r_id(4));
select pg_temp.r_assert(pg_temp.r_state(pg_temp.r_id(4))->'successor_task_id'='null'::jsonb,'paused completion makes no successor');
select pg_temp.r_save(pg_temp.r_id(4),pg_temp.r_rule(),2);
insert into recurrence_values values('child4',pg_temp.r_state(pg_temp.r_id(4))->'successor_task_id');
select public.tr8_v2_work_management(t.workspace_id,'archive_task',jsonb_build_object('id',t.id,'version',t.version,'archived',true,'request_id',gen_random_uuid()))
 from public.tr8_workspace_tasks t where id=(pg_temp.r_value('child4')#>>'{}')::uuid;
select pg_temp.r_assert(pg_temp.r_state((pg_temp.r_value('child4')#>>'{}')::uuid)->'series'->>'reason'='task_archived','archiving head pauses series');
select public.tr8_v2_work_management(t.workspace_id,'archive_task',jsonb_build_object('id',t.id,'version',t.version,'archived',false,'request_id',gen_random_uuid()))
 from public.tr8_workspace_tasks t where id=(pg_temp.r_value('child4')#>>'{}')::uuid;
select pg_temp.r_assert(pg_temp.r_state((pg_temp.r_value('child4')#>>'{}')::uuid)->'series'->>'state'='paused','restore does not silently reactivate recurrence');

-- Inclusive termination and bulk completion both use the canonical hook.
select pg_temp.r_save(pg_temp.r_id(6),pg_temp.r_rule('daily',1,'[]',(select due_date from public.tr8_workspace_tasks where id=pg_temp.r_id(6))));
select pg_temp.r_complete(pg_temp.r_id(6));
select pg_temp.r_assert(pg_temp.r_state(pg_temp.r_id(6))->'series'->>'state'='finished' and pg_temp.r_state(pg_temp.r_id(6))->'successor_task_id'='null'::jsonb,'end date finishes without extra task');
select pg_temp.r_complete(pg_temp.r_id(6),'todo');select pg_temp.r_complete(pg_temp.r_id(6));
select pg_temp.r_assert(pg_temp.r_state(pg_temp.r_id(6))->'successor_task_id'='null'::jsonb,'finished occurrence remains terminal after recompletion');
select pg_temp.r_save(pg_temp.r_id(7),pg_temp.r_rule());
select public.tr8_v2_bulk_tasks('da110000-0000-4000-8000-000000000001',gen_random_uuid(),clock_timestamp(),'{"kind":"status","status":"done"}',
 (select jsonb_build_array(jsonb_build_object('id',t.id,'project_id',t.project_id,'version',t.version)) from public.tr8_workspace_tasks t where id=pg_temp.r_id(7)));
select pg_temp.r_assert(pg_temp.r_state(pg_temp.r_id(7))->'successor_task_id'<>'null'::jsonb,'bulk status completion creates one successor');

-- Copies are independent, and moving an existing head never inherits a series.
select pg_temp.r_save(pg_temp.r_id(9),pg_temp.r_rule());
insert into recurrence_values values('copy',public.tr8_v2_work_management('da110000-0000-4000-8000-000000000001','duplicate_task',
 jsonb_build_object('id',pg_temp.r_id(9),'version',(select version from public.tr8_workspace_tasks where id=pg_temp.r_id(9)),
 'target_project_id','aa110001-0000-4000-8000-000000000001','request_id','0a110000-0000-4000-8000-000000000009')));
select pg_temp.r_assert(pg_temp.r_state((pg_temp.r_value('copy')->>'id')::uuid)->'series'='null'::jsonb,'task copy has no recurrence');
select public.tr8_v2_work_management(t.workspace_id,'move_task',jsonb_build_object('id',t.id,'version',t.version,'target_project_id','aa110002-0000-4000-8000-000000000002','request_id',gen_random_uuid(),'clear_assignee',false))
 from public.tr8_workspace_tasks t where id=pg_temp.r_id(9);
select pg_temp.r_assert(pg_temp.r_state(pg_temp.r_id(9))=jsonb_build_object('task_id',pg_temp.r_id(9),'series',null,'occurrence_date',null,'successor_task_id',null),'moved head does not expose source series');
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(9),pg_temp.r_rule())$q$,'PT409','moved identity cannot silently rebind recurrence');
reset role;
select pg_temp.r_assert((select state='paused' and reason='task_moved' from tr8_private.task_recurrence_series where current_task_id=pg_temp.r_id(9)),'move pauses series at original project');
set local role authenticated;
select pg_temp.r_save(pg_temp.r_id(10),pg_temp.r_rule());
select pg_temp.r_actor('fa110000-0000-4000-8000-000000000002');
select pg_temp.r_assert(not exists(select 1 from jsonb_array_elements(public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','list','{"after_id":null,"limit":100}')->'items')x where x->>'task_id' in(pg_temp.r_id(9)::text,pg_temp.r_id(10)::text)),'summary list hides private and moved heads');
select pg_temp.r_error($q$select public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','state',jsonb_build_object('id',pg_temp.r_id(10),'project_id','aa110002-0000-4000-8000-000000000002','created_at',pg_temp.r_value('saved')->'series'->'current_task_created_at'))$q$,'PT404','private project state is indistinguishable from absent');
select pg_temp.r_actor('fa110000-0000-4000-8000-000000000004');
select pg_temp.r_error($q$select public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','list','{"after_id":null,"limit":100}')$q$,'PT404','unrelated user cannot list recurrence');

-- Real Google inbound projection path: no browser identity, no auth GUC spoof.
select pg_temp.r_actor('fa110000-0000-4000-8000-000000000001');select pg_temp.r_save(pg_temp.r_id(5),pg_temp.r_rule());
reset role;
insert into tr8_private.google_connections(id,user_id,generation,state,tasks_granted,calendar_id,credential_envelope)
 values('cfa11000-0000-4000-8000-000000000001','fa110000-0000-4000-8000-000000000001',1,'connected',true,'synthetic-recurrence@group.calendar.google.com','{"v":1,"kid":"synthetic","iv":"AAAAAAAAAAAAAAAA","ciphertext":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}');
insert into tr8_private.google_tasks_sync(connection_id,generation,enabled,export_enabled,export_list_id,export_enabled_at)
 values('cfa11000-0000-4000-8000-000000000001',1,true,true,'synthetic-recurring-list',statement_timestamp());
insert into tr8_private.google_tasks_lists(connection_id,generation,list_id,title,selected) values('cfa11000-0000-4000-8000-000000000001',1,'synthetic-recurring-list','Synthetic',true);
insert into tr8_private.google_tasks_links(id,connection_id,generation,list_id,remote_task_id,workspace_id,project_id,local_task_id,local_task_created_at,state,origin,creation_state,creation_marker,base_projection_hash,synced_local_hash)
 select 'cfa11000-0000-4000-8000-000000000002','cfa11000-0000-4000-8000-000000000001',1,'synthetic-recurring-list','synthetic-recurring-remote',workspace_id,project_id,id,created_at,'synced','tr8','bound','tr8:cfa11000-0000-4000-8000-000000000002',
 tr8_private.v6_projection_hash(tr8_private.v6_task_projection(id,created_at)),tr8_private.v6_projection_hash(tr8_private.v6_task_projection(id,created_at)) from public.tr8_workspace_tasks where id=pg_temp.r_id(5);
select pg_temp.r_actor(null);
select tr8_private.v6_observe('cfa11000-0000-4000-8000-000000000001','synthetic-recurring-list',jsonb_build_object('id','synthetic-recurring-remote','etag','"test-completed"','title',title,'completed',true,'start_date',start_date,'deleted',false,'assigned',false))
 from public.tr8_workspace_tasks where id=pg_temp.r_id(5);
select pg_temp.r_assert((select status='done' from public.tr8_workspace_tasks where id=pg_temp.r_id(5)),'Google Tasks incoming completion updates source');
select pg_temp.r_assert((select successor_task_id is not null from tr8_private.task_recurrence_occurrences where task_id=pg_temp.r_id(5)),'Google completion generates successor with null auth uid');
select pg_temp.r_assert((select count(*)=1 from tr8_private.google_tasks_links l join tr8_private.task_recurrence_occurrences o on o.successor_task_id=l.local_task_id and o.successor_task_created_at=l.local_task_created_at
 where o.task_id=pg_temp.r_id(5) and l.origin='tr8' and l.creation_state='ready'),'successor atomically exports one Tasks intent for inherited assignee');
select tr8_private.v6_observe('cfa11000-0000-4000-8000-000000000001','synthetic-recurring-list',jsonb_build_object('id','synthetic-recurring-remote','etag','"test-completed"','title',title,'completed',true,'start_date',start_date,'deleted',false,'assigned',false))
 from public.tr8_workspace_tasks where id=pg_temp.r_id(5);
select pg_temp.r_assert((select count(*)=2 from tr8_private.task_recurrence_occurrences where series_id=(select series_id from tr8_private.task_recurrence_occurrences where task_id=pg_temp.r_id(5))),'Google replay has only original plus one successor');

-- Input validation, receipt GC/version CAS and session revocation.
select pg_temp.r_actor('fa110000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(12),pg_temp.r_rule('daily',366))$q$,'22023','daily interval bounded');
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(12),pg_temp.r_rule('weekly',53,'[1]'))$q$,'22023','weekly interval bounded');
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(12),pg_temp.r_rule('monthly',13))$q$,'22023','monthly interval bounded');
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(12),pg_temp.r_rule('weekly',1,'[]'))$q$,'22023','weekly requires weekdays');
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(12),pg_temp.r_rule('weekly',1,'[1,1]'))$q$,'22023','weekly duplicates rejected');
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(12),pg_temp.r_rule('daily',1,'[1]'))$q$,'22023','nonweekly weekdays rejected');
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(12),pg_temp.r_rule('daily',1,'[]',null,'EST'))$q$,'22023','zone abbreviation rejected');
select pg_temp.r_error($q$select pg_temp.r_save(pg_temp.r_id(12),pg_temp.r_rule('daily',1,'[]','2000-01-01'))$q$,'22023','end before anchor rejected');
select pg_temp.r_error($q$select public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','save',jsonb_set(pg_temp.r_input(pg_temp.r_id(12),pg_temp.r_rule()),'{task_version}','1.5'))$q$,'22023','fractional task version rejected');
select pg_temp.r_error($q$select public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','save',pg_temp.r_input(pg_temp.r_id(12),pg_temp.r_rule())||'{"author_id":"forged"}')$q$,'22023','unknown authorization field rejected');
select pg_temp.r_error($q$select public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','state',jsonb_build_object('id',pg_temp.r_id(12),'project_id','aa110001-0000-4000-8000-000000000001','created_at','2000-01-01T00:00:00Z'))$q$,'PT404','wrong task creation identity rejected');
insert into recurrence_values values('cas_input',pg_temp.r_input(pg_temp.r_id(12),pg_temp.r_rule(),null,'0a110000-0000-4000-8000-000000000012'));
select public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','save',pg_temp.r_value('cas_input'));
reset role;
delete from tr8_private.task_recurrence_receipts where request_id='0a110000-0000-4000-8000-000000000012';
set local role authenticated;
select pg_temp.r_error($q$select public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','save',pg_temp.r_value('cas_input'))$q$,'PT409','receipt GC cannot reexecute initial configuration');
select public.tr8_v2_update_project('da110000-0000-4000-8000-000000000001','aa110001-0000-4000-8000-000000000001',1,jsonb_build_object('archived_at',clock_timestamp()));
select pg_temp.r_assert(pg_temp.r_state(pg_temp.r_id(12))->'series'->>'state'='paused' and pg_temp.r_state(pg_temp.r_id(12))->'series'->>'reason'='project_archived','project archive pauses current series');
select public.tr8_v2_update_project('da110000-0000-4000-8000-000000000001','aa110001-0000-4000-8000-000000000001',2,'{"archived_at":null}');
select pg_temp.r_assert(pg_temp.r_state(pg_temp.r_id(12))->'series'->>'state'='paused','project restore does not reactivate');
reset role;
update auth.sessions set not_after=clock_timestamp()-interval '1 minute' where id='fa110000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.r_error($q$select public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','state',
 jsonb_build_object('id',pg_temp.r_id(12),'project_id',pg_temp.r_value('cas_input')->'project_id','created_at',pg_temp.r_value('cas_input')->'created_at'))$q$,'42501','terminated browser cannot read recurrence');
select pg_temp.r_error($q$select public.tr8_v2_recurrence('da110000-0000-4000-8000-000000000001','save',pg_temp.r_value('save_input'))$q$,'42501','terminated browser cannot replay receipt');
reset role;

-- All data present before these synthetic fixtures remains byte-for-byte equal.
select pg_temp.r_assert((select hash from recurrence_existing where kind='projects')=(select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p where p.id in(select unnest(ids) from recurrence_existing where kind='projects')),'all existing projects preserved');
select pg_temp.r_assert((select hash from recurrence_existing where kind='tasks')=(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t where t.id in(select unnest(ids) from recurrence_existing where kind='tasks')),'all existing tasks preserved');
select pg_temp.r_assert((select hash from recurrence_existing where kind='finances')=(select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f where f.owner_id in(select unnest(ids) from recurrence_existing where kind='finances')),'all existing finances preserved');
select pg_temp.r_assert((select hash from recurrence_config)=(select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c),'Auth config and closed external registrations preserved');
select current_setting('tr8.recurrence_checks')::integer as recurrence_checks;
rollback;
