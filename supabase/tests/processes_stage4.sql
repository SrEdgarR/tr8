-- Stage 4A adversarial SQL. Disposable test project only. All fixtures roll back.
-- Sequence gaps are expected; never rewind the shared task identity sequence.
begin;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
select set_config('tr8.stage4_test_count','0',true);
create temporary table tr8_s4_existing on commit drop as
select 'projects'::text entity,coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb) payload from public.tr8_workspace_projects p
union all select 'tasks',coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.tr8_workspace_tasks t
union all select 'users',coalesce(jsonb_agg(to_jsonb(a) order by user_id),'[]'::jsonb) from tr8_private.app_users a;
create temporary table tr8_s4_runtime(key text primary key,value jsonb) on commit drop;
create function pg_temp.s4_assert(p_ok boolean,p_label text)
returns void language plpgsql security invoker set search_path='' as $$ begin
  if p_ok is distinct from true then raise exception 'Assertion failed: %',p_label; end if;
  perform set_config('tr8.stage4_test_count',(current_setting('tr8.stage4_test_count')::integer+1)::text,true);
end; $$;
create function pg_temp.s4_error(p_sql text,p_states text[],p_label text)
returns void language plpgsql security invoker set search_path='' as $$ begin
  begin execute p_sql;
  exception when others then
    if sqlstate=any(p_states) then perform pg_temp.s4_assert(true,p_label); return; end if;
    raise exception 'Assertion failed: %; expected %, received % (%)',p_label,p_states,sqlstate,sqlerrm;
  end;
  raise exception 'Assertion failed: %; operation unexpectedly succeeded',p_label;
end; $$;
create function pg_temp.s4_actor(p_id uuid)
returns void language plpgsql security invoker set search_path='' as $$ begin
  perform set_config('request.jwt.claim.sub',coalesce(p_id::text,''),true);
  perform set_config('request.jwt.claims',case when p_id is null then '{}' else jsonb_build_object('sub',p_id,'role','authenticated','session_id',p_id,
    'user_metadata',jsonb_build_object('role','Owner','permissions',array['*']))::text end,true);
end; $$;
create function pg_temp.s4_put(p_key text,p_value jsonb)
returns void language sql security invoker set search_path='' as $$ insert into pg_temp.tr8_s4_runtime values(p_key,p_value) on conflict(key) do update set value=excluded.value; $$;
create function pg_temp.s4_get(p_key text)
returns jsonb language sql security invoker set search_path='' as $$ select value from pg_temp.tr8_s4_runtime where key=p_key; $$;
create function pg_temp.s4_id(p_key text)
returns uuid language sql security invoker set search_path='' as $$ select (pg_temp.s4_get(p_key)->>'id')::uuid; $$;
do $$ begin execute format('grant usage on schema %I to anon,authenticated',pg_my_temp_schema()::regnamespace::text); end $$;
grant select,insert,update on pg_temp.tr8_s4_runtime to authenticated;
grant execute on function pg_temp.s4_assert(boolean,text),pg_temp.s4_error(text,text[],text),pg_temp.s4_actor(uuid),
  pg_temp.s4_put(text,jsonb),pg_temp.s4_get(text),pg_temp.s4_id(text) to anon,authenticated;

-- Quarantine pre-existing test jobs only inside this rollback transaction.
update tr8_private.process_jobs set available_at=clock_timestamp()+interval '1 year',
  lease_expires_at=case when state='leased' then clock_timestamp()+interval '1 year' else lease_expires_at end
where state in ('pending','retry','leased');
update tr8_private.process_runtime set day=(clock_timestamp() at time zone 'UTC')::date,used_today=0,
  month=date_trunc('month',clock_timestamp() at time zone 'UTC')::date,used_month=0 where singleton;

insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select ('f4000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'authenticated','authenticated','tr8-stage4-'||n||'@example.test',
  statement_timestamp(),'{}','{"role":"Owner"}',statement_timestamp(),statement_timestamp() from generate_series(1,4) n;
-- Sessions are real fixtures; JWT/session binding is part of authorization.
insert into auth.sessions(id,user_id,created_at,updated_at)
select id,id,statement_timestamp(),statement_timestamp() from auth.users where id::text like 'f4000000%';
insert into tr8_private.app_users(user_id,enabled,display_name)
select ('f4000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,n<>3,'Synthetic stage 4 '||n from generate_series(1,3) n;

do $$ declare t text; f record; begin
  perform pg_temp.s4_assert((select not external_invites_enabled from tr8_private.app_config where singleton),'external signup gate remains off');
  foreach t in array array['process_outbox','process_jobs','process_runtime','process_attempts'] loop
    perform pg_temp.s4_assert((select relrowsecurity from pg_class where oid=('tr8_private.'||t)::regclass),'RLS enabled on '||t);
    perform pg_temp.s4_assert(not has_table_privilege('anon','tr8_private.'||t,'SELECT,INSERT,UPDATE,DELETE'),'anonymous table boundary '||t);
    perform pg_temp.s4_assert(not has_table_privilege('authenticated','tr8_private.'||t,'SELECT,INSERT,UPDATE,DELETE'),'authenticated table boundary '||t);
    perform pg_temp.s4_assert(not has_table_privilege('service_role','tr8_private.'||t,'SELECT,INSERT,UPDATE,DELETE'),'service role table boundary '||t);
  end loop;
  for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='tr8_private' and p.proname like 'v4_%' loop
    perform pg_temp.s4_assert(not has_function_privilege('anon',f.signature,'EXECUTE'),'anonymous helper denied '||f.proname);
    if f.proname<>'v4_get_process_status' then
      perform pg_temp.s4_assert(not has_function_privilege('authenticated',f.signature,'EXECUTE'),'authenticated worker denied '||f.proname);
      perform pg_temp.s4_assert(not has_function_privilege('service_role',f.signature,'EXECUTE'),'service worker denied '||f.proname);
    end if;
  end loop;
  perform pg_temp.s4_assert(not has_function_privilege('anon','public.tr8_v2_get_process_status(uuid)','EXECUTE'),'anonymous status denied');
  perform pg_temp.s4_assert((select not prosecdef from pg_proc where oid='public.tr8_v2_get_process_status(uuid)'::regprocedure),'public status is invoker');
  perform pg_temp.s4_assert((select count(*)=2 from cron.job where jobname in ('tr8-process-worker','tr8-process-maintenance') and active),'both internal schedules installed');
  perform pg_temp.s4_assert((select command like '%statement_timeout%' and command like '%where exists%' from cron.job where jobname='tr8-process-worker'),'cron has top-level timeout and no-work guard');
end; $$;
set local role authenticated;
select pg_temp.s4_actor('f4000000-0000-4000-8000-000000000001');
select pg_temp.s4_put('context',public.tr8_v2_get_context());
select pg_temp.s4_put('personal',jsonb_build_object('id',pg_temp.s4_get('context')->>'personal_workspace_id'));
select pg_temp.s4_put('team',public.tr8_v2_create_team('b4000000-0000-4000-8000-000000000001','Stage 4 team'));
select pg_temp.s4_put('project',to_jsonb(public.tr8_v2_create_project(pg_temp.s4_id('team'),'a4000000-0000-4000-8000-000000000001','NEVER IN JOB PAYLOAD','SECRET DESCRIPTION','#5A67D8','active')));
select pg_temp.s4_put('task',to_jsonb(public.tr8_v2_create_task(pg_temp.s4_id('team'),'e4000000-0000-4000-8000-000000000001',pg_temp.s4_id('project'),'PRIVATE TITLE','PRIVATE NOTES','todo','none',null,'2026-11-01')));
select pg_temp.s4_assert((public.tr8_v2_get_process_status(pg_temp.s4_id('team'))->'counts'->>'pending')::integer=2,'domain changes immediately expose own durable pending work');
select pg_temp.s4_assert(public.tr8_v2_get_process_status(pg_temp.s4_id('team'))->'channels'='{"email":false,"google":false}'::jsonb,'external channels disabled');
select pg_temp.s4_assert(jsonb_array_length(public.tr8_v2_get_process_status()->'jobs')=0,'null status scope is own personal workspace');
select pg_temp.s4_error('select tr8_private.v4_claim_jobs(1)',array['42501'],'public client cannot claim');
select pg_temp.s4_error('select tr8_private.v4_run_worker()',array['42501'],'public client cannot wake worker');
select pg_temp.s4_error('select * from tr8_private.process_jobs',array['42501'],'public client cannot read lease tokens');
select pg_temp.s4_actor('f4000000-0000-4000-8000-000000000002');
select pg_temp.s4_error('select public.tr8_v2_get_process_status(pg_temp.s4_id(''team''))',array['PT404'],'cross-workspace status denied');
select pg_temp.s4_actor('f4000000-0000-4000-8000-000000000003');
select pg_temp.s4_error('select public.tr8_v2_get_process_status()',array['42501'],'disabled account status denied');
select pg_temp.s4_actor('f4000000-0000-4000-8000-000000000004');
select pg_temp.s4_error('select public.tr8_v2_get_process_status()',array['42501'],'unenabled Auth user denied despite forged metadata');
reset role;
select pg_temp.s4_actor('f4000000-0000-4000-8000-000000000001');

do $$ declare v_before integer; v_version integer; begin
  select count(*) into v_before from tr8_private.process_outbox;
  select version into v_version from public.tr8_workspace_tasks where id=pg_temp.s4_id('task');
  begin
    perform public.tr8_v2_update_task(pg_temp.s4_id('team'),pg_temp.s4_id('task'),v_version,'{"title":"ROLLBACK TITLE"}');
    raise exception using errcode='P0400',message='Simulated failure after producer';
  exception when sqlstate 'P0400' then null; end;
  perform pg_temp.s4_assert((select count(*)=v_before from tr8_private.process_outbox),'failed domain transaction leaves no outbox residue');
  perform pg_temp.s4_assert((select version=v_version and title='PRIVATE TITLE' from public.tr8_workspace_tasks where id=pg_temp.s4_id('task')),'failed transaction preserves content and version');
  perform pg_temp.s4_assert(not exists(select 1 from tr8_private.process_outbox where to_jsonb(process_outbox)::text like '%PRIVATE TITLE%' or to_jsonb(process_outbox)::text like '%SECRET DESCRIPTION%'),'outbox has metadata only');
  perform pg_temp.s4_assert(not exists(select 1 from tr8_private.process_jobs where to_jsonb(process_jobs)::text like '%PRIVATE%'),'jobs contain no content');
end; $$;

-- Older entity revisions are cancelled; latest desired revision is processed.
select pg_temp.s4_put('task',to_jsonb(public.tr8_v2_update_task(pg_temp.s4_id('team'),pg_temp.s4_id('task'),1,'{"due_date":"2026-11-02"}')));
select pg_temp.s4_assert((tr8_private.v4_run_worker()->>'external_deliveries')::integer=0,'worker explicitly reports zero external deliveries');
select pg_temp.s4_assert((select j.state='cancelled' and j.reason='superseded' from tr8_private.process_jobs j join tr8_private.process_outbox e on e.id=j.outbox_id where e.entity_id=pg_temp.s4_id('task') and e.entity_version=1),'obsolete version cancelled');
select pg_temp.s4_assert((select j.state='succeeded' and j.reason='reconciled' from tr8_private.process_jobs j join tr8_private.process_outbox e on e.id=j.outbox_id where e.entity_id=pg_temp.s4_id('task') and e.entity_version=2),'latest revision internally reconciled');
select pg_temp.s4_put('empty-runtime',(select to_jsonb(r) from tr8_private.process_runtime r));
select tr8_private.v4_run_worker();
select pg_temp.s4_assert((select to_jsonb(r)=pg_temp.s4_get('empty-runtime') from tr8_private.process_runtime r),'empty worker does not mutate counters or heartbeat');
select pg_temp.s4_error('select tr8_private.v4_claim_jobs(0)',array['22023'],'zero batch rejected');
select pg_temp.s4_error('select tr8_private.v4_claim_jobs(21)',array['22023'],'oversized batch rejected');
select pg_temp.s4_error('select tr8_private.v4_claim_jobs(null)',array['22023'],'null batch rejected');

-- Two-phase claims, wall-clock expiry and stale token fencing.
select pg_temp.s4_put('task',to_jsonb(public.tr8_v2_update_task(pg_temp.s4_id('team'),pg_temp.s4_id('task'),2,'{"priority":"high"}')));
select pg_temp.s4_put('claim',tr8_private.v4_claim_jobs(1)->0);
select pg_temp.s4_assert(pg_temp.s4_get('claim')->>'attempt'='1','claim reserves first attempt');
select pg_temp.s4_assert(jsonb_array_length(tr8_private.v4_claim_jobs(20))=0,'live lease cannot be claimed twice');
select pg_temp.s4_assert(not tr8_private.v4_finish_job(pg_temp.s4_id('claim'),gen_random_uuid(),'succeeded'),'wrong token rejected');
select pg_temp.s4_error('select tr8_private.v4_finish_job(pg_temp.s4_id(''claim''),(pg_temp.s4_get(''claim'')->>''lease_token'')::uuid,''retry'',-1)',array['22023'],'negative Retry-After rejected');
select pg_temp.s4_error('select tr8_private.v4_finish_job(pg_temp.s4_id(''claim''),(pg_temp.s4_get(''claim'')->>''lease_token'')::uuid,''retry'',21601)',array['22023'],'oversized Retry-After rejected');
select pg_temp.s4_error('select tr8_private.v4_finish_job(pg_temp.s4_id(''claim''),(pg_temp.s4_get(''claim'')->>''lease_token'')::uuid,''succeeded'',1)',array['22023'],'retry delay cannot alter successful job');
select pg_temp.s4_error('select tr8_private.v4_finish_job(pg_temp.s4_id(''claim''),(pg_temp.s4_get(''claim'')->>''lease_token'')::uuid,''delivered'')',array['22023'],'unsupported delivery outcome rejected');
update tr8_private.process_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=pg_temp.s4_id('claim');
select pg_temp.s4_assert(not tr8_private.v4_finish_job(pg_temp.s4_id('claim'),(pg_temp.s4_get('claim')->>'lease_token')::uuid,'succeeded'),'expired token cannot finish even in same transaction');
select pg_temp.s4_put('reclaim',tr8_private.v4_claim_jobs(1)->0);
select pg_temp.s4_assert(pg_temp.s4_id('reclaim')=pg_temp.s4_id('claim') and pg_temp.s4_get('reclaim')->>'attempt'='2','expired durable job recovered');
select pg_temp.s4_assert(pg_temp.s4_get('reclaim')->>'lease_token'<>pg_temp.s4_get('claim')->>'lease_token','reclaim creates new lease token');
select pg_temp.s4_assert(not tr8_private.v4_finish_job(pg_temp.s4_id('claim'),(pg_temp.s4_get('claim')->>'lease_token')::uuid,'succeeded'),'old token fenced after recovery');
select pg_temp.s4_assert(tr8_private.v4_finish_job(pg_temp.s4_id('reclaim'),(pg_temp.s4_get('reclaim')->>'lease_token')::uuid,'retry',120),'temporary failure saved');
select pg_temp.s4_assert((select state='retry' and available_at>=clock_timestamp()+interval '115 seconds' and available_at<=clock_timestamp()+interval '125 seconds' from tr8_private.process_jobs where id=pg_temp.s4_id('reclaim')),'Retry-After respected');
select pg_temp.s4_assert(jsonb_array_length(tr8_private.v4_claim_jobs(20))=0,'future retry not claimed');
update tr8_private.process_jobs set available_at=clock_timestamp()-interval '1 second' where id=pg_temp.s4_id('reclaim');
select pg_temp.s4_put('unknown',tr8_private.v4_claim_jobs(1)->0);
select pg_temp.s4_assert(tr8_private.v4_finish_job(pg_temp.s4_id('unknown'),(pg_temp.s4_get('unknown')->>'lease_token')::uuid,'unknown'),'ambiguous outcome recorded');
select pg_temp.s4_assert(jsonb_array_length(tr8_private.v4_claim_jobs(20))=0,'unknown outcome is never automatically resent');

-- Revisions revoke already-leased work; owner-account disabling is live too.
select pg_temp.s4_put('task',to_jsonb(public.tr8_v2_update_task(pg_temp.s4_id('team'),pg_temp.s4_id('task'),3,'{"priority":"low"}')));
select pg_temp.s4_put('revoked',tr8_private.v4_claim_jobs(1)->0);
update tr8_private.workspace_authz_state set version=version+1 where workspace_id=pg_temp.s4_id('team');
select pg_temp.s4_assert(tr8_private.v4_finish_job(pg_temp.s4_id('revoked'),(pg_temp.s4_get('revoked')->>'lease_token')::uuid,'succeeded'),'revoked claim settled safely');
select pg_temp.s4_assert((select state='cancelled' and reason='access_changed' from tr8_private.process_jobs where id=pg_temp.s4_id('revoked')),'access revision fences stale internal success');
select tr8_private.v4_run_worker();
select pg_temp.s4_put('task',to_jsonb(public.tr8_v2_update_task(pg_temp.s4_id('team'),pg_temp.s4_id('task'),4,'{"priority":"urgent"}')));
select pg_temp.s4_put('disabled',tr8_private.v4_claim_jobs(1)->0);
update tr8_private.app_users set enabled=false where user_id='f4000000-0000-4000-8000-000000000001';
select pg_temp.s4_assert(tr8_private.v4_finish_job(pg_temp.s4_id('disabled'),(pg_temp.s4_get('disabled')->>'lease_token')::uuid,'succeeded'),'disabled actor job settled');
select pg_temp.s4_assert((select state='cancelled' and reason='access_changed' from tr8_private.process_jobs where id=pg_temp.s4_id('disabled')),'disabled account cannot have pending content work reconciled');
update tr8_private.app_users set enabled=true where user_id='f4000000-0000-4000-8000-000000000001';

-- Hard global budgets stop claims without deleting durable domain changes.
select pg_temp.s4_put('task',to_jsonb(public.tr8_v2_update_task(pg_temp.s4_id('team'),pg_temp.s4_id('task'),5,'{"priority":"none"}')));
update tr8_private.process_runtime set used_today=daily_limit where singleton;
select pg_temp.s4_assert(jsonb_array_length(tr8_private.v4_claim_jobs(20))=0,'daily hard budget stops reservations');
select pg_temp.s4_assert((select count(*)=1 from tr8_private.process_jobs j join tr8_private.process_outbox e on e.id=j.outbox_id where e.entity_id=pg_temp.s4_id('task') and e.entity_version=6 and j.state='pending'),'budget does not lose queued domain event');
select pg_temp.s4_assert((public.tr8_v2_get_process_status(pg_temp.s4_id('team'))->'budget'->>'blocked')::boolean,'budget saturation visible');
update tr8_private.process_runtime set day=day-1 where singleton;
select pg_temp.s4_put('budget-reset',tr8_private.v4_claim_jobs(1)->0);
select pg_temp.s4_assert(pg_temp.s4_get('budget-reset') is not null,'UTC day rollover releases daily reservation budget');
select tr8_private.v4_finish_job(pg_temp.s4_id('budget-reset'),(pg_temp.s4_get('budget-reset')->>'lease_token')::uuid,'succeeded');
select pg_temp.s4_put('task',to_jsonb(public.tr8_v2_update_task(pg_temp.s4_id('team'),pg_temp.s4_id('task'),6,'{"status":"done"}')));
update tr8_private.process_runtime set used_month=monthly_limit where singleton;
select pg_temp.s4_assert(jsonb_array_length(tr8_private.v4_claim_jobs(20))=0,'monthly hard budget stops reservations');
update tr8_private.process_runtime set month=month-interval '1 month' where singleton;
select pg_temp.s4_put('month-reset',tr8_private.v4_claim_jobs(1)->0);
select pg_temp.s4_assert(pg_temp.s4_get('month-reset') is not null,'month rollover releases monthly reservation budget');
select tr8_private.v4_finish_job(pg_temp.s4_id('month-reset'),(pg_temp.s4_get('month-reset')->>'lease_token')::uuid,'succeeded');

-- Eight attempts maximum; permanent/unknown failures are not retried.
select pg_temp.s4_put('task',to_jsonb(public.tr8_v2_update_task(pg_temp.s4_id('team'),pg_temp.s4_id('task'),7,'{"status":"todo"}')));
do $$ declare i integer; c jsonb; begin
  for i in 1..8 loop
    c:=tr8_private.v4_claim_jobs(1)->0;
    perform pg_temp.s4_assert((c->>'attempt')::integer=i,'bounded retry attempt '||i);
    perform pg_temp.s4_assert(tr8_private.v4_finish_job((c->>'id')::uuid,(c->>'lease_token')::uuid,'retry'),'retry finish '||i);
    update tr8_private.process_jobs set available_at=clock_timestamp()-interval '1 second' where id=(c->>'id')::uuid;
  end loop;
  perform pg_temp.s4_assert((select state='dead' and attempts=8 and reason='attempt_limit' from tr8_private.process_jobs where id=(c->>'id')::uuid),'automatic retry limit becomes dead');
  perform pg_temp.s4_assert(jsonb_array_length(tr8_private.v4_claim_jobs(20))=0,'dead job never automatically retried');
end; $$;

-- Deletion leaves reference tombstone; no foreign key cascades erase cleanup.
select public.tr8_v2_delete_task(pg_temp.s4_id('team'),pg_temp.s4_id('task'),8);
select pg_temp.s4_assert((select count(*)=1 from tr8_private.process_outbox where entity_id=pg_temp.s4_id('task') and event_kind='task.deleted' and entity_version=9),'deletion tombstone durable');
select tr8_private.v4_run_worker();
select pg_temp.s4_assert((select j.state='succeeded' and j.reason='reconciled' from tr8_private.process_jobs j join tr8_private.process_outbox e on e.id=j.outbox_id where e.entity_id=pg_temp.s4_id('task') and e.event_kind='task.deleted'),'deletion internally reconciled without content');
select pg_temp.s4_assert(not exists(select 1 from tr8_private.process_jobs where channel<>'internal'),'no unsupported provider jobs fabricated');

-- Retention touches only terminal operational metadata, never unresolved work.
update tr8_private.process_jobs set finished_at=clock_timestamp()-interval '40 days' where id in
  (select j.id from tr8_private.process_jobs j join tr8_private.process_outbox e on e.id=j.outbox_id where e.workspace_id=pg_temp.s4_id('team') and j.state in ('succeeded','cancelled','dead','unknown'));
select pg_temp.s4_put('unresolved',(select coalesce(jsonb_agg(to_jsonb(j) order by j.id),'[]') from tr8_private.process_jobs j join tr8_private.process_outbox e on e.id=j.outbox_id where e.workspace_id=pg_temp.s4_id('team') and j.state in ('dead','unknown')));
select pg_temp.s4_assert(tr8_private.v4_maintain_processes()>0,'terminal operational metadata pruned after retention');
select pg_temp.s4_assert((select coalesce(jsonb_agg(to_jsonb(j) order by j.id),'[]')=pg_temp.s4_get('unresolved') from tr8_private.process_jobs j join tr8_private.process_outbox e on e.id=j.outbox_id where e.workspace_id=pg_temp.s4_id('team') and j.state in ('dead','unknown')),'unknown and dead outcomes survive maintenance');
select pg_temp.s4_assert(not exists(select 1 from tr8_private.process_jobs j left join tr8_private.process_outbox e on e.id=j.outbox_id where e.id is null),'maintenance leaves no orphan jobs');
select pg_temp.s4_assert((select count(*)=2 from cron.job where jobname in ('tr8-process-worker','tr8-process-maintenance')),'retention keeps scheduler definitions');

-- Existing application records are byte-for-field unchanged by the suite.
select pg_temp.s4_assert(not exists(select 1 from tr8_s4_existing x where x.entity='projects' and x.payload is distinct from
  (select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from public.tr8_workspace_projects p where p.id::text not like 'a4000000-0000-4000-8000-%')),'historical projects preserved');
select pg_temp.s4_assert(not exists(select 1 from tr8_s4_existing x where x.entity='tasks' and x.payload is distinct from
  (select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.tr8_workspace_tasks t where t.id::text not like 'e4000000-0000-4000-8000-%')),'historical tasks preserved');
select current_setting('tr8.stage4_test_count')::integer as stage4_assertions;
rollback;
