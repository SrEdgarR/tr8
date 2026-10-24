-- Synthetic TEST only; no OAuth, Google HTTP, credentials or actual user rows.
begin;
select set_config('tr8.stage6b_assertions','0',true);
create temporary table s6b_before on commit drop as select
  (select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.tr8_workspace_tasks t) tasks,
  (select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb) from public.tr8_workspace_projects p) projects,
  (select to_jsonb(c) from tr8_private.app_config c where singleton) config;
create function pg_temp.b_assert(p_ok boolean,p_label text) returns void language plpgsql set search_path='' as $$begin
  if p_ok is distinct from true then raise exception 'Stage 6b assertion failed: %',p_label;end if;
  perform set_config('tr8.stage6b_assertions',(current_setting('tr8.stage6b_assertions')::integer+1)::text,true);
end;$$;
create function pg_temp.b_error(p_sql text,p_state text,p_label text) returns void language plpgsql set search_path='' as $$begin
  begin execute p_sql;exception when others then
    if sqlstate=p_state then perform pg_temp.b_assert(true,p_label);return;end if;
    raise exception 'Stage 6b expected %, got % (%) for %',p_state,sqlstate,sqlerrm,p_label;
  end;raise exception 'Stage 6b unexpectedly allowed %',p_label;
end;$$;
create function pg_temp.b_call(p_action text,p_payload jsonb default '{}') returns jsonb language sql set search_path='' as $$
  select public.tr8_server_google(p_action,'f6b00000-0000-4000-8000-000000000001','f6b10000-0000-4000-8000-000000000001',p_payload);
$$;
create function pg_temp.b_config(p_enabled boolean,p_list text default null) returns jsonb language sql set search_path='' as $$
  select pg_temp.b_call('tasks_configure_export',jsonb_build_object('request_id',gen_random_uuid(),'expected_version',
    (pg_temp.b_call('tasks_status')->>'version')::integer,'export_enabled',p_enabled,'export_list_id',p_list));
$$;
create function pg_temp.b_take(p_kind text,p_link uuid default null) returns jsonb language plpgsql set search_path='' as $$
declare v_job uuid;v_result jsonb;
begin
  select id into v_job from tr8_private.google_tasks_jobs where connection_id=(select id from tr8_private.google_connections where user_id='f6b00000-0000-4000-8000-000000000001')
    and kind=p_kind and (p_link is null or link_id=p_link) and state in ('pending','retry','leased') order by available_at,id limit 1;
  perform pg_temp.b_assert(v_job is not null,'expected synthetic job '||p_kind);
  update tr8_private.google_tasks_jobs set available_at=clock_timestamp()+interval '1 year' where id<>v_job and state in ('pending','retry');
  update tr8_private.google_tasks_jobs set available_at=clock_timestamp()-interval '1 second' where id=v_job;
  update tr8_private.google_jobs set available_at=clock_timestamp()+interval '1 year' where state in ('pending','retry');
  v_result:=pg_temp.b_call('tasks_claim','{"limit":1}');
  perform pg_temp.b_assert(jsonb_array_length(v_result)=1 and v_result->0->>'kind'=p_kind,'claimed synthetic job '||p_kind);
  return v_result->0;
end;$$;
create function pg_temp.b_new(p_workspace uuid,p_project uuid,p_title text) returns uuid language plpgsql set search_path='' as $$
declare v_id uuid:=gen_random_uuid();begin
  perform public.tr8_v2_create_task(p_workspace,v_id,p_project,p_title,'PRIVATE NEVER EXPORTED','todo','none',null,null);
  return v_id;
end;$$;
create function pg_temp.b_begin(p_link uuid) returns jsonb language plpgsql set search_path='' as $$
declare v_job jsonb;v_begin jsonb;begin
  v_job:=pg_temp.b_take('create',p_link);
  perform pg_temp.b_assert(pg_temp.b_call('tasks_reserve_request',v_job||'{"purpose":"tasks_insert"}')->>'allowed'='true','insert reserves shared budget');
  v_begin:=pg_temp.b_call('tasks_begin_create',v_job);
  perform pg_temp.b_assert(v_begin->>'allowed'='true','creation crosses durable uncertain fence');
  return v_job||v_begin;
