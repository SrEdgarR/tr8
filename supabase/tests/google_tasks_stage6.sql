-- Disposable TEST only. Synthetic provider receipts, no HTTP or OAuth tokens.
-- Fixtures roll back; task identity sequences are never rewound.
begin;
select set_config('tr8.stage6_assertions','0',true);
create temporary table s6_values(key text primary key,value jsonb) on commit drop;
create temporary table s6_before on commit drop as select
  (select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb) from public.tr8_workspace_projects p) projects,
  (select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.tr8_workspace_tasks t) tasks,
  (select to_jsonb(c) from tr8_private.app_config c where singleton) config;
create function pg_temp.s6_assert(p_ok boolean,p_label text) returns void language plpgsql security invoker set search_path='' as $$begin
  if p_ok is distinct from true then raise exception 'Stage 6 assertion failed: %',p_label;end if;
  perform set_config('tr8.stage6_assertions',(current_setting('tr8.stage6_assertions')::integer+1)::text,true);
end;$$;
create function pg_temp.s6_error(p_sql text,p_states text[],p_label text) returns void language plpgsql security invoker set search_path='' as $$begin
  begin execute p_sql;exception when others then
    if sqlstate=any(p_states) then perform pg_temp.s6_assert(true,p_label);return;end if;
    raise exception 'Stage 6 assertion failed: % expected %, got % (%)',p_label,p_states,sqlstate,sqlerrm;
  end;raise exception 'Stage 6 assertion failed: % unexpectedly succeeded',p_label;
end;$$;
create function pg_temp.s6_call(p_action text,p_payload jsonb default '{}') returns jsonb language sql security invoker set search_path='' as $$
  select public.tr8_server_google(p_action,'f6000000-0000-4000-8000-000000000001','f6100000-0000-4000-8000-000000000001',p_payload);
$$;
create function pg_temp.s6_request(p_action text,p_extra jsonb default '{}') returns jsonb language sql security invoker set search_path='' as $$
  select pg_temp.s6_call(p_action,jsonb_build_object('request_id',gen_random_uuid(),'expected_version',(pg_temp.s6_call('tasks_status')->>'version')::integer)||p_extra);
$$;
create function pg_temp.s6_take(p_kind text,p_link uuid default null) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_job uuid;v_result jsonb;
begin
  select id into v_job from tr8_private.google_tasks_jobs where connection_id=(select id from tr8_private.google_connections where user_id='f6000000-0000-4000-8000-000000000001')
    and kind=p_kind and (p_link is null or link_id=p_link) and state in ('pending','retry','leased') order by available_at,id limit 1;
  perform pg_temp.s6_assert(v_job is not null,'expected synthetic Tasks job: '||p_kind);
  update tr8_private.google_tasks_jobs set available_at=clock_timestamp()+interval '1 year' where id<>v_job and state in ('pending','retry');
  update tr8_private.google_tasks_jobs set available_at=clock_timestamp()-interval '1 second' where id=v_job;
  update tr8_private.google_jobs set available_at=clock_timestamp()+interval '1 year' where state in ('pending','retry');
  v_result:=pg_temp.s6_call('tasks_claim','{"limit":1}');
  perform pg_temp.s6_assert(jsonb_array_length(v_result)=1 and v_result->0->>'kind'=p_kind,'worker claims synthetic Tasks job: '||p_kind);
  return v_result->0;
