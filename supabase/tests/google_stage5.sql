-- Disposable TEST database only. Every fixture and configuration change rolls
-- back. Never use a real Google credential or rewind the shared task sequence.
begin;
select set_config('tr8.stage5_assertions','0',true);
create temporary table s5_values(key text primary key,value jsonb) on commit drop;
create temporary table s5_before on commit drop as
select 'projects'::text kind,coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) value from public.tr8_workspace_projects t
union all select 'tasks',coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.tr8_workspace_tasks t
union all select 'config',to_jsonb(c) from tr8_private.app_config c where singleton;
create function pg_temp.s5_assert(p_ok boolean,p_label text) returns void language plpgsql security invoker set search_path='' as $$ begin
  if p_ok is distinct from true then raise exception 'Stage 5 assertion failed: %',p_label;end if;
  perform set_config('tr8.stage5_assertions',(current_setting('tr8.stage5_assertions')::integer+1)::text,true);
end; $$;
create function pg_temp.s5_error(p_sql text,p_states text[],p_label text) returns void language plpgsql security invoker set search_path='' as $$ begin
  begin execute p_sql;exception when others then
    if sqlstate=any(p_states) then perform pg_temp.s5_assert(true,p_label);return;end if;
    raise exception 'Stage 5 assertion failed: %; expected %, got % (%)',p_label,p_states,sqlstate,sqlerrm;
  end;raise exception 'Stage 5 assertion failed: % unexpectedly succeeded',p_label;
end; $$;
create function pg_temp.s5_put(p_key text,p_value jsonb) returns void language sql security invoker set search_path='' as $$
  insert into pg_temp.s5_values values(p_key,p_value) on conflict(key) do update set value=excluded.value;
$$;
create function pg_temp.s5_get(p_key text) returns jsonb language sql security invoker set search_path='' as $$ select value from pg_temp.s5_values where key=p_key; $$;
create function pg_temp.s5_actor(p_n integer) returns void language plpgsql security invoker set search_path='' as $$ begin
  perform set_config('request.jwt.claim.sub',('f5000000-0000-4000-8000-'||lpad(p_n::text,12,'0')),true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub','f5000000-0000-4000-8000-'||lpad(p_n::text,12,'0'),
    'role','authenticated','session_id','f5100000-0000-4000-8000-'||lpad(p_n::text,12,'0'),'user_metadata',jsonb_build_object('role','owner'))::text,true);
end; $$;
create function pg_temp.s5_call(p_action text,p_payload jsonb default '{}') returns jsonb language sql security invoker set search_path='' as $$
  select public.tr8_server_google(p_action,'f5000000-0000-4000-8000-000000000001','f5100000-0000-4000-8000-000000000001',p_payload);
$$;
create function pg_temp.s5_request(p_action text,p_extra jsonb default '{}') returns jsonb language sql security invoker set search_path='' as $$
  select pg_temp.s5_call(p_action,jsonb_build_object('request_id',gen_random_uuid(),'expected_version',(pg_temp.s5_call('status')->>'version')::integer)||p_extra);
$$;
create function pg_temp.s5_take(p_kind text) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_job uuid;v_jobs jsonb;begin
  select id into v_job from tr8_private.google_jobs where connection_id=(pg_temp.s5_get('begin')->>'connection_id')::uuid
    and kind=p_kind and state in ('pending','retry','leased') order by created_at,id limit 1;
  perform pg_temp.s5_assert(v_job is not null,'expected runnable job exists: '||p_kind);
  update tr8_private.google_jobs set available_at=clock_timestamp()+interval '1 year' where id<>v_job and state in ('pending','retry');
  update tr8_private.google_jobs set available_at=clock_timestamp()-interval '1 second' where id=v_job;
  v_jobs:=public.tr8_server_google('claim',null,null,'{"limit":1}');
  perform pg_temp.s5_assert(jsonb_array_length(v_jobs)=1 and v_jobs->0->>'kind'=p_kind,'worker claims requested synthetic job: '||p_kind);
  return v_jobs->0;
