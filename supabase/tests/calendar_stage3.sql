-- Stage 3 adversarial checks. Disposable test database ONLY, after migration.
-- JWT/SQL roles are real; all synthetic identities and content roll back.
-- Identity sequences can consume values during rollback; gaps are expected.
begin;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
select set_config('tr8.stage3_test_count','0',true);
create temporary table tr8_s3_runtime(key text primary key,value jsonb) on commit drop;
create temporary table tr8_s3_existing on commit drop as
select 'projects'::text entity,coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb) payload from public.tr8_workspace_projects p
union all select 'tasks',coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.tr8_workspace_tasks t
union all select 'users',coalesce(jsonb_agg(to_jsonb(a) order by user_id),'[]'::jsonb) from tr8_private.app_users a;
create function pg_temp.s3_assert(p_ok boolean,p_label text)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if p_ok is distinct from true then raise exception 'Assertion failed: %',p_label; end if;
  perform set_config('tr8.stage3_test_count',(current_setting('tr8.stage3_test_count')::integer+1)::text,true);
end; $$;
create function pg_temp.s3_error(p_sql text,p_states text[],p_label text)
returns void language plpgsql security invoker set search_path='' as $$
begin
  begin execute p_sql;
  exception when others then
    if sqlstate=any(p_states) then perform pg_temp.s3_assert(true,p_label); return; end if;
    raise exception 'Assertion failed: %; expected %, received % (%)',p_label,p_states,sqlstate,sqlerrm;
  end;
  raise exception 'Assertion failed: %; operation unexpectedly succeeded',p_label;
