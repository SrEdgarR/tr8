-- TEST only. Rollback fixtures model the interval between the admitted calendar
-- creation request and its confirmation. No Google HTTP or cron is executed.
begin;
select set_config('tr8.provisioning_status_assertions','0',true);
create function pg_temp.ps_assert(p_ok boolean,p_label text) returns void language plpgsql security invoker set search_path='' as $$ begin
  if p_ok is distinct from true then raise exception 'Provisioning status assertion failed: %',p_label;end if;
  perform set_config('tr8.provisioning_status_assertions',(current_setting('tr8.provisioning_status_assertions')::integer+1)::text,true);
end; $$;
do $$
declare v_user uuid:='f5300000-0000-4000-8000-000000000001';
  v_other uuid:='f5300000-0000-4000-8000-000000000002';
  v_connection uuid; v_other_connection uuid; v_job uuid; v_token uuid:=gen_random_uuid();
  v_state jsonb; v_before jsonb; v_runtime jsonb; v_other_job uuid;
begin
  insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    select u.id,'authenticated','authenticated',u.email,clock_timestamp(),'{}','{}',clock_timestamp(),clock_timestamp()
    from(values(v_user,'tr8-provisioning-status-1@example.test'),(v_other,'tr8-provisioning-status-2@example.test')) u(id,email);
  insert into tr8_private.app_users(user_id,enabled,display_name) values(v_user,true,'Synthetic status one'),(v_other,true,'Synthetic status two');
  update tr8_private.google_config set configured=true where singleton;
  insert into tr8_private.google_connections(user_id,generation,state,credential_envelope)
    values(v_user,1,'provisioning','{"v":1,"kid":"synthetic","iv":"AAAAAAAAAAAAAAAA","ciphertext":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}') returning id into v_connection;
  insert into tr8_private.google_connections(user_id,generation,state,reason)
    values(v_other,1,'provisioning_unknown','provisioning_unknown') returning id into v_other_connection;
  insert into tr8_private.google_jobs(connection_id,generation,kind,state,lease_token,lease_expires_at,attempts)
    values(v_connection,1,'provision','leased',v_token,clock_timestamp()+interval '60 seconds',1) returning id into v_job;
  -- Real reservation transition; its durable unknown fence must remain active.
  perform pg_temp.ps_assert((tr8_private.v5_reserve_request(null,null,jsonb_build_object('job_id',v_job,'lease_token',v_token,'purpose','calendar_create'))->>'allowed')::boolean,'calendar create is admitted once');
  select to_jsonb(c) into v_before from tr8_private.google_connections c where id=v_connection;
  select to_jsonb(c) into v_runtime from tr8_private.google_config c where singleton;
  v_state:=tr8_private.v5_status(v_user);
  perform pg_temp.ps_assert(v_state->>'state'='provisioning' and v_state->'reason'='null'::jsonb,'valid provision lease is normal preparation with no error');
  perform pg_temp.ps_assert(v_state->>'pending'='1' and v_state->>'failed'='0','projection preserves job counters');
  perform pg_temp.ps_assert(v_state->>'generation'='1' and v_state->>'version'=v_before->>'version','projection preserves generation and version');
  perform pg_temp.ps_assert(v_before=(select to_jsonb(c) from tr8_private.google_connections c where id=v_connection),'reading status never rewrites the uncertain stored state');
  perform pg_temp.ps_assert(v_runtime=(select to_jsonb(c) from tr8_private.google_config c where singleton),'reading status never changes request budget');
  perform pg_temp.ps_assert(v_before->>'state'='provisioning_unknown' and v_before->>'reason'='provisioning_unknown','durable creation uncertainty is preserved');
  perform pg_temp.ps_assert(tr8_private.v5_reserve_request(null,null,jsonb_build_object('job_id',v_job,'lease_token',v_token,'purpose','calendar_create'))->>'reason'='provisioning_unknown','status projection cannot admit a duplicate calendar create');
  perform pg_temp.ps_assert(tr8_private.v5_status(v_other)->>'state'='provisioning_unknown','another connection lease cannot hide this connection uncertainty');

  update tr8_private.google_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=v_job;
  perform pg_temp.ps_assert(tr8_private.v5_status(v_user)->>'state'='provisioning_unknown'
    and tr8_private.v5_status(v_user)->>'reason'='provisioning_unknown','expired lease exposes real uncertainty for recovery');
  update tr8_private.google_jobs set state='pending',lease_token=null,lease_expires_at=null where id=v_job;
  perform pg_temp.ps_assert(tr8_private.v5_status(v_user)->>'state'='provisioning_unknown','pending work alone is not a live provision lease');
  insert into tr8_private.google_jobs(connection_id,generation,kind,state,lease_token,lease_expires_at,attempts)
    values(v_connection,1,'revoke','leased',gen_random_uuid(),clock_timestamp()+interval '60 seconds',1) returning id into v_other_job;
  perform pg_temp.ps_assert(tr8_private.v5_status(v_user)->>'state'='provisioning_unknown','a live lease for another job kind does not mask uncertainty');
  update tr8_private.google_jobs set state='cancelled',lease_token=null,lease_expires_at=null where id=v_other_job;
  update tr8_private.google_jobs set generation=2,state='leased',lease_token=v_token,lease_expires_at=clock_timestamp()+interval '60 seconds' where id=v_job;
  perform pg_temp.ps_assert(tr8_private.v5_status(v_user)->>'state'='provisioning_unknown','a lease for another generation does not mask uncertainty');
  update tr8_private.google_jobs set generation=1,state='unknown',lease_token=null,lease_expires_at=null,finished_at=clock_timestamp() where id=v_job;
  perform pg_temp.ps_assert(tr8_private.v5_status(v_user)->>'state'='provisioning_unknown'
    and tr8_private.v5_status(v_user)->>'failed'='1','terminal unknown job remains a visible recovery state');

  update tr8_private.google_jobs set state='leased',lease_token=v_token,lease_expires_at=clock_timestamp()+interval '60 seconds',finished_at=null where id=v_job;
  update tr8_private.google_connections set state='error',reason='permanent_failure' where id=v_connection;
  perform pg_temp.ps_assert(tr8_private.v5_status(v_user)->>'state'='error'
    and tr8_private.v5_status(v_user)->>'reason'='permanent_failure','live provision work does not hide a different connection error');
  update tr8_private.google_connections set state='provisioning_unknown',reason='provisioning_unknown' where id=v_connection;
  update tr8_private.google_config set configured=false where singleton;
  perform pg_temp.ps_assert(tr8_private.v5_status(v_user)->>'reason'='config_pending','configuration gate retains precedence over the transient projection');
  update tr8_private.google_config set configured=true where singleton;

  perform pg_temp.ps_assert(tr8_private.v5_finish(v_job,v_token,'{"outcome":"succeeded","calendar_id":"synthetic-confirmed@group.calendar.google.com"}'),'simulated known provider success confirms the calendar');
  perform pg_temp.ps_assert(tr8_private.v5_status(v_user)->>'state'='connected'
    and tr8_private.v5_status(v_user)->'reason'='null'::jsonb,'confirmed calendar success exposes connected without stale errors');
  perform pg_temp.ps_assert((select state='connected' and calendar_id='synthetic-confirmed@group.calendar.google.com' from tr8_private.google_connections where id=v_connection),'success remains durable and distinct from the transient projection');
  perform pg_temp.ps_assert((select array_agg(k order by k)=array['configured','failed','generation','last_sync_at','pending','reason','state','version'] from jsonb_object_keys(tr8_private.v5_status(v_user)) as keys(k)),'status response keeps its existing closed shape');
  perform pg_temp.ps_assert(not has_function_privilege('anon','tr8_private.v5_status(uuid)','EXECUTE')
    and not has_function_privilege('authenticated','tr8_private.v5_status(uuid)','EXECUTE')
    and not has_function_privilege('service_role','tr8_private.v5_status(uuid)','EXECUTE'),'private arbitrary-user helper remains inaccessible');
  perform pg_temp.ps_assert((select not prosecdef from pg_proc where oid='public.tr8_v2_get_google_status()'::regprocedure),'public status wrapper remains invoker');
end; $$;
select current_setting('tr8.provisioning_status_assertions')::integer assertions_passed,'Transient provisioning projection and durable uncertainty fences passed' result;
rollback;