end; $$;
do $$ begin execute format('grant usage on schema %I to anon,authenticated,service_role',pg_my_temp_schema()::regnamespace::text);end $$;
grant select,insert,update on pg_temp.s5_values to anon,authenticated,service_role;
grant execute on function pg_temp.s5_assert(boolean,text),pg_temp.s5_error(text,text[],text),pg_temp.s5_put(text,jsonb),pg_temp.s5_get(text),pg_temp.s5_actor(integer),pg_temp.s5_call(text,jsonb),pg_temp.s5_request(text,jsonb) to anon,authenticated,service_role;

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('f5000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','tr8-stage5-'||n||'@example.test',clock_timestamp(),'{}','{"role":"owner"}',clock_timestamp(),clock_timestamp() from generate_series(1,3) n;
insert into tr8_private.app_users(user_id,enabled,display_name)
select ('f5000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,n<>3,'Synthetic Google '||n from generate_series(1,3) n;
insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
select ('f5100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('f5000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 day' from generate_series(1,3) n;
insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
values('f5100000-0000-4000-8000-000000000004','f5000000-0000-4000-8000-000000000001',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 day');
select pg_temp.s5_put('cipher','{"v":1,"kid":"synthetic","iv":"AAAAAAAAAAAAAAAA","ciphertext":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}');
do $$ declare t text;f record;begin
  perform pg_temp.s5_assert((select not external_invites_enabled from tr8_private.app_config where singleton),'external signup remains disabled');
  perform pg_temp.s5_assert((select not configured and not scheduler_enabled and worker_url is null from tr8_private.google_config where singleton),'Google starts disabled with no endpoint');
  perform pg_temp.s5_assert(not tr8_private.v5_wake_worker(),'disabled integration performs no HTTP');
  perform pg_temp.s5_assert((select count(*)=2 from cron.job where jobname in ('tr8-google-worker','tr8-google-maintenance') and not active),'Google cron entries start inactive');
  perform pg_temp.s5_assert(not tr8_private.v5_valid_envelope('{}'),'missing cipher fields rejected');
  perform pg_temp.s5_assert(not tr8_private.v5_valid_envelope(pg_temp.s5_get('cipher')||'{"refresh_token":"secret"}'),'plaintext token fields rejected');
  perform pg_temp.s5_assert(tr8_private.v5_valid_envelope(pg_temp.s5_get('cipher')),'synthetic opaque cipher shape accepted');
  perform pg_temp.s5_assert(tr8_private.v5_valid_envelope(pg_temp.s5_get('cipher')||jsonb_build_object('kid',repeat('K',64),'ciphertext',repeat('C',44000))),'cipher and key limits align with the server crypto adapter');
  foreach t in array array['google_config','google_connections','google_oauth_attempts','google_event_links','google_jobs','google_requests','google_request_receipts'] loop
    perform pg_temp.s5_assert((select relrowsecurity from pg_class where oid=('tr8_private.'||t)::regclass),'RLS on '||t);
    perform pg_temp.s5_assert(not has_table_privilege('anon','tr8_private.'||t,'SELECT,INSERT,UPDATE,DELETE'),'anonymous table denied '||t);
    perform pg_temp.s5_assert(not has_table_privilege('authenticated','tr8_private.'||t,'SELECT,INSERT,UPDATE,DELETE'),'client table denied '||t);
    perform pg_temp.s5_assert(not has_table_privilege('service_role','tr8_private.'||t,'SELECT,INSERT,UPDATE,DELETE'),'service table denied '||t);
  end loop;
  for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='tr8_private' and p.proname like 'v5_%' loop
    perform pg_temp.s5_assert(not has_function_privilege('anon',f.signature,'EXECUTE'),'anonymous helper denied '||f.proname);
    if f.proname<>'v5_get_status' then perform pg_temp.s5_assert(not has_function_privilege('authenticated',f.signature,'EXECUTE'),'client worker denied '||f.proname);end if;
    if f.proname<>'v5_server' then perform pg_temp.s5_assert(not has_function_privilege('service_role',f.signature,'EXECUTE'),'service helper denied '||f.proname);end if;
  end loop;
  perform pg_temp.s5_assert((select not prosecdef from pg_proc where oid='public.tr8_server_google(text,uuid,uuid,jsonb)'::regprocedure),'server wrapper is invoker');
  perform pg_temp.s5_assert(not has_function_privilege('authenticated','public.tr8_server_google(text,uuid,uuid,jsonb)','EXECUTE'),'server wrapper not client callable');
  perform pg_temp.s5_assert(has_function_privilege('service_role','public.tr8_server_google(text,uuid,uuid,jsonb)','EXECUTE'),'service role can dispatch');
end; $$;
set local role authenticated;
select pg_temp.s5_actor(1);
select pg_temp.s5_put('context',public.tr8_v2_get_context());
select pg_temp.s5_put('workspace',jsonb_build_object('id',pg_temp.s5_get('context')->>'personal_workspace_id'));
select pg_temp.s5_put('project',to_jsonb(public.tr8_v2_create_project((pg_temp.s5_get('workspace')->>'id')::uuid,'a5000000-0000-4000-8000-000000000001','Private Google project','NEVER COPY DESCRIPTION','#5A67D8','active')));
select pg_temp.s5_put('task',to_jsonb(public.tr8_v2_create_task((pg_temp.s5_get('workspace')->>'id')::uuid,'e5000000-0000-4000-8000-000000000001',(pg_temp.s5_get('project')->>'id')::uuid,'Private Google task','NEVER COPY NOTES','todo','none',null,'2026-11-01')));
select pg_temp.s5_assert(public.tr8_v2_get_google_status()='{"configured":false,"state":"disconnected","generation":0,"version":0,"last_sync_at":null,"pending":0,"failed":0,"reason":"config_pending"}','own absent connection has safe default status');
select pg_temp.s5_error('select public.tr8_server_google(''claim'')',array['42501'],'authenticated cannot impersonate worker');
select pg_temp.s5_actor(3);
select pg_temp.s5_error('select public.tr8_v2_get_google_status()',array['42501'],'disabled account rejected despite forged metadata');
select pg_temp.s5_actor(1);
reset role;
select pg_temp.s5_assert((select count(*)=0 from tr8_private.google_connections),'status and existing domain writes do not create connections');
select pg_temp.s5_assert((select count(*)=0 from tr8_private.google_jobs),'disconnected users produce no Google jobs');
set local role service_role;
select pg_temp.s5_error('select pg_temp.s5_request(''begin'')',array['PT503'],'cannot authorize an unconfigured integration');
select pg_temp.s5_error('select public.tr8_server_google(''status'',''f5000000-0000-4000-8000-000000000001'',''f5100000-0000-4000-8000-000000000002'')',array['42501'],'actor cannot use another user session');
reset role;
update tr8_private.google_config set configured=true where singleton;
set local role service_role;
select pg_temp.s5_put('begin_input',jsonb_build_object('request_id',gen_random_uuid(),'expected_version',0,'state_hash',repeat('A',43),'browser_hash',repeat('B',43),'pkce_envelope',pg_temp.s5_get('cipher'),'app_origin','https://tr8.vercel.app'));
select pg_temp.s5_put('begin',pg_temp.s5_call('begin',pg_temp.s5_get('begin_input')));
select pg_temp.s5_assert(pg_temp.s5_call('begin',pg_temp.s5_get('begin_input'))=pg_temp.s5_get('begin'),'begin request is idempotent');
select pg_temp.s5_assert(pg_temp.s5_call('begin',pg_temp.s5_get('begin_input')||jsonb_build_object('state_hash',repeat('E',43),
  'pkce_envelope',pg_temp.s5_get('cipher')||'{"ciphertext":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"}'))=pg_temp.s5_get('begin'),'begin replay returns original material despite fresh server randomness');
select pg_temp.s5_error('select public.tr8_server_google(''begin'',''f5000000-0000-4000-8000-000000000001'',''f5100000-0000-4000-8000-000000000004'',pg_temp.s5_get(''begin_input''))',array['PT409'],'another live session cannot replay the initiating browser request');
select pg_temp.s5_error('select pg_temp.s5_call(''begin'',pg_temp.s5_get(''begin_input'')||''{"browser_hash":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"}'')',array['PT409'],'request identity conflict rejected');
select pg_temp.s5_assert(pg_temp.s5_call('relay',jsonb_build_object('state_hash',repeat('A',43)))='{"app_origin":"https://tr8.vercel.app","user_id":"f5000000-0000-4000-8000-000000000001"}','server relay only returns fixed origin and encryption subject');
select pg_temp.s5_error('select pg_temp.s5_call(''consume_attempt'',jsonb_build_object(''state_hash'',repeat(''A'',43),''browser_hash'',repeat(''B'',43)))',array['PT404'],'callback result must exist before authenticated consumption');
select pg_temp.s5_put('oauth_result',jsonb_build_object('state_hash',repeat('A',43),'result_hash',repeat('R',43),'result_envelope',pg_temp.s5_get('cipher')));
select pg_temp.s5_assert(pg_temp.s5_call('record_oauth_result',pg_temp.s5_get('oauth_result'))='{"app_origin":"https://tr8.vercel.app"}','callback stores encrypted result before fixed redirect');
select pg_temp.s5_assert(pg_temp.s5_call('record_oauth_result',pg_temp.s5_get('oauth_result')||jsonb_build_object('result_envelope',pg_temp.s5_get('cipher')||'{"ciphertext":"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"}'))='{"app_origin":"https://tr8.vercel.app"}','same callback result hash is idempotent despite fresh encryption randomness');
select pg_temp.s5_error('select pg_temp.s5_call(''record_oauth_result'',pg_temp.s5_get(''oauth_result'')||jsonb_build_object(''result_hash'',repeat(''S'',43)))',array['PT409'],'different callback result cannot replace the first result');
select pg_temp.s5_error('select pg_temp.s5_call(''consume_attempt'',jsonb_build_object(''state_hash'',repeat(''A'',43),''browser_hash'',repeat(''C'',43)))',array['PT404'],'wrong browser cannot consume OAuth attempt');
select pg_temp.s5_put('attempt',pg_temp.s5_call('consume_attempt',jsonb_build_object('state_hash',repeat('A',43),'browser_hash',repeat('B',43))));
select pg_temp.s5_assert(pg_temp.s5_get('attempt')->'pkce_envelope'=pg_temp.s5_get('cipher'),'server receives encrypted PKCE after consumption');
select pg_temp.s5_assert(pg_temp.s5_get('attempt')->'result_envelope'=pg_temp.s5_get('cipher'),'consumer receives the original encrypted callback result');
select pg_temp.s5_assert(pg_temp.s5_get('attempt')->>'generation'='1','first authorization selects generation one');
select pg_temp.s5_error('select pg_temp.s5_call(''consume_attempt'',jsonb_build_object(''state_hash'',repeat(''A'',43),''browser_hash'',repeat(''B'',43)))',array['PT404'],'OAuth state is single use');
select pg_temp.s5_error('select pg_temp.s5_call(''begin'',pg_temp.s5_get(''begin_input''))',array['PT409'],'consumed OAuth initiation cannot replay encrypted material');
select pg_temp.s5_error('select pg_temp.s5_call(''record_oauth_result'',pg_temp.s5_get(''oauth_result''))',array['PT404'],'consumed callback result cannot be recorded again');
select pg_temp.s5_error('select pg_temp.s5_call(''relay'',jsonb_build_object(''state_hash'',repeat(''A'',43)))',array['PT404'],'consumed state cannot relay again');
select pg_temp.s5_put('authorized',pg_temp.s5_call('complete_authorization',jsonb_build_object('attempt_id',pg_temp.s5_get('attempt')->>'attempt_id','credential_envelope',pg_temp.s5_get('cipher'),'keep_existing_calendar',false)));
select pg_temp.s5_assert(pg_temp.s5_get('authorized')->>'state'='provisioning','authorization queues calendar provisioning');
select pg_temp.s5_assert(pg_temp.s5_get('authorized')->>'pending'='1','exactly one provision job queued');
select pg_temp.s5_error('select pg_temp.s5_call(''complete_authorization'',jsonb_build_object(''attempt_id'',pg_temp.s5_get(''attempt'')->>''attempt_id'',''credential_envelope'',pg_temp.s5_get(''cipher'')))',array['PT404'],'completed authorization cannot replay');
reset role;
select pg_temp.s5_put('job',pg_temp.s5_take('provision'));
set local role service_role;
select pg_temp.s5_put('prepared',pg_temp.s5_call('prepare',pg_temp.s5_get('job')));
select pg_temp.s5_assert(pg_temp.s5_get('prepared')->>'kind'='provision' and pg_temp.s5_get('prepared')->>'time_zone'='UTC','provision prepares profile zone fallback');
select pg_temp.s5_assert((pg_temp.s5_call('reserve_request',pg_temp.s5_get('job')||'{"purpose":"calendar_create"}')->>'allowed')::boolean,'calendar creation reserves request budget');
select pg_temp.s5_assert(pg_temp.s5_call('status')->>'state'='provisioning_unknown','unknown state persists before remote create');
select pg_temp.s5_assert(pg_temp.s5_call('reserve_request',pg_temp.s5_get('job')||'{"purpose":"calendar_create"}')->>'reason'='provisioning_unknown','same lease cannot blindly create a second calendar');
select pg_temp.s5_assert(pg_temp.s5_call('finish',pg_temp.s5_get('job')||'{"outcome":"unknown"}')='true','uncertain provisioning result stored');
select pg_temp.s5_assert(pg_temp.s5_call('claim','{"limit":2}')='[]','unknown provisioning does not automatically replay');
select pg_temp.s5_put('recovered',pg_temp.s5_request('recover_calendar','{"calendar_id":"synthetic-tr8@group.calendar.google.com"}'));
select pg_temp.s5_assert(pg_temp.s5_get('recovered')->>'state'='connected','verified recovery binds known calendar identifier');
select pg_temp.s5_assert((pg_temp.s5_call('inspect_connection')->'credential_envelope')=pg_temp.s5_get('cipher'),'only server may inspect encrypted credentials');
reset role;
select pg_temp.s5_put('scan',pg_temp.s5_take('reconcile_scan'));
set local role service_role;
select pg_temp.s5_put('prepared',pg_temp.s5_call('prepare',pg_temp.s5_get('scan')));
select pg_temp.s5_assert(pg_temp.s5_get('prepared')->>'internal'='true' and pg_temp.s5_get('prepared')->>'scanned'='1','scan is bounded internal preparation');
select pg_temp.s5_assert(not(pg_temp.s5_get('prepared') ? 'credential_envelope'),'internal scan does not return credentials');
select pg_temp.s5_assert(pg_temp.s5_call('finish',pg_temp.s5_get('scan')||'{"outcome":"succeeded"}')='true','scan completion durable');
reset role;
select pg_temp.s5_put('job',pg_temp.s5_take('upsert'));
set local role service_role;
select pg_temp.s5_put('prepared',pg_temp.s5_call('prepare',pg_temp.s5_get('job')));
select pg_temp.s5_assert(pg_temp.s5_get('prepared')->'event'->>'title'='Private Google task','fresh authorized task projection prepared');
select pg_temp.s5_assert(pg_temp.s5_get('prepared')->'event'->>'due_date'='2026-11-01','civil due date preserved');
select pg_temp.s5_assert(pg_temp.s5_get('prepared')->'link'->>'event_id' ~ '^[0-9a-f]{32}$','remote event id is compatible random persisted UUID');
select pg_temp.s5_assert(pg_temp.s5_get('prepared')->'link'->>'event_id'<>replace(pg_temp.s5_get('task')->>'id','-',''),'remote id does not expose task identifier');
select pg_temp.s5_assert(pg_temp.s5_get('prepared')::text not like '%NEVER COPY%','projection excludes task and project descriptions');
select pg_temp.s5_assert(pg_temp.s5_call('claim','{"limit":2}')='[]','one active lease per connection');
select pg_temp.s5_assert(pg_temp.s5_call('save_credentials',pg_temp.s5_get('job')||jsonb_build_object('credential_envelope',pg_temp.s5_get('cipher')))='true','refresh credentials persist before external effect');
select pg_temp.s5_assert(pg_temp.s5_call('save_credentials',pg_temp.s5_get('job')||jsonb_build_object('lease_token',gen_random_uuid(),'credential_envelope',pg_temp.s5_get('cipher')))='false','foreign lease cannot replace credentials');
select pg_temp.s5_assert((pg_temp.s5_call('reserve_request',pg_temp.s5_get('job')||'{"purpose":"event_upsert"}')->>'allowed')::boolean,'upsert reserves an HTTP attempt');
reset role;
select pg_temp.s5_assert((select cleanup_not_before>clock_timestamp()+interval '60 seconds' from tr8_private.google_event_links where id=(pg_temp.s5_get('prepared')->'link'->>'id')::uuid),'write reservation persists cleanup grace independently of lease fields');
set local role authenticated;
select pg_temp.s5_actor(1);
select pg_temp.s5_put('task',to_jsonb(public.tr8_v2_update_task((pg_temp.s5_get('workspace')->>'id')::uuid,(pg_temp.s5_get('task')->>'id')::uuid,1,'{"title":"Latest authorized title"}')));
reset role;
set local role service_role;
select pg_temp.s5_assert(pg_temp.s5_call('finish',pg_temp.s5_get('job')||'{"outcome":"succeeded"}')='true','remote success remains recorded after a newer domain revision');
select pg_temp.s5_assert(pg_temp.s5_call('finish',pg_temp.s5_get('job')||'{"outcome":"succeeded"}')='false','duplicate confirmation rejected');
reset role;
select pg_temp.s5_assert((select state='pending' from tr8_private.google_jobs where id=(pg_temp.s5_get('job')->>'job_id')::uuid),'new revision remains pending after stale external success');
select pg_temp.s5_put('job',pg_temp.s5_take('upsert'));
set local role service_role;
select pg_temp.s5_put('prepared',pg_temp.s5_call('prepare',pg_temp.s5_get('job')));
select pg_temp.s5_assert(pg_temp.s5_get('prepared')->'event'->>'title'='Latest authorized title','reconciliation always reads latest domain content');
reset role;
update tr8_private.google_config set day=(clock_timestamp() at time zone 'UTC')::date,used_today=0,daily_limit=1,
  month=date_trunc('month',clock_timestamp() at time zone 'UTC')::date,used_month=0 where singleton;
set local role service_role;
select pg_temp.s5_assert((pg_temp.s5_call('reserve_request',pg_temp.s5_get('job')||'{"purpose":"event_get"}')->>'allowed')::boolean,'last available request budget reserved');
select pg_temp.s5_assert(pg_temp.s5_call('reserve_request',pg_temp.s5_get('job')||'{"purpose":"event_upsert"}')->>'reason'='budget_exhausted','request budget blocks extra HTTP');
select pg_temp.s5_assert(pg_temp.s5_call('finish',pg_temp.s5_get('job')||'{"outcome":"retry","retry_after_seconds":120}')='true','temporary failure queued for retry');
reset role;
select pg_temp.s5_assert((select state='retry' and available_at>clock_timestamp()+interval '119 seconds' from tr8_private.google_jobs where id=(pg_temp.s5_get('job')->>'job_id')::uuid),'retry honors provider delay');
update tr8_private.google_config set daily_limit=500,used_today=0,used_month=0 where singleton;
select pg_temp.s5_put('old_job',pg_temp.s5_get('job'));
select pg_temp.s5_put('job',pg_temp.s5_take('upsert'));
update tr8_private.google_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=(pg_temp.s5_get('job')->>'job_id')::uuid;
select pg_temp.s5_put('expired_job',pg_temp.s5_get('job'));
select pg_temp.s5_put('job',pg_temp.s5_take('upsert'));
set local role service_role;
select pg_temp.s5_assert(pg_temp.s5_get('expired_job')->>'lease_token'<>pg_temp.s5_get('job')->>'lease_token','expired reservation receives a new token');
select pg_temp.s5_assert(pg_temp.s5_call('finish',pg_temp.s5_get('expired_job')||'{"outcome":"succeeded"}')='false','expired token cannot confirm replacement lease');
select pg_temp.s5_put('prepared',pg_temp.s5_call('prepare',pg_temp.s5_get('job')));
select pg_temp.s5_put('disconnect',pg_temp.s5_request('disconnect','{"mode":"delete"}'));
select pg_temp.s5_assert(pg_temp.s5_get('disconnect')->>'state'='disconnecting','delete choice blocks future normal creation immediately');
select pg_temp.s5_assert(pg_temp.s5_call('reserve_request',pg_temp.s5_get('job')||'{"purpose":"event_upsert"}')->>'reason'='access_changed','in-flight worker rechecks live connection before external write');
select pg_temp.s5_assert(pg_temp.s5_call('finish',pg_temp.s5_get('job')||'{"outcome":"succeeded"}')='true','in-flight known success retained for compensating cleanup');
reset role;
select pg_temp.s5_assert((select state='deleting' from tr8_private.google_event_links where id=(pg_temp.s5_get('prepared')->'link'->>'id')::uuid),'disconnect race schedules identifier-only compensating delete');
select pg_temp.s5_assert((select available_at>clock_timestamp()+interval '60 seconds' from tr8_private.google_jobs where kind='delete' and connection_id=(pg_temp.s5_get('begin')->>'connection_id')::uuid),'delete waits for old lease plus network grace');
select pg_temp.s5_put('revoke',pg_temp.s5_take('revoke'));
set local role service_role;
select pg_temp.s5_assert(pg_temp.s5_call('prepare',pg_temp.s5_get('revoke'))='{"valid":false,"wait":true}','revoke waits for unresolved deletion');
reset role;
select pg_temp.s5_put('delete',pg_temp.s5_take('delete'));
set local role service_role;
select pg_temp.s5_put('cleanup',pg_temp.s5_call('prepare',pg_temp.s5_get('delete')));
select pg_temp.s5_assert(pg_temp.s5_get('cleanup')->>'valid'='true' and not(pg_temp.s5_get('cleanup') ? 'event'),'cleanup exposes no private domain payload');
select pg_temp.s5_assert(pg_temp.s5_call('finish',pg_temp.s5_get('delete')||'{"outcome":"succeeded"}')='true','confirmed remote cleanup recorded');
reset role;
select pg_temp.s5_put('revoke',pg_temp.s5_take('revoke'));
set local role service_role;
select pg_temp.s5_assert(pg_temp.s5_call('prepare',pg_temp.s5_get('revoke'))->>'valid'='true','revoke becomes runnable after cleanup');
select pg_temp.s5_assert(pg_temp.s5_call('finish',pg_temp.s5_get('revoke')||'{"outcome":"succeeded"}')='true','revocation finishes disconnect');
select pg_temp.s5_assert(pg_temp.s5_call('inspect_connection')->'credential_envelope'='null','credentials removed after disconnect');
select pg_temp.s5_assert(pg_temp.s5_call('status')->>'state'='disconnected','disconnect completion visible to owner');
reset role;
-- A crash on the final cleanup attempt must expose an actionable failure,
-- rather than leaving disconnecting forever while revoke waits for deletion.
update tr8_private.google_connections set state='disconnecting',disconnect_mode='delete',credential_envelope=pg_temp.s5_get('cipher'),
  calendar_id='synthetic-tr8@group.calendar.google.com' where id=(pg_temp.s5_get('begin')->>'connection_id')::uuid;
update tr8_private.google_event_links set state='deleting' where id=(pg_temp.s5_get('prepared')->'link'->>'id')::uuid;
update tr8_private.google_jobs set state='leased',attempts=8,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()-interval '1 second',
  available_at=clock_timestamp()-interval '1 second',finished_at=null where id=(pg_temp.s5_get('delete')->>'job_id')::uuid;
select pg_temp.s5_assert(public.tr8_server_google('claim',null,null,'{"limit":2}')='[]','exhausted expired cleanup job cannot be claimed again');
select pg_temp.s5_assert((select state='dead' from tr8_private.google_jobs where id=(pg_temp.s5_get('delete')->>'job_id')::uuid),'final expired cleanup lease becomes dead');
select pg_temp.s5_assert((select state='cleanup_failed' and reason='cleanup_failed' from tr8_private.google_connections where id=(pg_temp.s5_get('begin')->>'connection_id')::uuid),'exhausted cleanup leaves retry and abandon available');
select pg_temp.s5_assert((select cleanup_not_before is not null from tr8_private.google_event_links where id=(pg_temp.s5_get('prepared')->'link'->>'id')::uuid),'clearing an expired lease retains the independent cleanup barrier');
set local role service_role;
select pg_temp.s5_assert(pg_temp.s5_request('retry_cleanup')->>'state'='disconnecting','user can retry exhausted cleanup');
select pg_temp.s5_assert(pg_temp.s5_request('abandon_cleanup')->>'state'='disconnecting','user can abandon remaining cleanup and withdraw credentials');
reset role;
select pg_temp.s5_put('revoke',pg_temp.s5_take('revoke'));
set local role service_role;
select pg_temp.s5_assert(pg_temp.s5_call('prepare',pg_temp.s5_get('revoke'))->>'valid'='true','abandoned cleanup permits credential revocation');
select pg_temp.s5_assert(pg_temp.s5_call('finish',pg_temp.s5_get('revoke')||'{"outcome":"succeeded"}')='true','abandon completes through revocation');
reset role;
-- Explicit reconstruction and keep are independent, owner-controlled choices.
update tr8_private.google_connections set state='connected',generation=2,version=version+1,
  calendar_id='synthetic-second@group.calendar.google.com',credential_envelope=pg_temp.s5_get('cipher')
  where id=(pg_temp.s5_get('begin')->>'connection_id')::uuid;
update tr8_private.google_connections set state='needs_reauthorization',reason='reauthorization_required'
  where id=(pg_temp.s5_get('begin')->>'connection_id')::uuid;
set local role service_role;
select pg_temp.s5_put('reauth_begin',pg_temp.s5_request('begin',jsonb_build_object('state_hash',repeat('F',43),'browser_hash',repeat('G',43),'pkce_envelope',pg_temp.s5_get('cipher'),'app_origin','https://tr8.vercel.app')));
select pg_temp.s5_call('record_oauth_result',jsonb_build_object('state_hash',repeat('F',43),'result_hash',repeat('J',43),'result_envelope',pg_temp.s5_get('cipher')));
select pg_temp.s5_put('reauth_attempt',pg_temp.s5_call('consume_attempt',jsonb_build_object('state_hash',repeat('F',43),'browser_hash',repeat('G',43))));
select pg_temp.s5_assert(pg_temp.s5_call('authorization_failed',jsonb_build_object('attempt_id',pg_temp.s5_get('reauth_attempt')->>'attempt_id','reason','oauth_denied'))->>'state'='needs_reauthorization','denied reauthorization never restores an invalid connection as connected');
select pg_temp.s5_put('reauth_expiry',pg_temp.s5_request('begin',jsonb_build_object('state_hash',repeat('H',43),'browser_hash',repeat('I',43),'pkce_envelope',pg_temp.s5_get('cipher'),'app_origin','https://tr8.vercel.app')));
select pg_temp.s5_call('record_oauth_result',jsonb_build_object('state_hash',repeat('H',43),'result_hash',repeat('L',43),'result_envelope',pg_temp.s5_get('cipher')));
reset role;
update tr8_private.google_oauth_attempts set expires_at=clock_timestamp()-interval '1 second' where id=(pg_temp.s5_get('reauth_expiry')->>'attempt_id')::uuid;
select tr8_private.v5_maintain();
select pg_temp.s5_assert((select state='needs_reauthorization' from tr8_private.google_connections where id=(pg_temp.s5_get('begin')->>'connection_id')::uuid),'expired reauthorization preserves the need to reconnect');
select pg_temp.s5_assert((select result_envelope is null and pkce_envelope is null from tr8_private.google_oauth_attempts where id=(pg_temp.s5_get('reauth_expiry')->>'attempt_id')::uuid),'maintenance removes both expired encrypted OAuth inputs and callback result');
update tr8_private.google_connections set state='connected',reason=null where id=(pg_temp.s5_get('begin')->>'connection_id')::uuid;
insert into tr8_private.google_event_links(connection_id,generation,workspace_id,project_id,task_id,task_created_at,state)
  select (pg_temp.s5_get('begin')->>'connection_id')::uuid,2,workspace_id,project_id,id,created_at,'remote_missing'
  from public.tr8_workspace_tasks where id=(pg_temp.s5_get('task')->>'id')::uuid;
select pg_temp.s5_put('missing',(
  select jsonb_build_object('id',id,'event_id',event_id) from tr8_private.google_event_links
  where connection_id=(pg_temp.s5_get('begin')->>'connection_id')::uuid and generation=2));
set local role service_role;
select pg_temp.s5_put('rebuilt',pg_temp.s5_request('rebuild_missing'));
select pg_temp.s5_assert(pg_temp.s5_get('rebuilt')->>'state'='connected','explicit reconstruction keeps the connection usable');
reset role;
select pg_temp.s5_assert((select event_id<>pg_temp.s5_get('missing')->>'event_id' and state='pending' and synced_hash is null
  and pg_temp.s5_get('missing')->>'event_id'=any(retired_event_ids)
  from tr8_private.google_event_links where id=(pg_temp.s5_get('missing')->>'id')::uuid),'explicit rebuild persists a new ID and records the confirmed-deleted incarnation');
set local role service_role;
select pg_temp.s5_error('select pg_temp.s5_request(''rebuild_missing'')',array['PT409'],'reconstruction cannot duplicate an already pending event');
select pg_temp.s5_put('kept',pg_temp.s5_request('disconnect','{"mode":"keep"}'));
select pg_temp.s5_assert(pg_temp.s5_get('kept')->>'state'='disconnecting','keep choice begins credential withdrawal');
reset role;
select pg_temp.s5_assert((select state='retained' from tr8_private.google_event_links where id=(pg_temp.s5_get('missing')->>'id')::uuid),'keep preserves the known Google copy');
select pg_temp.s5_assert(not exists(select 1 from tr8_private.google_jobs where connection_id=(pg_temp.s5_get('begin')->>'connection_id')::uuid and generation=2 and kind='delete'),'keep never schedules event deletion');
select pg_temp.s5_put('revoke',pg_temp.s5_take('revoke'));
set local role service_role;
select pg_temp.s5_assert(pg_temp.s5_call('prepare',pg_temp.s5_get('revoke'))->>'valid'='true','keep can revoke without deleting retained copies');
select pg_temp.s5_assert(pg_temp.s5_call('finish',pg_temp.s5_get('revoke')||'{"outcome":"succeeded"}')='true','keep finalizes credential removal');
select pg_temp.s5_put('expiry',pg_temp.s5_request('begin',jsonb_build_object('state_hash',repeat('C',43),'browser_hash',repeat('D',43),'pkce_envelope',pg_temp.s5_get('cipher'),'app_origin','https://tr8.vercel.app')));
select pg_temp.s5_assert(pg_temp.s5_get('expiry')->>'generation'='3','new connection after disconnection advances generation');
reset role;
update tr8_private.google_oauth_attempts set expires_at=clock_timestamp()-interval '1 second' where id=(pg_temp.s5_get('expiry')->>'attempt_id')::uuid;
set local role service_role;
select pg_temp.s5_error('select pg_temp.s5_call(''consume_attempt'',jsonb_build_object(''state_hash'',repeat(''C'',43),''browser_hash'',repeat(''D'',43)))',array['PT404'],'expired OAuth attempt cannot be consumed');
select pg_temp.s5_error('select pg_temp.s5_call(''relay'',jsonb_build_object(''state_hash'',repeat(''C'',43)))',array['PT404'],'expired OAuth attempt cannot relay');
reset role;
select tr8_private.v5_maintain();
select pg_temp.s5_assert((select pkce_envelope is null from tr8_private.google_oauth_attempts where id=(pg_temp.s5_get('expiry')->>'attempt_id')::uuid),'maintenance removes expired encrypted PKCE');
select pg_temp.s5_assert((select state='disconnected' and reason='oauth_expired' from tr8_private.google_connections where id=(pg_temp.s5_get('begin')->>'connection_id')::uuid),'expired authorization returns to a usable disconnected state');
select pg_temp.s5_assert((select not configured or not scheduler_enabled from tr8_private.google_config where singleton),'tests never enabled automatic HTTP');
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id='f5100000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.s5_actor(1);
select pg_temp.s5_error('select public.tr8_v2_get_google_status()',array['42501'],'old JWT cannot read integration after session expiry');
select pg_temp.s5_actor(2);
select pg_temp.s5_assert(public.tr8_v2_get_google_status()->>'version'='0','another user sees only their absent connection');
reset role;
do $$ declare r record;begin
  for r in select * from s5_before where kind in ('projects','tasks') loop
    if r.kind='projects' then
      perform pg_temp.s5_assert(r.value=(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.tr8_workspace_projects t where id<>'a5000000-0000-4000-8000-000000000001'),'pre-existing projects unchanged');
    else
      perform pg_temp.s5_assert(r.value=(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.tr8_workspace_tasks t where id<>'e5000000-0000-4000-8000-000000000001'),'pre-existing tasks unchanged');
    end if;
  end loop;
  perform pg_temp.s5_assert((select value from s5_before where kind='config')=(select to_jsonb(c) from tr8_private.app_config c where singleton),'external signup and application configuration unchanged');
end; $$;
select current_setting('tr8.stage5_assertions')::integer as assertions_passed,'Google stage 5 rollback suite passed' as result;
rollback;