end; $$;
create function pg_temp.s3_actor(p_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
begin
  perform set_config('request.jwt.claim.sub',coalesce(p_id::text,''),true);
  perform set_config('request.jwt.claims',case when p_id is null then '{}' else jsonb_build_object('sub',p_id,'role','authenticated',
    'user_metadata',jsonb_build_object('role','Owner','permissions',array['*']))::text end,true);
end; $$;
create function pg_temp.s3_put(p_key text,p_value jsonb)
returns void language sql security invoker set search_path='' as $$ insert into pg_temp.tr8_s3_runtime values(p_key,p_value) on conflict(key) do update set value=excluded.value; $$;
create function pg_temp.s3_get(p_key text)
returns jsonb language sql security invoker set search_path='' as $$ select value from pg_temp.tr8_s3_runtime where key=p_key; $$;
create function pg_temp.s3_id(p_key text)
returns uuid language sql security invoker set search_path='' as $$ select (pg_temp.s3_get(p_key)->>'id')::uuid; $$;
create function pg_temp.s3_page(p_from date default '2026-03-08',p_to date default '2026-03-09',p_zone text default 'America/New_York',p_limit int default 100,p_cursor text default null)
returns jsonb language sql security invoker set search_path='' as $$
  select public.tr8_v2_list_calendar(array[pg_temp.s3_id('team')],p_from,p_to,p_zone,p_cursor=>p_cursor,p_limit=>p_limit); $$;
do $$ begin execute format('grant usage on schema %I to anon,authenticated',pg_my_temp_schema()::regnamespace::text); end $$;
grant select,insert,update on pg_temp.tr8_s3_runtime to authenticated;
grant execute on function pg_temp.s3_assert(boolean,text),pg_temp.s3_error(text,text[],text),pg_temp.s3_actor(uuid),pg_temp.s3_put(text,jsonb),
  pg_temp.s3_get(text),pg_temp.s3_id(text),pg_temp.s3_page(date,date,text,int,text) to anon,authenticated;

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('f3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','tr8-stage3-'||n||'@example.test',
  statement_timestamp(),'{}','{"role":"Owner"}',statement_timestamp(),statement_timestamp() from generate_series(1,7) n;
insert into tr8_private.app_users(user_id,enabled,display_name)
select ('f3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,n<>6,'Synthetic stage 3 '||n from generate_series(1,6) n;

-- Privilege surface: no table, column, sequence, helper or anonymous bypass.
do $$
declare v_name text; v_fn record;
begin
  perform pg_temp.s3_assert((select not external_invites_enabled from tr8_private.app_config where singleton),'external onboarding remains off');
  perform pg_temp.s3_assert((select count(*)=0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'tr8_v2_%' and p.prosecdef),'all public v2 APIs remain invokers');
  foreach v_name in array array['tr8_workspace_projects','tr8_workspace_tasks'] loop
    perform pg_temp.s3_assert(not has_table_privilege('authenticated','public.'||v_name,'INSERT,UPDATE,DELETE'),'direct DML closed on '||v_name);
    perform pg_temp.s3_assert(not exists(select 1 from information_schema.column_privileges where table_schema='public' and table_name=v_name and grantee in ('PUBLIC','anon','authenticated') and privilege_type in ('INSERT','UPDATE')),'column DML closed on '||v_name);
  end loop;
  perform pg_temp.s3_assert(not has_table_privilege('authenticated','tr8_private.app_users','SELECT,INSERT,UPDATE,DELETE'),'private profile table closed');
  perform pg_temp.s3_assert(not has_sequence_privilege('authenticated','public.tr8_tasks_task_number_seq','USAGE,UPDATE'),'sequence stays closed');
  for v_fn in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='tr8_private' and p.proname like 'v3_%' loop
    perform pg_temp.s3_assert(not has_function_privilege('anon',v_fn.signature,'EXECUTE'),'anonymous private helper denied '||v_fn.proname);
    if v_fn.proname<>all(array['v3_get_calendar_preferences','v3_set_calendar_preferences','v3_schedule_task','v3_list_calendar','v3_list_unscheduled']) then
      perform pg_temp.s3_assert(not has_function_privilege('authenticated',v_fn.signature,'EXECUTE'),'authenticated arbitrary helper denied '||v_fn.proname);
    end if;
  end loop;
end; $$;
set local role anon;
select pg_temp.s3_actor(null);
select pg_temp.s3_error('select public.tr8_v2_get_calendar_preferences()',array['42501'],'anonymous preferences denied');
select pg_temp.s3_error($sql$select public.tr8_v2_list_calendar(array[gen_random_uuid()],'2026-03-08','2026-03-09','UTC')$sql$,array['42501'],'anonymous calendar denied');
set local role authenticated;
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000007');
select pg_temp.s3_error('select public.tr8_v2_get_calendar_preferences()',array['42501'],'forged Owner metadata cannot access profile');
select pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(gen_random_uuid(),gen_random_uuid(),1,'garbage','garbage','garbage')$sql$,array['42501'],'actor gate precedes resource and instant validation');
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000006');
select pg_temp.s3_error('select public.tr8_v2_get_calendar_preferences()',array['42501'],'disabled profile denied');

-- Owner 1 has personal plus team; owner 5 has another isolated team.
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000001');
select pg_temp.s3_put('context',public.tr8_v2_get_context());
select pg_temp.s3_put('team',public.tr8_v2_create_team('c3000000-0000-4000-8000-000000000001','Stage 3 synthetic team'));
select pg_temp.s3_put('project',to_jsonb(public.tr8_v2_create_project(pg_temp.s3_id('team'),'a3000001-0000-4000-8000-000000000001','Scheduled project','','#5A67D8','active')));
select pg_temp.s3_put('secret',to_jsonb(public.tr8_v2_create_project(pg_temp.s3_id('team'),'a3000002-0000-4000-8000-000000000002','SECRET CALENDAR PROJECT','','#5A67D8','active')));
select pg_temp.s3_put('archive',to_jsonb(public.tr8_v2_create_project(pg_temp.s3_id('team'),'a3000003-0000-4000-8000-000000000003','Archived calendar project','','#5A67D8','active')));
select pg_temp.s3_put('personal',jsonb_build_object('id',pg_temp.s3_get('context')->>'personal_workspace_id'));
select pg_temp.s3_put('personal-project',to_jsonb(public.tr8_v2_create_project(pg_temp.s3_id('personal'),'a3000004-0000-4000-8000-000000000004','Personal calendar project','','#5A67D8','active')));
select pg_temp.s3_put('block',to_jsonb(public.tr8_v2_create_task(pg_temp.s3_id('team'),'e3000000-0000-4000-8000-000000000001',pg_temp.s3_id('project'),'Block and independent due','','todo','high','2026-03-01','2026-03-08')));
select pg_temp.s3_put('start',to_jsonb(public.tr8_v2_create_task(pg_temp.s3_id('team'),'e3000000-0000-4000-8000-000000000002',pg_temp.s3_id('project'),'Only civil start','','progress','none','2026-03-08',null)));
select pg_temp.s3_put('due-end',to_jsonb(public.tr8_v2_create_task(pg_temp.s3_id('team'),'e3000000-0000-4000-8000-000000000003',pg_temp.s3_id('project'),'Due at exclusive end','','done','none',null,'2026-03-09')));
select pg_temp.s3_put('unscheduled',to_jsonb(public.tr8_v2_create_task(pg_temp.s3_id('team'),'e3000000-0000-4000-8000-000000000004',pg_temp.s3_id('project'),'Unscheduled one','','todo','none',null,null)));
select pg_temp.s3_put('before',to_jsonb(public.tr8_v2_create_task(pg_temp.s3_id('team'),'e3000000-0000-4000-8000-000000000005',pg_temp.s3_id('project'),'Ends exactly at day start','','todo','none',null,null)));
select pg_temp.s3_put('after',to_jsonb(public.tr8_v2_create_task(pg_temp.s3_id('team'),'e3000000-0000-4000-8000-000000000006',pg_temp.s3_id('project'),'Starts exactly at day end','','todo','none',null,null)));
select pg_temp.s3_put('cross',to_jsonb(public.tr8_v2_create_task(pg_temp.s3_id('team'),'e3000000-0000-4000-8000-000000000007',pg_temp.s3_id('project'),'Crosses civil start','','todo','none',null,null)));
select pg_temp.s3_put('secret-task',to_jsonb(public.tr8_v2_create_task(pg_temp.s3_id('team'),'e3000000-0000-4000-8000-000000000008',pg_temp.s3_id('secret'),'SECRET CALENDAR TASK','','todo','none',null,'2026-03-08')));
select pg_temp.s3_put('archive-task',to_jsonb(public.tr8_v2_create_task(pg_temp.s3_id('team'),'e3000000-0000-4000-8000-000000000009',pg_temp.s3_id('archive'),'Archived dated task','','todo','none',null,'2026-03-08')));
select pg_temp.s3_put('fall',to_jsonb(public.tr8_v2_create_task(pg_temp.s3_id('team'),'e3000000-0000-4000-8000-000000000010',pg_temp.s3_id('project'),'Fall back ambiguous local hour','','todo','none',null,null)));
select pg_temp.s3_put('personal-task',to_jsonb(public.tr8_v2_create_task(pg_temp.s3_id('personal'),'e3000000-0000-4000-8000-000000000011',pg_temp.s3_id('personal-project'),'Personal unassigned dated task','','todo','none',null,'2026-03-08')));
select pg_temp.s3_put('unscheduled-2',to_jsonb(public.tr8_v2_create_task(pg_temp.s3_id('team'),'e3000000-0000-4000-8000-000000000012',pg_temp.s3_id('project'),'Unscheduled two','','todo','none',null,null)));
select pg_temp.s3_put('block',to_jsonb(public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),1,'2026-03-08T01:30:00-05:00','2026-03-08T03:30:00-04:00','America/New_York')));
select pg_temp.s3_put('before',to_jsonb(public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('before'),1,'2026-03-08T04:00:00Z','2026-03-08T05:00:00Z','America/New_York')));
select pg_temp.s3_put('after',to_jsonb(public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('after'),1,'2026-03-09T04:00:00Z','2026-03-09T05:00:00Z','America/New_York')));
select pg_temp.s3_put('cross',to_jsonb(public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('cross'),1,'2026-03-08T04:30:00Z','2026-03-08T05:30:00Z','America/New_York')));
select pg_temp.s3_put('fall',to_jsonb(public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('fall'),1,'2026-11-01T01:30:00-04:00','2026-11-01T01:30:00-05:00','America/New_York')));
select pg_temp.s3_put('archive',to_jsonb(public.tr8_v2_update_project(pg_temp.s3_id('team'),pg_temp.s3_id('archive'),1,'{"archived_at":"2026-03-01T00:00:00Z"}')));
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000005');
select pg_temp.s3_put('other-team',public.tr8_v2_create_team('c3000000-0000-4000-8000-000000000005','Other stage 3 team'));
reset role;
insert into tr8_private.workspace_members(id,workspace_id,user_id)
select ('b3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,pg_temp.s3_id('team'),('f3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(2,5) n;
select pg_temp.s3_put('read-role',to_jsonb(r)) from tr8_private.workspace_roles r where workspace_id=pg_temp.s3_id('team') and template_key='read';
select pg_temp.s3_put('admin-role',to_jsonb(r)) from tr8_private.workspace_roles r where workspace_id=pg_temp.s3_id('team') and template_key='admin';
set local role authenticated;
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000001');
select pg_temp.s3_put('edit-role',public.tr8_v2_create_role(pg_temp.s3_id('team'),'d3000000-0000-4000-8000-000000000001','Calendar editor',array['project.read','task.read','task.edit']));
select pg_temp.s3_put('no-read-role',public.tr8_v2_create_role(pg_temp.s3_id('team'),'d3000000-0000-4000-8000-000000000002','Project without task read',array['project.read','task.edit']));
select pg_temp.s3_put('editor',public.tr8_v2_set_member_roles(pg_temp.s3_id('team'),'b3000000-0000-4000-8000-000000000002',1,array[pg_temp.s3_id('edit-role')]));
select pg_temp.s3_put('reader',public.tr8_v2_set_member_roles(pg_temp.s3_id('team'),'b3000000-0000-4000-8000-000000000003',1,array[pg_temp.s3_id('read-role')]));
select pg_temp.s3_put('admin',public.tr8_v2_set_member_roles(pg_temp.s3_id('team'),'b3000000-0000-4000-8000-000000000004',1,array[pg_temp.s3_id('admin-role')]));
select pg_temp.s3_put('no-reader',public.tr8_v2_set_member_roles(pg_temp.s3_id('team'),'b3000000-0000-4000-8000-000000000005',1,array[pg_temp.s3_id('no-read-role')]));
select pg_temp.s3_put('editor-access',public.tr8_v2_set_project_access(pg_temp.s3_id('team'),pg_temp.s3_id('project'),pg_temp.s3_id('editor'),0,'write'));
select pg_temp.s3_put('reader-access',public.tr8_v2_set_project_access(pg_temp.s3_id('team'),pg_temp.s3_id('project'),pg_temp.s3_id('reader'),0,'read'));
select pg_temp.s3_put('no-reader-access',public.tr8_v2_set_project_access(pg_temp.s3_id('team'),pg_temp.s3_id('project'),pg_temp.s3_id('no-reader'),0,'write'));

-- Preference is private, explicit, IANA-validated and optimistic-concurrent.
do $$
declare v_first jsonb; v_next jsonb;
begin
  v_first:=public.tr8_v2_get_calendar_preferences();
  perform pg_temp.s3_assert(v_first->'time_zone'='null'::jsonb and (v_first->>'version')::int=1,'preference begins null and version one');
  v_next:=public.tr8_v2_set_calendar_preferences(1,'America/La_Paz');
  perform pg_temp.s3_assert(v_next->>'time_zone'='America/La_Paz' and (v_next->>'version')::int=2,'owner explicitly saves profile zone');
  perform pg_temp.s3_error($sql$select public.tr8_v2_set_calendar_preferences(1,'UTC')$sql$,array['PT409'],'stale profile update conflicts');
  perform pg_temp.s3_error($sql$select public.tr8_v2_set_calendar_preferences(2,'EST')$sql$,array['22023'],'abbreviation is not an IANA preference');
  perform pg_temp.s3_error($sql$select public.tr8_v2_set_calendar_preferences(2,'+05:00')$sql$,array['22023'],'raw offset preference rejected');
  perform pg_temp.s3_error($sql$select public.tr8_v2_set_calendar_preferences(2,'Not/AZone')$sql$,array['22023'],'unknown IANA preference rejected');
  perform pg_temp.s3_error($sql$select public.tr8_v2_set_calendar_preferences(2,null)$sql$,array['22023'],'null does not silently reset explicit preference');
end; $$;

-- Projection: distinct kinds, civil dates, exact exclusive boundaries and DST.
do $$
declare v_page jsonb; v_ny jsonb; v_utc jsonb; v_fall jsonb;
begin
  v_page:=pg_temp.s3_page();
  perform pg_temp.s3_assert(jsonb_array_length(v_page->'items')=5,'owner gets cross-start block, due+block, start and private due only');
  perform pg_temp.s3_assert((select count(*)=2 from jsonb_array_elements(v_page->'items') x where x->>'task_id'=pg_temp.s3_id('block')::text),'one task has independent due and block items');
  perform pg_temp.s3_assert((select count(*)=1 from jsonb_array_elements(v_page->'items') x where x->>'kind'='start' and x->>'task_id'=pg_temp.s3_id('start')::text),'start-only is one day without expanding duration');
  perform pg_temp.s3_assert(not exists(select 1 from jsonb_array_elements(v_page->'items') x where x->>'task_id' in(pg_temp.s3_id('before')::text,pg_temp.s3_id('after')::text,pg_temp.s3_id('due-end')::text)),'end equals range start and start equals range end are excluded');
  perform pg_temp.s3_assert((select count(*)=0 from jsonb_array_elements(v_page->'items') x where x ? 'description' or x ? 'owner_email' or x ? 'permissions' or x ? 'token'),'calendar has no descriptions, emails, permission sets or credentials');
  perform pg_temp.s3_assert((select bool_and((x->>'can_edit')::boolean) from jsonb_array_elements(v_page->'items') x),'owner can edit active calendar items');
  perform pg_temp.s3_assert((select bool_and(x->>'workspace_name'='Stage 3 synthetic team') from jsonb_array_elements(v_page->'items') x),'general items carry authorized workspace label');
  v_ny:=(select x from jsonb_array_elements(v_page->'items') x where x->>'task_id'=pg_temp.s3_id('block')::text and x->>'kind'='block');
  perform pg_temp.s3_assert((v_ny->>'end_at')::timestamptz-(v_ny->>'start_at')::timestamptz=interval '1 hour','spring DST 01:30 to03:30 preserves real one-hour duration');
  v_utc:=pg_temp.s3_page('2026-03-08','2026-03-09','Pacific/Kiritimati');
  perform pg_temp.s3_assert((select x->>'date'='2026-03-08' from jsonb_array_elements(v_utc->'items') x where x->>'task_id'=pg_temp.s3_id('block')::text and x->>'kind'='due'),'civil due does not shift across display zones');
  v_fall:=pg_temp.s3_page('2026-11-01','2026-11-02');
  perform pg_temp.s3_assert(jsonb_array_length(v_fall->'items')=1 and (v_fall->'items'->0->>'end_at')::timestamptz-(v_fall->'items'->0->>'start_at')::timestamptz=interval '1 hour','ambiguous fall local hours retain two explicit instants');
  perform pg_temp.s3_assert(jsonb_array_length(public.tr8_v2_list_calendar(array[pg_temp.s3_id('team')],'2026-03-08','2026-03-09','America/New_York',p_include_archived=>true)->'items')=6,'archived items are opt-in');
  perform pg_temp.s3_assert((select not (x->>'can_edit')::boolean from jsonb_array_elements(public.tr8_v2_list_calendar(array[pg_temp.s3_id('team')],'2026-03-08','2026-03-09','America/New_York',p_include_archived=>true)->'items') x where x->>'task_id'=pg_temp.s3_id('archive-task')::text),'archived items are never editable');
  perform pg_temp.s3_assert(jsonb_array_length(public.tr8_v2_list_calendar(array[pg_temp.s3_id('team'),pg_temp.s3_id('personal')],'2026-03-08','2026-03-09','America/New_York')->'items')=6,'general calendar combines authorized personal and team');
  perform pg_temp.s3_assert(jsonb_array_length(public.tr8_v2_list_calendar(array[pg_temp.s3_id('team'),pg_temp.s3_id('personal')],'2026-03-08','2026-03-09','America/New_York',p_mine=>true)->'items')=1,'mine includes personal unassigned, not all owner team tasks');
  perform pg_temp.s3_assert(jsonb_array_length(public.tr8_v2_list_calendar(array[pg_temp.s3_id('team')],'2026-03-08','2026-03-09','UTC',p_project_ids=>array[gen_random_uuid()])->'items')=0,'unknown project filter returns no existence detail');
  perform pg_temp.s3_assert(jsonb_array_length(public.tr8_v2_list_calendar(array[pg_temp.s3_id('team')],'2026-03-08','2026-03-09','UTC',p_statuses=>array['progress'])->'items')=1,'status filter is applied');
  perform pg_temp.s3_assert(jsonb_array_length(public.tr8_v2_list_calendar(array[pg_temp.s3_id('team')],'2026-03-08','2026-03-09','UTC',p_project_ids=>array[]::uuid[])->'items')=0,'empty project selection means no items');
  perform pg_temp.s3_assert(jsonb_array_length(public.tr8_v2_list_unscheduled(array[pg_temp.s3_id('team')])->'items')=2,'only completely dateless tasks are unscheduled');
end; $$;

-- Inputs and cursors are bounded; no filter reuse or duplicate pagination.
do $$
declare v_page jsonb; v_seen text[]:=array[]::text[]; v_item jsonb; v_cursor text; v_count int:=0; v_unscheduled jsonb;
begin
  loop
    v_page:=pg_temp.s3_page(p_limit=>1,p_cursor=>v_cursor);
    for v_item in select x from jsonb_array_elements(v_page->'items') x loop
      perform pg_temp.s3_assert(not (v_item->>'id'=any(v_seen)),'calendar page stable identity is not duplicated');
      v_seen:=array_append(v_seen,v_item->>'id'); v_count:=v_count+1;
    end loop;
    v_cursor:=v_page->>'next_cursor'; exit when v_cursor is null;
    if v_count>20 then raise exception 'Pagination loop'; end if;
  end loop;
  perform pg_temp.s3_assert(v_count=5,'single-item pagination returns every projection exactly once');
  v_cursor:=pg_temp.s3_page(p_limit=>1)->>'next_cursor';
  perform pg_temp.s3_error(format('select pg_temp.s3_page(''2026-03-08'',''2026-03-10'',''America/New_York'',1,%L)',v_cursor),array['22023'],'cursor cannot be reused across date ranges');
  perform pg_temp.s3_error(format('select pg_temp.s3_page(''2026-03-08'',''2026-03-09'',''UTC'',1,%L)',v_cursor),array['22023'],'cursor cannot be reused across display zones');
  perform pg_temp.s3_error(format('select public.tr8_v2_list_calendar(array[pg_temp.s3_id(''team'')],''2026-03-08'',''2026-03-09'',''America/New_York'',p_mine=>true,p_cursor=>%L)',v_cursor),array['22023'],'cursor cannot be reused across mine filter');
  perform pg_temp.s3_error(format('select public.tr8_v2_list_calendar(array[pg_temp.s3_id(''team'')],''2026-03-08'',''2026-03-09'',''America/New_York'',p_include_archived=>true,p_cursor=>%L)',v_cursor),array['22023'],'cursor cannot be reused across archive filter');
  perform pg_temp.s3_error($sql$select pg_temp.s3_page(p_cursor=>'notbase64!')$sql$,array['22023'],'malformed cursor rejected');
  perform pg_temp.s3_error($sql$select pg_temp.s3_page(p_cursor=>repeat('a',32769))$sql$,array['22023'],'oversized cursor rejected');
  perform pg_temp.s3_error($sql$select pg_temp.s3_page(p_limit=>0)$sql$,array['22023'],'zero page size rejected');
  perform pg_temp.s3_error($sql$select pg_temp.s3_page(p_limit=>251)$sql$,array['22023'],'page above 250 rejected');
  perform pg_temp.s3_error($sql$select pg_temp.s3_page('2026-01-01','2026-04-05')$sql$,array['22023'],'94-day range rejected');
  perform pg_temp.s3_assert(public.tr8_v2_list_calendar(array[pg_temp.s3_id('team')],'2026-01-01','2026-04-04','UTC') is not null,'93-day range accepted');
  perform pg_temp.s3_error($sql$select pg_temp.s3_page('2026-03-08','2026-03-08')$sql$,array['22023'],'empty range rejected');
  perform pg_temp.s3_error($sql$select pg_temp.s3_page('2026-03-09','2026-03-08')$sql$,array['22023'],'reversed range rejected');
  perform pg_temp.s3_error($sql$select pg_temp.s3_page('2026-03-08','2026-03-09','EST')$sql$,array['22023'],'calendar abbreviations rejected');
  perform pg_temp.s3_error($sql$select pg_temp.s3_page('2026-03-08','infinity')$sql$,array['22023'],'infinite calendar range rejected');
  perform pg_temp.s3_error($sql$select public.tr8_v2_list_calendar(array[]::uuid[],'2026-03-08','2026-03-09','UTC')$sql$,array['22023'],'empty workspace set rejected');
  perform pg_temp.s3_error($sql$select public.tr8_v2_list_calendar(array[null]::uuid[],'2026-03-08','2026-03-09','UTC')$sql$,array['22023'],'null workspace ID rejected');
  perform pg_temp.s3_error($sql$select public.tr8_v2_list_calendar(array_fill(pg_temp.s3_id('team'),array[51]),'2026-03-08','2026-03-09','UTC')$sql$,array['22023'],'workspace request is bounded');
  perform pg_temp.s3_error($sql$select public.tr8_v2_list_calendar(array[array[pg_temp.s3_id('team')]],'2026-03-08','2026-03-09','UTC')$sql$,array['22023'],'multidimensional workspace filters rejected');
  perform pg_temp.s3_error($sql$select public.tr8_v2_list_calendar(array[pg_temp.s3_id('team')],'2026-03-08','2026-03-09','UTC',p_statuses=>array['unknown'])$sql$,array['22023'],'unknown task status rejected');
  v_unscheduled:=public.tr8_v2_list_unscheduled(array[pg_temp.s3_id('team')],p_limit=>1);
  perform pg_temp.s3_assert(v_unscheduled->>'next_cursor' is not null and jsonb_array_length(v_unscheduled->'items')=1,'unscheduled list is paginated');
  perform pg_temp.s3_assert((public.tr8_v2_list_unscheduled(array[pg_temp.s3_id('team')],p_cursor=>v_unscheduled->>'next_cursor')->'items'->0->>'task_id')<>(v_unscheduled->'items'->0->>'task_id'),'unscheduled second page advances stable identity');
  perform pg_temp.s3_error(format('select public.tr8_v2_list_unscheduled(array[pg_temp.s3_id(''team'')],p_mine=>true,p_cursor=>%L)',v_unscheduled->>'next_cursor'),array['22023'],'unscheduled cursor is bound to filters');
  perform pg_temp.s3_error(format('select public.tr8_v2_list_unscheduled(array[pg_temp.s3_id(''team'')],p_cursor=>%L)',v_cursor),array['22023'],'calendar cursor cannot drive unscheduled list');
end; $$;

-- Scheduler validates complete blocks and exact instants after resource access.
do $$
declare v_task jsonb; v_old jsonb;
begin
  perform pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),1,null,null,null)$sql$,array['PT409'],'stale schedule version rejected');
  perform pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),2,'2026-03-08T01:30:00', '2026-03-08T03:30:00','America/New_York')$sql$,array['22023'],'offset-less nonexistent or ambiguous local inputs rejected');
  perform pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),2,'2026-03-08T24:00:00Z','2026-03-09T01:00:00Z','UTC')$sql$,array['22023'],'hour 24 is not normalized silently');
  perform pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),2,'2026-03-08T01:00:60Z','2026-03-08T02:00:00Z','UTC')$sql$,array['22023'],'second 60 is not normalized silently');
  perform pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),2,'2026-02-30T01:00:00Z','2026-03-08T02:00:00Z','UTC')$sql$,array['22023'],'invalid civil timestamp date rejected');
  perform pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),2,'2026-03-08T01:00:00Z',null,'UTC')$sql$,array['22023'],'partial block rejected');
  perform pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),2,'2026-03-08T01:00:00Z','2026-03-08T01:00:00Z','UTC')$sql$,array['22023'],'zero duration rejected');
  perform pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),2,'2026-03-08T02:00:00Z','2026-03-08T01:00:00Z','UTC')$sql$,array['22023'],'negative duration rejected');
  perform pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),2,'infinity','infinity','UTC')$sql$,array['22023'],'infinite blocks rejected');
  perform pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),2,'2026-03-08T01:00:00Z','2026-03-08T02:00:00Z','EST')$sql$,array['22023'],'schedule timezone abbreviation rejected');
  perform pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('archive-task'),1,'2026-03-08T01:00:00Z','2026-03-08T02:00:00Z','UTC')$sql$,array['PT409'],'archived project schedule rejected');
  v_old:=pg_temp.s3_get('block');
  v_task:=to_jsonb(public.tr8_v2_update_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),2,'{"title":"Old CRUD preserves block"}'));
  perform pg_temp.s3_assert(v_task->'scheduled_start_at'=v_old->'scheduled_start_at' and v_task->'scheduled_end_at'=v_old->'scheduled_end_at' and v_task->'scheduled_time_zone'=v_old->'scheduled_time_zone','legacy task update preserves full block');
  perform pg_temp.s3_assert((v_task->>'version')::int=3,'legacy update increments exactly one version');
  perform pg_temp.s3_error($sql$select public.tr8_v2_update_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),3,'{"scheduled_start_at":null}')$sql$,array['22023'],'old patch cannot bypass scheduler');
  v_task:=to_jsonb(public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),3,null,null,null));
  perform pg_temp.s3_assert(v_task->'scheduled_start_at'='null'::jsonb and v_task->'scheduled_end_at'='null'::jsonb and v_task->'scheduled_time_zone'='null'::jsonb,'clear schedule is all-null');
  perform pg_temp.s3_assert(v_task->>'due_date'='2026-03-08' and v_task->>'start_date'='2026-03-01','clear block preserves independent civil dates');
  v_task:=to_jsonb(public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('block'),4,'2026-03-10T01:00:00Z','2026-03-10T02:00:00Z','UTC'));
  perform pg_temp.s3_assert(v_task->>'due_date'='2026-03-08','block after due is valid without silently changing due');
  perform pg_temp.s3_put('block',v_task);