end;$$;

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  select ('f6000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','tr8-stage6-'||n||'@example.test',clock_timestamp(),'{}','{}',clock_timestamp(),clock_timestamp() from generate_series(1,2)n;
insert into tr8_private.app_users(user_id,enabled,display_name)
  select ('f6000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,true,'Synthetic Tasks '||n from generate_series(1,2)n;
insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
  select ('f6100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('f6000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 day' from generate_series(1,2)n;
select set_config('request.jwt.claim.sub','f6000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"f6000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"f6100000-0000-4000-8000-000000000001"}',true);

do $$
declare v_user uuid:='f6000000-0000-4000-8000-000000000001';v_workspace uuid;v_project uuid:='a6000000-0000-4000-8000-000000000001';
  v_original uuid:='e6000000-0000-4000-8000-000000000001';v_connection uuid;v_before_original jsonb;v_project_count bigint;
  v_cipher jsonb:='{"v":1,"kid":"synthetic","iv":"AAAAAAAAAAAAAAAA","ciphertext":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}';
  v_new_cipher jsonb:='{"v":1,"kid":"synthetic","iv":"AAAAAAAAAAAAAAAA","ciphertext":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"}';
  v_begin jsonb;v_attempt jsonb;v_input jsonb;v_job jsonb;v_result jsonb;v_remote jsonb;v_remote_a jsonb;v_prepared jsonb;v_token uuid;
  v_link uuid;v_task uuid;v_link2 uuid;v_task2 uuid;v_link3 uuid;v_task3 uuid;v_local_version integer;v_hash text;v_revision bigint;v_old_job uuid;v_budget integer;t text;f record;
begin
  perform pg_temp.s6_assert((select not external_invites_enabled from tr8_private.app_config where singleton),'external signup stays disabled');
  perform pg_temp.s6_assert(not exists(select 1 from tr8_private.google_connections where tasks_granted),'migration enabled no Tasks grant');
  perform pg_temp.s6_assert(not exists(select 1 from tr8_private.google_tasks_sync),'migration did not create Tasks state');
  foreach t in array array['google_tasks_sync','google_tasks_lists','google_tasks_links','google_tasks_jobs'] loop
    perform pg_temp.s6_assert((select relrowsecurity from pg_class where oid=('tr8_private.'||t)::regclass),'RLS enabled '||t);
    perform pg_temp.s6_assert(not has_table_privilege('anon','tr8_private.'||t,'SELECT,INSERT,UPDATE,DELETE'),'anonymous direct DML denied '||t);
    perform pg_temp.s6_assert(not has_table_privilege('authenticated','tr8_private.'||t,'SELECT,INSERT,UPDATE,DELETE'),'client direct DML denied '||t);
    perform pg_temp.s6_assert(not has_table_privilege('service_role','tr8_private.'||t,'SELECT,INSERT,UPDATE,DELETE'),'service direct DML denied '||t);
  end loop;
  for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='tr8_private' and p.proname like 'v6_%' loop
    perform pg_temp.s6_assert(not has_function_privilege('anon',f.signature,'EXECUTE'),'anonymous helper denied '||f.proname);
    if f.proname<>'v6_get_status' then perform pg_temp.s6_assert(not has_function_privilege('authenticated',f.signature,'EXECUTE'),'client helper denied '||f.proname);end if;
    if f.proname<>'v6_server' then perform pg_temp.s6_assert(not has_function_privilege('service_role',f.signature,'EXECUTE'),'service helper denied '||f.proname);end if;
  end loop;
  perform pg_temp.s6_assert(not has_function_privilege('authenticated','public.tr8_server_google(text,uuid,uuid,jsonb)','EXECUTE'),'client cannot call shared dispatcher');
  perform pg_temp.s6_assert(has_function_privilege('service_role','public.tr8_server_google(text,uuid,uuid,jsonb)','EXECUTE'),'server can call shared dispatcher');
  perform pg_temp.s6_assert(not has_function_privilege('anon','public.tr8_v6_get_google_tasks_status()','EXECUTE'),'anonymous status denied');
  perform pg_temp.s6_assert((select not prosecdef from pg_proc where oid='public.tr8_v6_get_google_tasks_status()'::regprocedure),'public Tasks status is invoker');
  perform pg_temp.s6_assert(pg_temp.s6_call('tasks_status')->>'state'='disconnected','own status is safe before a Google connection exists');
end;$$;

-- The body below exercises the worker contract with committed-shape synthetic
-- receipts. No network is called; all durable changes are rolled back.
do $$
declare v_user uuid:='f6000000-0000-4000-8000-000000000001';v_workspace uuid;v_project uuid:='a6000000-0000-4000-8000-000000000001';
  v_original uuid:='e6000000-0000-4000-8000-000000000001';v_connection uuid;v_before_original jsonb;v_project_count bigint;
  v_cipher jsonb:='{"v":1,"kid":"synthetic","iv":"AAAAAAAAAAAAAAAA","ciphertext":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}';
  v_new_cipher jsonb:='{"v":1,"kid":"synthetic","iv":"AAAAAAAAAAAAAAAA","ciphertext":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"}';
  v_begin jsonb;v_attempt jsonb;v_input jsonb;v_job jsonb;v_result jsonb;v_remote jsonb;v_remote_a jsonb;v_prepared jsonb;v_token uuid;
  v_link uuid;v_task uuid;v_link2 uuid;v_task2 uuid;v_link3 uuid;v_task3 uuid;v_local_version integer;v_hash text;v_revision bigint;v_old_job uuid;v_budget integer;
begin
  v_workspace:=(public.tr8_v2_get_context()->>'personal_workspace_id')::uuid;
  perform public.tr8_v2_create_project(v_workspace,v_project,'Preexisting synthetic project','Preserve this project','#5A67D8','active');
  perform public.tr8_v2_create_task(v_workspace,v_original,v_project,'Original synthetic task','Private description','progress','high',null,'2026-11-01');
  select to_jsonb(t) into v_before_original from public.tr8_workspace_tasks t where id=v_original;
  select count(*) into v_project_count from public.tr8_workspace_projects;
  insert into tr8_private.google_connections(user_id,generation,state,calendar_id,credential_envelope)
    values(v_user,1,'connected','synthetic-stage6@group.calendar.google.com',v_cipher) returning id into v_connection;
  update tr8_private.google_config set configured=true,scheduler_enabled=false,app_origins=array['https://tr8.vercel.app'] where singleton;
  perform pg_temp.s6_assert(pg_temp.s6_call('tasks_status')->>'state'='disconnected','Calendar grant alone is not Tasks authorization');
  perform pg_temp.s6_error('select pg_temp.s6_request(''tasks_reconcile'')',array['PT409'],'cannot enable Tasks without new grant');
  insert into tr8_private.google_jobs(connection_id,generation,kind,state,lease_token,lease_expires_at,attempts)
    values(v_connection,1,'reconcile_scan','leased',gen_random_uuid(),clock_timestamp()+interval '60 seconds',1) returning id into v_old_job;
  v_input:=jsonb_build_object('request_id',gen_random_uuid(),'expected_version',0,'tasks_requested',true,'state_hash',repeat('A',43),'browser_hash',repeat('B',43),'pkce_envelope',v_cipher,'app_origin','https://tr8.vercel.app');
  v_begin:=pg_temp.s6_call('begin',v_input);
  perform pg_temp.s6_assert(v_begin->>'tasks_requested'='true','new attempt returns Tasks capability');
  perform pg_temp.s6_assert(pg_temp.s6_call('begin',v_input)=v_begin,'capability request replays same OAuth attempt');
  perform pg_temp.s6_assert((select tasks_requested from tr8_private.google_oauth_attempts where id=(v_begin->>'attempt_id')::uuid),'capability stored in OAuth attempt');
  perform pg_temp.s6_assert((select state='pending' and lease_token is null from tr8_private.google_jobs where id=v_old_job),'OAuth upgrade fences old Calendar worker');
  perform pg_temp.s6_assert(not exists(select 1 from tr8_private.google_tasks_sync),'OAuth begin alone does not enable Tasks');
  perform pg_temp.s6_call('record_oauth_result',jsonb_build_object('state_hash',repeat('A',43),'result_hash',repeat('C',43),'result_envelope',v_cipher));
  v_attempt:=pg_temp.s6_call('consume_attempt',jsonb_build_object('state_hash',repeat('A',43),'browser_hash',repeat('B',43)));
  perform pg_temp.s6_assert(v_attempt->>'tasks_requested'='true','consumer requires the requested combined grant');
  perform pg_temp.s6_error(format('select pg_temp.s6_call(''complete_authorization'',%L::jsonb)',jsonb_build_object('attempt_id',v_attempt->>'attempt_id','credential_envelope',v_new_cipher,'keep_existing_calendar',true)),array['PT409'],'unverified Tasks permission cannot enable Tasks');
  perform pg_temp.s6_call('complete_authorization',jsonb_build_object('attempt_id',v_attempt->>'attempt_id','credential_envelope',v_new_cipher,'keep_existing_calendar',true,'tasks_granted',true));
  perform pg_temp.s6_assert((select tasks_granted and generation=1 and credential_envelope=v_new_cipher from tr8_private.google_connections where id=v_connection),'verified grant stored atomically without changing Calendar generation');
  perform pg_temp.s6_assert(pg_temp.s6_call('tasks_status')->>'state'='connected' and pg_temp.s6_call('tasks_status')->>'enabled'='true','verified Tasks grant is connected');
  perform pg_temp.s6_assert((select count(*)=v_project_count from public.tr8_workspace_projects),'OAuth never creates empty import project');
  v_job:=pg_temp.s6_take('discover');
  v_prepared:=pg_temp.s6_call('tasks_prepare',v_job);
  perform pg_temp.s6_assert(v_prepared->>'valid'='true' and v_prepared->'page_token'='null'::jsonb,'discovery prepares first durable page');
  v_result:=pg_temp.s6_call('tasks_apply_lists',v_job||jsonb_build_object('page_token',null,'next_page_token',null,'items',jsonb_build_array(jsonb_build_object('id','list-primary','title','My Tasks'),jsonb_build_object('id','list-secondary','title','Another list'))));
  perform pg_temp.s6_assert(v_result='{"applied":true,"more":false}','list discovery applies');
  perform pg_temp.s6_assert((select count(*)=1 from tr8_private.google_tasks_lists where connection_id=v_connection and selected),'only first list selected by default');
  perform pg_temp.s6_assert((pg_temp.s6_call('tasks_finish',v_job||'{"outcome":"succeeded"}')#>>'{}')::boolean,'discovery finishes with valid lease');
  v_job:=pg_temp.s6_take('pull');
  v_remote:=jsonb_build_object('id','remote-one','etag','etag-1','title','From Google','completed',false,'start_date','2026-11-02','deleted',false,'assigned',false);
  v_result:=pg_temp.s6_call('tasks_apply_page',v_job||jsonb_build_object('page_token',null,'next_page_token','PAGE-2','items',jsonb_build_array(v_remote,
    v_remote||'{"id":"remote-two","title":"Another Google task"}',v_remote||'{"id":"remote-assigned","assigned":true}',v_remote||jsonb_build_object('id','remote-long','title',repeat('X',501)))));
  perform pg_temp.s6_assert(v_result->>'imported'='2' and v_result->>'skipped'='2' and v_result->>'more'='true','page imports valid tasks and skips assignments and unsupported title');
  select id,local_task_id into strict v_link,v_task from tr8_private.google_tasks_links where connection_id=v_connection and remote_task_id='remote-one';
  select id,local_task_id into strict v_link2,v_task2 from tr8_private.google_tasks_links where connection_id=v_connection and remote_task_id='remote-two';
  perform pg_temp.s6_assert((select count(*)=v_project_count+1 from public.tr8_workspace_projects),'first valid item creates one dedicated project');
  perform pg_temp.s6_assert((select start_date='2026-11-02' and due_date is null and description='' from public.tr8_workspace_tasks where id=v_task),'Google planned date is start_date; notes and deadlines untouched');
  perform pg_temp.s6_assert(not tr8_private.v5_task_eligible(v_connection,v_task),'imported Google Task never exports Calendar duplicate');
  perform pg_temp.s6_assert(tr8_private.v5_task_eligible(v_connection,v_original),'ordinary TR8 task still eligible for Calendar');
  perform pg_temp.s6_assert(pg_temp.s6_call('tasks_apply_page',v_job||jsonb_build_object('page_token',null,'next_page_token','PAGE-2','items','[]'::jsonb))->>'applied'='false','stale page cannot overwrite advanced cursor');
  perform pg_temp.s6_call('tasks_finish',v_job||'{"outcome":"succeeded"}');
  v_job:=pg_temp.s6_take('pull');
  perform pg_temp.s6_assert(pg_temp.s6_call('tasks_prepare',v_job)->>'page_token'='PAGE-2','next claim resumes persisted page');
  v_result:=pg_temp.s6_call('tasks_apply_page',v_job||jsonb_build_object('page_token','PAGE-2','next_page_token',null,'items',jsonb_build_array(v_remote,v_remote||'{"id":"remote-three","title":"Completed Google task","completed":true}')));
  perform pg_temp.s6_assert(v_result->>'imported'='1' and v_result->>'updated'='0','repeated item is idempotent and next item imports');
  select id,local_task_id into strict v_link3,v_task3 from tr8_private.google_tasks_links where connection_id=v_connection and remote_task_id='remote-three';
  perform pg_temp.s6_assert((select status='done' from public.tr8_workspace_tasks where id=v_task3),'completed Google Task imports completed');
  perform pg_temp.s6_call('tasks_finish',v_job||'{"outcome":"succeeded"}');
  perform pg_temp.s6_assert((select count(*)=3 from tr8_private.google_tasks_links where connection_id=v_connection),'one stable mapping for each Google identity');
  perform pg_temp.s6_assert(not exists(select 1 from tr8_private.google_tasks_jobs where connection_id=v_connection and kind in ('patch','delete')),'incoming known projection produces no export echo');
  select revision into v_revision from tr8_private.google_tasks_links where id=v_link;
  update public.tr8_workspace_tasks set description='Local private notes',due_date='2026-11-20' where id=v_task;
  perform pg_temp.s6_assert((select revision=v_revision from tr8_private.google_tasks_links where id=v_link),'notes and local deadline changes are outside Tasks projection');
  v_result:=tr8_private.v6_observe(v_connection,'list-primary',v_remote||'{"etag":"etag-2","title":"Updated on Google","completed":true,"start_date":"2026-11-03"}');
  perform pg_temp.s6_assert(v_result->>'updated'='true','remote-only update imports');
  perform pg_temp.s6_assert((select title='Updated on Google' and status='done' and start_date='2026-11-03' and description='Local private notes' and due_date='2026-11-20' from public.tr8_workspace_tasks where id=v_task),'remote changes preserve local notes and deadline');
  v_remote:=v_remote||'{"etag":"etag-2","title":"Updated on Google","completed":true,"start_date":"2026-11-03"}';
  update public.tr8_workspace_tasks set status='todo' where id=v_task;
  v_job:=pg_temp.s6_take('patch',v_link);
  v_result:=pg_temp.s6_call('tasks_compare_remote',v_job||jsonb_build_object('remote',v_remote));
  perform pg_temp.s6_assert(v_result->>'action'='patch' and v_result->'patch'->>'status'='needsAction','local reopening patches the same Google task');
  v_hash:=v_result->>'prepared_hash';
  v_remote_a:=v_remote||'{"etag":"etag-3","completed":false}';
  update public.tr8_workspace_tasks set title='Concurrent local title' where id=v_task;
  perform pg_temp.s6_call('tasks_prepare',v_job);
  perform pg_temp.s6_assert((pg_temp.s6_call('tasks_finish',v_job||jsonb_build_object('outcome','succeeded','prepared_hash',v_hash,'remote',v_remote_a))#>>'{}')::boolean,'known write receipt accepted with captured projection hash');
  perform pg_temp.s6_assert((select state='dirty' and synced_local_hash=v_hash from tr8_private.google_tasks_links where id=v_link),'new local edit is not mislabeled as synchronized');
  perform pg_temp.s6_assert((select state='pending' from tr8_private.google_tasks_jobs where id=(v_job->>'job_id')::uuid),'concurrent edit remains durably queued');
  v_job:=pg_temp.s6_take('patch',v_link);
  v_result:=pg_temp.s6_call('tasks_compare_remote',v_job||jsonb_build_object('remote',v_remote_a));
  perform pg_temp.s6_assert(v_result->'patch'->>'title'='Concurrent local title','next write uses fresh local projection');
  v_remote:=v_remote_a||'{"etag":"etag-4","title":"Concurrent local title"}';
  perform pg_temp.s6_call('tasks_finish',v_job||jsonb_build_object('outcome','succeeded','prepared_hash',v_result->'prepared_hash','remote',v_remote));
  perform pg_temp.s6_assert((select state='synced' and synced_local_hash=base_projection_hash from tr8_private.google_tasks_links where id=v_link),'confirmed projection converges');
  update public.tr8_workspace_tasks set title='Local conflicting title' where id=v_task;
  v_result:=tr8_private.v6_observe(v_connection,'list-primary',v_remote||'{"etag":"etag-5","title":"Google conflicting title"}');
  perform pg_temp.s6_assert(v_result->>'action'='conflict','concurrent different changes stop automatically');
  perform pg_temp.s6_assert((select title='Local conflicting title' from public.tr8_workspace_tasks where id=v_task),'conflict preserves local content');
  perform pg_temp.s6_assert(pg_temp.s6_call('tasks_status')->>'conflicts'='1','conflict visible to owner');
  perform pg_temp.s6_request('tasks_resolve',jsonb_build_object('link_id',v_link,'resolution','google'));
  update public.tr8_workspace_tasks set title='New edit after choosing Google' where id=v_task;
  perform pg_temp.s6_assert((select resolution is null from tr8_private.google_tasks_links where id=v_link),'a later local edit invalidates the previous Google resolution');
  v_job:=pg_temp.s6_take('patch',v_link);
  v_remote:=v_remote||'{"etag":"etag-5","title":"Google conflicting title"}';
  v_result:=pg_temp.s6_call('tasks_compare_remote',v_job||jsonb_build_object('remote',v_remote));
  perform pg_temp.s6_assert(v_result->>'action'='conflict' and (select title='New edit after choosing Google' from public.tr8_workspace_tasks where id=v_task),'old resolution never overwrites a newer local edit');
  perform pg_temp.s6_call('tasks_finish',v_job||'{"outcome":"succeeded"}');
  perform pg_temp.s6_request('tasks_resolve',jsonb_build_object('link_id',v_link,'resolution','google'));
  v_job:=pg_temp.s6_take('patch',v_link);
  v_result:=pg_temp.s6_call('tasks_compare_remote',v_job||jsonb_build_object('remote',v_remote));
  perform pg_temp.s6_assert(v_result->>'action'='none','Google conflict choice imports latest remote without write');
  perform pg_temp.s6_call('tasks_finish',v_job||'{"outcome":"succeeded"}');
  perform pg_temp.s6_assert((select title='Google conflicting title' from public.tr8_workspace_tasks where id=v_task),'Google resolution applied');
  perform pg_temp.s6_assert(pg_temp.s6_call('tasks_status')->>'conflicts'='0','resolved conflict removed');
  v_result:=tr8_private.v6_observe(v_connection,'list-primary','{"id":"remote-two","deleted":true}');
  perform pg_temp.s6_assert(v_result->>'deleted'='true' and not exists(select 1 from public.tr8_workspace_tasks where id=v_task2),'explicit remote deletion removes only clean imported task');
  perform pg_temp.s6_assert((select state='deleted' and remote_task_id='remote-two' from tr8_private.google_tasks_links where id=v_link2),'remote deletion keeps tombstone identity');
  delete from public.tr8_workspace_tasks where id=v_task3;
  v_job:=pg_temp.s6_take('delete',v_link3);
  v_result:=pg_temp.s6_call('tasks_compare_remote',v_job||jsonb_build_object('remote',v_remote||'{"id":"remote-three","etag":"etag-three","title":"Completed Google task","completed":true,"start_date":"2026-11-02"}'));
  perform pg_temp.s6_assert(v_result->>'action'='delete','local deletion targets existing Google task');
  perform pg_temp.s6_call('tasks_finish',v_job||jsonb_build_object('outcome','succeeded','prepared_hash',null,'remote',jsonb_build_object('id','remote-three','deleted',true)));
  perform pg_temp.s6_assert((select state='deleted' from tr8_private.google_tasks_links where id=v_link3),'confirmed deletion keeps durable identity');
  perform pg_temp.s6_request('tasks_pause');
  perform pg_temp.s6_assert(pg_temp.s6_call('tasks_status')->>'state'='paused' and (select tasks_granted from tr8_private.google_connections where id=v_connection),'pause retains shared verified grant');
  perform pg_temp.s6_assert(not tr8_private.v5_task_eligible(v_connection,v_task),'pause never creates Calendar duplicate');
  perform pg_temp.s6_request('tasks_resume');
  perform pg_temp.s6_assert(pg_temp.s6_call('tasks_status')->>'state'='connected','resume needs no new OAuth');
  perform pg_temp.s6_request('tasks_select_list','{"list_id":"list-secondary","selected":true}');
  perform pg_temp.s6_assert((select selected from tr8_private.google_tasks_lists where connection_id=v_connection and list_id='list-secondary'),'owner can choose another task list');
  perform pg_temp.s6_request('tasks_select_list','{"list_id":"list-primary","selected":false}');
  perform pg_temp.s6_assert(exists(select 1 from public.tr8_workspace_tasks where id=v_task),'deselecting list preserves imported task');
  update public.tr8_workspace_tasks set title='Edited while list paused' where id=v_task;
  perform pg_temp.s6_assert(not exists(select 1 from tr8_private.google_tasks_jobs where connection_id=v_connection and list_id='list-primary' and state in ('pending','retry','leased')),'deselected list blocks outbound work');
  perform pg_temp.s6_request('tasks_select_list','{"list_id":"list-primary","selected":true}');
  v_job:=pg_temp.s6_take('patch',v_link);
  update tr8_private.google_jobs set available_at=clock_timestamp()-interval '1 second' where id=v_old_job;
  perform pg_temp.s6_assert(jsonb_array_length(pg_temp.s6_call('claim','{"limit":1}'))=0,'Calendar claim cannot overlap Tasks lease');
  v_token:=(v_job->>'lease_token')::uuid;
  update tr8_private.google_tasks_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=(v_job->>'job_id')::uuid;
  v_job:=pg_temp.s6_take('patch',v_link);
  perform pg_temp.s6_assert((v_job->>'lease_token')::uuid<>v_token,'expired Tasks lease receives new token');
  perform pg_temp.s6_assert(not (pg_temp.s6_call('tasks_finish',v_job||jsonb_build_object('lease_token',v_token,'outcome','succeeded'))#>>'{}')::boolean,'old lease cannot finish reclaimed work');
  select used_today into v_budget from tr8_private.google_config where singleton;
  perform pg_temp.s6_assert(pg_temp.s6_call('tasks_reserve_request',v_job||'{"purpose":"tasks_get"}')->>'allowed'='true','provider GET reserves shared budget');
  perform pg_temp.s6_assert((select used_today=v_budget+1 from tr8_private.google_config where singleton),'Tasks uses Calendar shared global budget');
  update tr8_private.google_config set used_today=daily_limit,day=(clock_timestamp() at time zone 'UTC')::date where singleton;
  perform pg_temp.s6_assert(pg_temp.s6_call('tasks_reserve_request',v_job||'{"purpose":"tasks_get"}')->>'reason'='budget_exhausted','daily cap prevents Tasks HTTP');
  update tr8_private.google_config set used_today=v_budget+1 where singleton;
  perform pg_temp.s6_call('tasks_finish',v_job||'{"outcome":"cancelled"}');
  v_input:=jsonb_build_object('request_id',gen_random_uuid(),'expected_version',(pg_temp.s6_call('status')->>'version')::integer,'state_hash',repeat('D',43),'browser_hash',repeat('E',43),'pkce_envelope',v_cipher,'app_origin','https://tr8.vercel.app');
  v_begin:=pg_temp.s6_call('begin',v_input);
  perform pg_temp.s6_assert(v_begin->>'tasks_requested'='true','existing Tasks capability is retained during ordinary reconnect');
  update tr8_private.google_oauth_attempts set consumed_at=clock_timestamp() where id=(v_begin->>'attempt_id')::uuid;
  perform pg_temp.s6_call('authorization_failed',jsonb_build_object('attempt_id',v_begin->>'attempt_id','reason','oauth_denied'));
  perform pg_temp.s6_assert((select state='connected' and tasks_granted and credential_envelope=v_new_cipher from tr8_private.google_connections where id=v_connection),'failed upgrade/reconnect preserves old shared grant and Calendar');
  select count(*) into v_project_count from public.tr8_workspace_tasks where owner_id=v_user;
  update tr8_private.google_connections set generation=2 where id=v_connection;
  update tr8_private.google_tasks_sync set generation=2 where connection_id=v_connection;
  insert into tr8_private.google_tasks_lists(connection_id,generation,list_id,title,selected) values(v_connection,2,'list-primary','My Tasks',true);
  v_result:=tr8_private.v6_observe(v_connection,'list-primary',v_remote);
  perform pg_temp.s6_assert(v_result->>'link_id'=v_link::text and not coalesce((v_result->>'imported')::boolean,false),'new grant adopts exact historical list/task identity');
  perform pg_temp.s6_assert((select generation=2 and local_task_id=v_task from tr8_private.google_tasks_links where id=v_link),'adoption preserves original local task identity');
  perform pg_temp.s6_assert((select count(*)=v_project_count from public.tr8_workspace_tasks where owner_id=v_user),'reconnection creates zero duplicate local tasks');
  perform pg_temp.s6_assert(not exists(select 1 from tr8_private.google_tasks_jobs where link_id=v_link and generation=1 and state in ('pending','retry','leased')),'historical jobs are fenced on identity adoption');
  perform pg_temp.s6_assert((select to_jsonb(t)=v_before_original from public.tr8_workspace_tasks t where id=v_original),'original task is byte-for-byte unchanged');
  perform pg_temp.s6_assert((select config from pg_temp.s6_before)=(select to_jsonb(c) from tr8_private.app_config c where singleton),'external signup and application config unchanged');
  perform pg_temp.s6_assert((select projects from pg_temp.s6_before)=(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb) from public.tr8_workspace_projects p where owner_id<>v_user),'prior projects untouched');
  perform pg_temp.s6_assert((select tasks from pg_temp.s6_before)=(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.tr8_workspace_tasks t where owner_id<>v_user),'prior tasks untouched');
  perform pg_temp.s6_error('select public.tr8_server_google(''tasks_status'',''f6000000-0000-4000-8000-000000000001'',''f6100000-0000-4000-8000-000000000002'')',array['42501'],'another account session cannot read Tasks state');
  delete from auth.sessions where id='f6100000-0000-4000-8000-000000000001';
  perform pg_temp.s6_error('select public.tr8_v6_get_google_tasks_status()',array['42501'],'retired session cannot read own Tasks status');
end;$$;
select current_setting('tr8.stage6_assertions')::integer assertions_passed,'Google Tasks schema, OAuth capability, worker fences and domain preservation' result;
rollback;