end;$$;
create function pg_temp.b_remote(p_id text,p_title text,p_marker text) returns jsonb language sql set search_path='' as $$
  select jsonb_build_object('id',p_id,'etag','etag-'||p_id,'title',p_title,'completed',false,'start_date',null,'deleted',false,'assigned',false,'creation_marker',p_marker);
$$;

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  select ('f6b00000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','tr8-stage6b-'||n||'@example.test',clock_timestamp(),'{}','{}',clock_timestamp(),clock_timestamp() from generate_series(1,2)n;
insert into tr8_private.app_users(user_id,enabled,display_name)
  select ('f6b00000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,true,'Synthetic outbound '||n from generate_series(1,2)n;
insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
  values('f6b10000-0000-4000-8000-000000000001','f6b00000-0000-4000-8000-000000000001',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 day');
select set_config('request.jwt.claim.sub','f6b00000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"f6b00000-0000-4000-8000-000000000001","role":"authenticated","session_id":"f6b10000-0000-4000-8000-000000000001"}',true);

do $$
declare v_user uuid:='f6b00000-0000-4000-8000-000000000001';v_other uuid:='f6b00000-0000-4000-8000-000000000002';
  v_workspace uuid;v_project uuid:=gen_random_uuid();v_connection uuid;v_old uuid;v_task uuid;v_link uuid;v_job jsonb;v_begin jsonb;v_remote jsonb;v_result jsonb;
  v_marker text;v_title text;v_unchanged jsonb;v_count bigint;v_lease uuid;v_team uuid;v_team_project uuid;v_member uuid;v_owner_member uuid;v_role uuid;f record;
begin
  perform pg_temp.b_assert((select not external_invites_enabled from tr8_private.app_config where singleton),'signup remains disabled');
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='tr8_private' and p.proname like 'v7_%' loop
    perform pg_temp.b_assert(not has_function_privilege('anon',f.signature,'EXECUTE'),'anonymous helper denied');
    perform pg_temp.b_assert(not has_function_privilege('authenticated',f.signature,'EXECUTE'),'client helper denied');
    perform pg_temp.b_assert(not has_function_privilege('service_role',f.signature,'EXECUTE'),'server cannot bypass dispatcher');
  end loop;
  v_workspace:=(public.tr8_v2_get_context()->>'personal_workspace_id')::uuid;
  perform public.tr8_v2_create_project(v_workspace,v_project,'Synthetic outbound project','','#5A67D8','active');
  v_old:=pg_temp.b_new(v_workspace,v_project,'Existing local task');
  select to_jsonb(t) into v_unchanged from public.tr8_workspace_tasks t where id=v_old;
  insert into tr8_private.google_connections(user_id,generation,state,calendar_id,credential_envelope,tasks_granted)
    values(v_user,1,'connected','synthetic-outbound@group.calendar.google.com','{"v":1,"kid":"synthetic","iv":"AAAAAAAAAAAAAAAA","ciphertext":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}',true) returning id into v_connection;
  insert into tr8_private.google_tasks_sync(connection_id,generation,enabled,version) values(v_connection,1,true,1);
  insert into tr8_private.google_tasks_lists(connection_id,generation,list_id,title,selected) values(v_connection,1,'list-one','Synthetic destination',true);
  update tr8_private.google_config set configured=true,scheduler_enabled=false,used_today=0,used_month=0 where singleton;
  perform pg_temp.b_assert(pg_temp.b_call('tasks_status')#>>'{outbound,enabled}'='false','export opt-in defaults off');
  perform pg_temp.b_assert(not exists(select 1 from tr8_private.google_tasks_links where local_task_id=v_old),'original task never backfilled');
  v_result:=pg_temp.b_config(true);
  perform pg_temp.b_assert(v_result#>>'{outbound,enabled}'='true' and v_result#>>'{outbound,list_id}'='list-one','single selected list is safe explicit opt-in destination');
  perform pg_temp.b_assert(not exists(select 1 from tr8_private.google_tasks_links where local_task_id=v_old),'activation never backfills');
  v_task:=pg_temp.b_new(v_workspace,v_project,'Future TR8 task');
  select id,creation_marker into strict v_link,v_marker from tr8_private.google_tasks_links where local_task_id=v_task and connection_id=v_connection;
  perform pg_temp.b_assert((select origin='tr8' and remote_task_id is null and creation_state='ready' from tr8_private.google_tasks_links where id=v_link),'stable link and opaque marker exist before POST');
  perform pg_temp.b_assert(not tr8_private.v5_task_eligible(v_connection,v_task),'new task excluded from Calendar before any POST');
  perform pg_temp.b_assert((select count(*)=1 from tr8_private.google_tasks_jobs where link_id=v_link and kind='create'),'one durable create intent');
  v_begin:=pg_temp.b_begin(v_link);v_job:=v_begin;
  perform pg_temp.b_assert(((v_begin->'projection')-array['title','completed','start_date'])='{}'::jsonb,'no private description or project is exported');
  perform pg_temp.b_assert(pg_temp.b_call('tasks_begin_create',v_job)->>'allowed'='false','second begin cannot repeat POST');
  v_remote:=pg_temp.b_remote('remote-created','Future TR8 task',v_marker);
  perform pg_temp.b_assert(pg_temp.b_call('tasks_bind_create',v_job||jsonb_build_object('remote',v_remote))->>'applied'='true','POST receipt binds exact identity');
  perform pg_temp.b_assert((select state='synced' and remote_task_id='remote-created' and creation_state='bound' from tr8_private.google_tasks_links where id=v_link),'created task synchronizes existing identity');
  perform pg_temp.b_assert(pg_temp.b_call('tasks_finish',v_job||'{"outcome":"succeeded"}')='true','known create finishes');
  perform pg_temp.b_assert((select count(*)=1 from public.tr8_workspace_tasks where id=v_task),'receipt does not import duplicate');
  select count(*) into v_count from public.tr8_workspace_tasks;
  perform tr8_private.v6_observe(v_connection,'list-one',v_remote||'{"title":"Edited in Google","completed":true}');
  perform pg_temp.b_assert((select title='Edited in Google' and status='done' and description='PRIVATE NEVER EXPORTED' from public.tr8_workspace_tasks where id=v_task),'Google edits and completion return to original TR8 task preserving description');
  perform pg_temp.b_assert((select count(*)=v_count from public.tr8_workspace_tasks),'inbound echo creates no duplicate');

  -- Bound acknowledgement with a lost finish is safe to claim again without POST.
  update tr8_private.google_tasks_jobs set state='pending',available_at=clock_timestamp(),finished_at=null where link_id=v_link and kind='create';
  v_job:=pg_temp.b_take('create',v_link);
  perform pg_temp.b_assert(pg_temp.b_call('tasks_prepare',v_job)->>'create_state'='bound','bound create resumes as known identity');
  perform pg_temp.b_assert(pg_temp.b_call('tasks_finish',v_job||'{"outcome":"succeeded"}')='true','bound create safely finishes without HTTP');

  -- A regular local deletion after binding must preserve a simultaneous
  -- remote edit as conflict. It is not access-loss/in-flight-create cleanup.
  v_task:=pg_temp.b_new(v_workspace,v_project,'Bound local delete conflict');
  select id,creation_marker into v_link,v_marker from tr8_private.google_tasks_links where local_task_id=v_task;
  v_begin:=pg_temp.b_begin(v_link);v_remote:=pg_temp.b_remote('remote-delete-conflict','Bound local delete conflict',v_marker);
  perform pg_temp.b_call('tasks_bind_create',v_begin||jsonb_build_object('remote',v_remote));
  perform pg_temp.b_call('tasks_finish',v_begin||'{"outcome":"succeeded"}');
  delete from public.tr8_workspace_tasks where id=v_task;
  v_result:=tr8_private.v6_observe(v_connection,'list-one',v_remote||'{"title":"Edited remotely after bind"}');
  perform pg_temp.b_assert(v_result->>'action'='conflict','bound local deletion conflicts with concurrent Google edit');
  perform pg_temp.b_assert((select not cleanup_requested and state='conflict' and remote_projection->>'title'='Edited remotely after bind'
    from tr8_private.google_tasks_links where id=v_link),'regular deletion preserves remote version rather than forcing cleanup');
  perform pg_temp.b_assert(not exists(select 1 from public.tr8_workspace_tasks where id=v_task),'conflict does not recreate deleted local task');

  -- A changed local snapshot during POST remains dirty and patches exact ID.
  v_task:=pg_temp.b_new(v_workspace,v_project,'Initial local snapshot');
  select id,creation_marker into v_link,v_marker from tr8_private.google_tasks_links where local_task_id=v_task;
  v_begin:=pg_temp.b_begin(v_link);update public.tr8_workspace_tasks set title='Edited during HTTP' where id=v_task;
  v_remote:=pg_temp.b_remote('remote-race','Initial local snapshot',v_marker);
  perform pg_temp.b_call('tasks_bind_create',v_begin||jsonb_build_object('remote',v_remote));
  perform pg_temp.b_assert((select state='dirty' and remote_task_id='remote-race' from tr8_private.google_tasks_links where id=v_link),'local edit during POST remains dirty');
  perform pg_temp.b_assert((select title='Edited during HTTP' from public.tr8_workspace_tasks where id=v_task),'POST receipt never overwrites newer local edit');
  perform pg_temp.b_call('tasks_finish',v_begin||'{"outcome":"succeeded"}');

  -- Lost acknowledgement: scan all pages and bind marker rather than POST again.
  v_task:=pg_temp.b_new(v_workspace,v_project,'Recover me');
  select id,creation_marker into v_link,v_marker from tr8_private.google_tasks_links where local_task_id=v_task;
  v_begin:=pg_temp.b_begin(v_link);
  perform pg_temp.b_call('tasks_finish',v_begin||'{"outcome":"retry"}');
  v_job:=pg_temp.b_take('create',v_link);
  perform pg_temp.b_assert(pg_temp.b_call('tasks_prepare',v_job)->>'create_state'='uncertain','expired/lost POST enters recovery, never ready');
  perform pg_temp.b_error(format('select pg_temp.b_call(''tasks_reserve_request'',%L::jsonb)',v_job||'{"purpose":"tasks_insert"}'),'22023','uncertain POST cannot reserve another insert');
  v_result:=pg_temp.b_call('tasks_recover_create_page',v_job||jsonb_build_object('page_token',null,'items','[]'::jsonb,'next_page_token','RECOVERY-2'));
  perform pg_temp.b_assert(v_result->>'more'='true' and (select creation_state='uncertain' from tr8_private.google_tasks_links where id=v_link),'empty first page does not imply failed creation');
  perform pg_temp.b_call('tasks_finish',v_job||'{"outcome":"succeeded"}');v_job:=pg_temp.b_take('create',v_link);
  perform pg_temp.b_assert(pg_temp.b_call('tasks_prepare',v_job)->>'page_token'='RECOVERY-2','recovery cursor survives worker invocation');
  v_remote:=pg_temp.b_remote('remote-recovered','Changed on phone before recovery',v_marker);
  v_result:=pg_temp.b_call('tasks_recover_create_page',v_job||jsonb_build_object('page_token','RECOVERY-2','items',jsonb_build_array(v_remote),'next_page_token',null));
  perform pg_temp.b_assert(v_result->>'applied'='true' and v_result->>'more'='false','unique marker binds only after final page');
  perform pg_temp.b_assert((select title='Changed on phone before recovery' from public.tr8_workspace_tasks where id=v_task),'recovery imports remote edit using creation snapshot as base');
  perform pg_temp.b_call('tasks_finish',v_job||'{"outcome":"succeeded"}');

  -- Normal pull can win the race with POST acknowledgement without importing.
  v_task:=pg_temp.b_new(v_workspace,v_project,'Concurrent pull target');
  select id,creation_marker into v_link,v_marker from tr8_private.google_tasks_links where local_task_id=v_task;
  v_begin:=pg_temp.b_begin(v_link);select count(*) into v_count from public.tr8_workspace_tasks;
  v_remote:=pg_temp.b_remote('remote-pull-first','Concurrent pull target',v_marker);
  perform tr8_private.v6_observe(v_connection,'list-one',v_remote);
  perform pg_temp.b_assert((select count(*)=v_count from public.tr8_workspace_tasks),'marker quarantines pull before import can duplicate');
  perform pg_temp.b_assert((select remote_task_id is null and creation_state='uncertain' from tr8_private.google_tasks_links where id=v_link),'ordinary pull cannot bind marker before complete recovery');
  perform pg_temp.b_assert(pg_temp.b_call('tasks_bind_create',v_begin||jsonb_build_object('remote',v_remote))->>'applied'='true','same ID receipt replay is idempotent after pull wins');
  perform pg_temp.b_call('tasks_finish',v_begin||'{"outcome":"succeeded"}');

  -- Uncertain absence and duplicate markers stop; they never trigger new POST.
  v_task:=pg_temp.b_new(v_workspace,v_project,'Absent uncertain target');
  select id into v_link from tr8_private.google_tasks_links where local_task_id=v_task;
  v_begin:=pg_temp.b_begin(v_link);
  perform pg_temp.b_call('tasks_recover_create_page',v_begin||'{"page_token":null,"items":[],"next_page_token":null}');
  perform pg_temp.b_assert((select creation_state='blocked' and conflict_reason='creation_uncertain' and remote_task_id is null from tr8_private.google_tasks_links where id=v_link),'zero marker match blocks instead of blindly rePOSTing');
  perform pg_temp.b_error(format('select pg_temp.b_call(''tasks_resolve'',%L::jsonb)',jsonb_build_object('request_id',gen_random_uuid(),'expected_version',(pg_temp.b_call('tasks_status')->>'version')::integer,'link_id',v_link,'resolution','local')),'PT409','ordinary conflict resolution cannot recreate uncertain intent');
  perform pg_temp.b_call('tasks_finish',v_begin||'{"outcome":"succeeded"}');
  v_task:=pg_temp.b_new(v_workspace,v_project,'Duplicate marker target');
  select id,creation_marker into v_link,v_marker from tr8_private.google_tasks_links where local_task_id=v_task;
  v_begin:=pg_temp.b_begin(v_link);
  perform pg_temp.b_call('tasks_recover_create_page',v_begin||jsonb_build_object('page_token',null,'items',jsonb_build_array(pg_temp.b_remote('duplicate-a','Duplicate marker target',v_marker),pg_temp.b_remote('duplicate-b','Duplicate marker target',v_marker)),'next_page_token',null));
  perform pg_temp.b_assert((select creation_state='blocked' and conflict_reason='creation_duplicate' from tr8_private.google_tasks_links where id=v_link),'multiple marker matches quarantine identity');
  perform tr8_private.v6_observe(v_connection,'list-one',pg_temp.b_remote('duplicate-a','Duplicate marker target',v_marker));
  perform pg_temp.b_assert((select creation_state='blocked' and conflict_reason='creation_duplicate' from tr8_private.google_tasks_links where id=v_link),'later pull cannot clear duplicate marker quarantine');
  perform pg_temp.b_call('tasks_finish',v_begin||'{"outcome":"succeeded"}');

  -- Delete after the HTTP boundary recovers ID and cleans exact remote only.
  v_task:=pg_temp.b_new(v_workspace,v_project,'Deleted during POST');
  select id,creation_marker into v_link,v_marker from tr8_private.google_tasks_links where local_task_id=v_task;
  v_begin:=pg_temp.b_begin(v_link);delete from public.tr8_workspace_tasks where id=v_task;
  perform pg_temp.b_assert(pg_temp.b_call('tasks_prepare',v_begin)->>'valid'='true','uncertain create survives local deletion for recovery');
  perform pg_temp.b_call('tasks_bind_create',v_begin||jsonb_build_object('remote',pg_temp.b_remote('remote-cleanup','Deleted during POST',v_marker)));
  perform pg_temp.b_assert((select state='deleting' and cleanup_requested and remote_task_id='remote-cleanup' from tr8_private.google_tasks_links where id=v_link),'late POST ID is attached for exact cleanup');
  perform pg_temp.b_assert(not exists(select 1 from public.tr8_workspace_tasks where id=v_task),'late receipt never resurrects deleted local task');
  perform pg_temp.b_assert(exists(select 1 from tr8_private.google_tasks_jobs where link_id=v_link and kind='delete'),'cleanup job carries bound identity');
  perform pg_temp.b_call('tasks_finish',v_begin||'{"outcome":"succeeded"}');

  -- Disabling export only stops new enrollment; existing links stay synced.
  perform pg_temp.b_config(false,'list-one');v_task:=pg_temp.b_new(v_workspace,v_project,'Export disabled task');
  perform pg_temp.b_assert(not exists(select 1 from tr8_private.google_tasks_links where local_task_id=v_task),'disabled opt-in creates no new intent');
  insert into tr8_private.google_tasks_lists(connection_id,generation,list_id,title,selected) values(v_connection,1,'list-two','Second selected list',true);
  perform pg_temp.b_error('select pg_temp.b_config(true)','PT409','multiple selected lists require explicit destination');
  perform pg_temp.b_config(true,'list-two');
  v_task:=pg_temp.b_new(v_workspace,v_project,'New destination task');
  perform pg_temp.b_assert((select list_id='list-two' from tr8_private.google_tasks_links where local_task_id=v_task),'new destination applies only to future task');
  perform pg_temp.b_assert((select to_jsonb(t)=v_unchanged from public.tr8_workspace_tasks t where id=v_old),'historical task exactly unchanged');

  -- UI creates a team task and assigns it with a separate RPC. That later
  -- assignment enrolls only tasks created since this user's explicit opt-in.
  insert into tr8_private.workspaces(kind,owner_id,name) values('team',v_other,'Synthetic assigned team') returning id into v_team;
  insert into tr8_private.workspace_authz_state(workspace_id) values(v_team);
  insert into tr8_private.workspace_members(workspace_id,user_id) values(v_team,v_other) returning id into v_owner_member;
  insert into tr8_private.workspace_members(workspace_id,user_id) values(v_team,v_user) returning id into v_member;
  insert into tr8_private.workspace_roles(workspace_id,name) values(v_team,'Synthetic editor') returning id into v_role;
  insert into tr8_private.role_permissions(workspace_id,role_id,permission)
    select v_team,v_role,unnest(array['project.read','task.read','task.create','task.edit','task.assign']);
  insert into tr8_private.member_roles(workspace_id,member_id,role_id) values(v_team,v_member,v_role);
  v_team_project:=gen_random_uuid();
  insert into public.tr8_workspace_projects(id,workspace_id,owner_id,name,description,color,status)
    values(v_team_project,v_team,v_other,'Synthetic team project','','#5A67D8','active');
  insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level) values(v_team,v_team_project,v_member,'write');
  v_task:=pg_temp.b_new(v_team,v_team_project,'Team task assigned after creation');
  perform pg_temp.b_assert(not exists(select 1 from tr8_private.google_tasks_links where local_task_id=v_task),'unassigned team task is not exported');
  perform public.tr8_v2_assign_task(v_team,v_task,(select version from public.tr8_workspace_tasks where id=v_task),v_member);
  select id,creation_marker into strict v_link,v_marker from tr8_private.google_tasks_links where local_task_id=v_task;
  perform pg_temp.b_assert(tr8_private.v7_task_eligible(v_connection,v_task,(select created_at from public.tr8_workspace_tasks where id=v_task)),'separate assignment RPC enrolls new readable assigned task');
  v_begin:=pg_temp.b_begin(v_link);v_remote:=pg_temp.b_remote('team-created','Team task assigned after creation',v_marker);
  perform pg_temp.b_call('tasks_bind_create',v_begin||jsonb_build_object('remote',v_remote));perform pg_temp.b_call('tasks_finish',v_begin||'{"outcome":"succeeded"}');
  perform tr8_private.v6_observe(v_connection,'list-two',v_remote||'{"title":"Team changed in Google"}');
  perform pg_temp.b_assert((select title='Team changed in Google' from public.tr8_workspace_tasks where id=v_task),'team inbound edit requires and obeys live task.edit and project write');
  delete from tr8_private.role_permissions where workspace_id=v_team and role_id=v_role and permission='task.edit';
  perform tr8_private.v6_observe(v_connection,'list-two',v_remote||'{"title":"Unauthorized Google edit"}');
  perform pg_temp.b_assert((select title='Team changed in Google' from public.tr8_workspace_tasks where id=v_task),'Google edit cannot bypass revoked team task.edit permission');
  perform pg_temp.b_assert((select state='retained' and conflict_reason='permission_changed' from tr8_private.google_tasks_links where id=v_link),'revoked edit permission retains local domain data');
  -- Reset only the synthetic link to isolate the independent delete guard.
  insert into tr8_private.role_permissions(workspace_id,role_id,permission) values(v_team,v_role,'task.edit');
  update tr8_private.google_tasks_links set state='synced' where id=v_link;
  perform tr8_private.v6_observe(v_connection,'list-two',jsonb_build_object('id','team-created','deleted',true));
  perform pg_temp.b_assert(exists(select 1 from public.tr8_workspace_tasks where id=v_task),'Google deletion cannot bypass missing team task.delete permission');
  perform pg_temp.b_assert((select state='retained' and conflict_reason='permission_changed' from tr8_private.google_tasks_links where id=v_link),'unauthorized team deletion retains domain row');

  -- Execute the real scheduler branch with an eligible linked task. Calling
  -- queue_due only persists queue work; it never calls wake_worker/net.http.
  perform pg_temp.b_assert(exists(select 1 from tr8_private.google_tasks_links l where l.connection_id=v_connection
    and l.remote_task_id='remote-created' and tr8_private.v7_task_eligible(v_connection,l.local_task_id,l.local_task_created_at)),
    'scheduler regression fixture has an eligible bound outbound task');
  update tr8_private.google_config set configured=true,scheduler_enabled=true where singleton;
  update tr8_private.google_tasks_sync set next_pull_at=null where connection_id=v_connection;
  perform tr8_private.v6_queue_due();
  perform pg_temp.b_assert((select next_pull_at>clock_timestamp() from tr8_private.google_tasks_sync where connection_id=v_connection),
    'enabled scheduler executes discovery and cleanup query without ambiguous record aliases');
  perform pg_temp.b_assert((select state='synced' and not cleanup_requested from tr8_private.google_tasks_links
    where connection_id=v_connection and remote_task_id='remote-created'),'scheduler preserves eligible bound task and its Google identity');
  update tr8_private.google_config set scheduler_enabled=false where singleton;
end;$$;

do $$begin
  perform pg_temp.b_assert(not exists(select 1 from jsonb_array_elements((select tasks from pg_temp.s6b_before)) x
    left join public.tr8_workspace_tasks t on t.id=(x->>'id')::uuid where to_jsonb(t) is distinct from x),'all preexisting TEST tasks exactly unchanged');
  perform pg_temp.b_assert(not exists(select 1 from jsonb_array_elements((select projects from pg_temp.s6b_before)) x
    left join public.tr8_workspace_projects p on p.id=(x->>'id')::uuid where to_jsonb(p) is distinct from x),'all preexisting TEST projects exactly unchanged');
  perform pg_temp.b_assert((select to_jsonb(c)=(select config from pg_temp.s6b_before) from tr8_private.app_config c where singleton),'app signup and plan configuration unchanged');
end;$$;
select current_setting('tr8.stage6b_assertions')::integer as stage6b_assertions;
rollback;