end; $$;
reset role;
select pg_temp.s3_assert((select count(*)=3 from tr8_private.workspace_activity where workspace_id=pg_temp.s3_id('team') and resource_id=pg_temp.s3_id('block') and action='task.scheduled'),'successful scheduler writes exactly one audit record; invalid writes leave none');
set local role authenticated;

-- Live ACL and permissions remain independent. Admin alone sees no private data.
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000004');
select pg_temp.s3_assert(pg_temp.s3_page()->'items'='[]'::jsonb,'administrator without ACL sees no calendar items');
select pg_temp.s3_assert(public.tr8_v2_list_unscheduled(array[pg_temp.s3_id('team')])->'items'='[]'::jsonb,'administrator without ACL sees no unscheduled data');
select pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('secret-task'),1,'invalid','invalid','invalid')$sql$,array['PT404'],'private scheduler hides both existence and validation');
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000005');
select pg_temp.s3_error('select pg_temp.s3_page()',array['PT404'],'project.read without task.read cannot query calendar');
select pg_temp.s3_error($sql$select public.tr8_v2_list_unscheduled(array[pg_temp.s3_id('team')])$sql$,array['PT404'],'unscheduled requires task.read');
select pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('start'),1,'2026-03-08T01:00:00Z','2026-03-08T02:00:00Z','UTC')$sql$,array['PT404'],'task.edit without task.read cannot schedule');
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000003');
do $$
declare v_page jsonb;
begin
  v_page:=pg_temp.s3_page();
  perform pg_temp.s3_assert(jsonb_array_length(v_page->'items')=3,'read-only project reader gets only its three visible March8 references');
  perform pg_temp.s3_assert((select bool_and(not (x->>'can_edit')::boolean) from jsonb_array_elements(v_page->'items') x),'read-only calendar does not advertise editing');
  perform pg_temp.s3_assert(position('SECRET' in v_page::text)=0 and not(v_page ? 'total'),'hidden names and totals never leak');
  perform pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('start'),1,null,null,null)$sql$,array['PT404'],'read-only member cannot schedule');
  perform pg_temp.s3_error($sql$select public.tr8_v2_list_calendar(array[pg_temp.s3_id('team'),pg_temp.s3_id('other-team')],'2026-03-08','2026-03-09','UTC')$sql$,array['PT404'],'one unauthorized workspace rejects entire explicit workspace request');
  perform pg_temp.s3_assert((public.tr8_v2_get_calendar_preferences()->'time_zone')='null'::jsonb,'another user cannot see owner preference');
end; $$;
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000002');
select pg_temp.s3_assert((select bool_and((x->>'can_edit')::boolean) from jsonb_array_elements(pg_temp.s3_page()->'items') x),'task.edit plus write ACL advertises editing');
select pg_temp.s3_put('start',to_jsonb(public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('start'),1,'2026-03-08T10:00:00Z','2026-03-08T11:00:00Z','UTC')));
select pg_temp.s3_assert((pg_temp.s3_get('start')->>'version')::int=2,'authorized editor schedules task once');
select pg_temp.s3_put('editor-page',pg_temp.s3_page(p_limit=>1));
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000001');
select pg_temp.s3_put('editor-access',public.tr8_v2_set_project_access(pg_temp.s3_id('team'),pg_temp.s3_id('project'),pg_temp.s3_id('editor'),1,'read'));
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000002');
select pg_temp.s3_assert((select bool_and(not (x->>'can_edit')::boolean) from jsonb_array_elements(pg_temp.s3_page()->'items') x),'write-to-read downgrade changes capabilities with same JWT');
select pg_temp.s3_error($sql$select public.tr8_v2_schedule_task(pg_temp.s3_id('team'),pg_temp.s3_id('start'),2,null,null,null)$sql$,array['PT404'],'same JWT loses scheduling after ACL downgrade');
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000001');
select public.tr8_v2_remove_project_access(pg_temp.s3_id('team'),pg_temp.s3_id('project'),pg_temp.s3_id('editor'),2);
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000002');
select pg_temp.s3_assert(pg_temp.s3_page(p_limit=>1,p_cursor=>pg_temp.s3_get('editor-page')->>'next_cursor')->'items'='[]'::jsonb,'next page rechecks revoked ACL instead of trusting cursor');
select pg_temp.s3_assert(public.tr8_v2_list_unscheduled(array[pg_temp.s3_id('team')])->'items'='[]'::jsonb,'unscheduled immediately loses revoked project');
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000001');
select pg_temp.s3_put('reader',public.tr8_v2_remove_member(pg_temp.s3_id('team'),pg_temp.s3_id('reader'),(pg_temp.s3_get('reader')->>'version')::int));
select pg_temp.s3_actor('f3000000-0000-4000-8000-000000000003');
select pg_temp.s3_error('select pg_temp.s3_page()',array['PT404'],'removed member loses calendar on same JWT');
reset role;

-- Existing rows are untouched by isolated fixtures and no invitation is opened.
do $$
begin
  perform pg_temp.s3_assert((select payload from tr8_s3_existing where entity='projects')=(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb) from public.tr8_workspace_projects p where p.id in(select (x->>'id')::uuid from tr8_s3_existing e,jsonb_array_elements(e.payload) x where e.entity='projects')),'all preexisting projects preserved exactly');
  perform pg_temp.s3_assert((select payload from tr8_s3_existing where entity='tasks')=(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.tr8_workspace_tasks t where t.id in(select (x->>'id')::uuid from tr8_s3_existing e,jsonb_array_elements(e.payload) x where e.entity='tasks')),'all preexisting tasks preserved exactly');
  perform pg_temp.s3_assert((select payload from tr8_s3_existing where entity='users')=(select coalesce(jsonb_agg(to_jsonb(a) order by user_id),'[]'::jsonb) from tr8_private.app_users a where a.user_id in(select (x->>'user_id')::uuid from tr8_s3_existing e,jsonb_array_elements(e.payload) x where e.entity='users')),'all preexisting profiles preserved exactly');
  perform pg_temp.s3_assert((select not external_invites_enabled from tr8_private.app_config where singleton),'external onboarding remains disabled after every operation');
end; $$;
select jsonb_build_object('suite','calendar_stage3','passed',current_setting('tr8.stage3_test_count')::integer,'transaction','rollback');
rollback;
