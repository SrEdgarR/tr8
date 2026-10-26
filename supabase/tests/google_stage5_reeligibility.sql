-- TEST only. Simulates confirmed provider receipts without any Google HTTP.
-- All synthetic rows, queue changes and server configuration roll back.
begin;
select set_config('tr8.reeligibility_assertions','0',true);
create temporary table tr8_reeligibility_before on commit drop as select
  (select to_jsonb(c) from tr8_private.google_config c where singleton) config,
  (select jsonb_agg(jsonb_build_object('name',jobname,'active',active,'command',command) order by jobname)
    from cron.job where jobname in ('tr8-google-worker','tr8-google-maintenance')) schedules,
  (select to_jsonb(c) from tr8_private.app_config c where singleton) app_config,
  (select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb) from public.tr8_workspace_projects p) projects,
  (select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.tr8_workspace_tasks t) tasks;
create function pg_temp.r_assert(p_ok boolean,p_label text) returns void language plpgsql security invoker set search_path='' as $$ begin
  if p_ok is distinct from true then raise exception 'Reeligibility assertion failed: %',p_label;end if;
  perform set_config('tr8.reeligibility_assertions',(current_setting('tr8.reeligibility_assertions')::integer+1)::text,true);
end; $$;
do $$
declare v_user uuid:='f5200000-0000-4000-8000-000000000001'; v_workspace uuid;
  v_project uuid:='a5200000-0000-4000-8000-000000000001'; v_task uuid:='e5200000-0000-4000-8000-000000000001';
  v_missing uuid:='e5200000-0000-4000-8000-000000000002'; v_retained uuid:='e5200000-0000-4000-8000-000000000003';
  v_connection uuid; v_scan uuid; v_link uuid; v_old text; v_new text; v_missing_id text; v_retained_id text;
  v_task_version integer; v_delete uuid; v_token uuid:=gen_random_uuid(); v_queued bigint;
begin
  perform pg_temp.r_assert((select not configured and not scheduler_enabled from tr8_private.google_config where singleton),'provider configuration is disabled before fixture');
  perform pg_temp.r_assert(not exists(select 1 from cron.job where jobname in ('tr8-google-worker','tr8-google-maintenance') and active),'Google schedules are inactive');
  insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    values(v_user,'authenticated','authenticated','tr8-reeligibility@example.test',clock_timestamp(),'{}','{}',clock_timestamp(),clock_timestamp());
  insert into auth.sessions(id,user_id,created_at,updated_at) values(v_user,v_user,now(),now());
  insert into tr8_private.app_users(user_id,enabled,display_name) values(v_user,true,'Synthetic reeligibility');
  perform set_config('request.jwt.claim.sub',v_user::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_user,'role','authenticated','session_id',v_user)::text,true);
  v_workspace:=(public.tr8_v2_get_context()->>'personal_workspace_id')::uuid;
  perform public.tr8_v2_create_project(v_workspace,v_project,'TR8 synthetic reeligibility','Not sent to Google','#5A67D8','active');
  perform public.tr8_v2_create_task(v_workspace,v_task,v_project,'Synthetic date cycle','', 'todo','none',null,'2026-11-05');
  perform public.tr8_v2_create_task(v_workspace,v_missing,v_project,'Synthetic manually deleted event','', 'todo','none',null,'2026-11-06');
  perform public.tr8_v2_create_task(v_workspace,v_retained,v_project,'Synthetic retained event','', 'todo','none',null,'2026-11-07');
  insert into tr8_private.google_connections(user_id,generation,state,calendar_id,credential_envelope)
    values(v_user,1,'connected','synthetic-reeligibility@group.calendar.google.com',
      '{"v":1,"kid":"synthetic","iv":"AAAAAAAAAAAAAAAA","ciphertext":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}') returning id into v_connection;
  v_scan:=tr8_private.v5_enqueue(v_connection,'reconcile_scan');
  perform tr8_private.v5_scan(v_scan);
  select id,event_id into strict v_link,v_old from tr8_private.google_event_links where connection_id=v_connection and task_id=v_task;
  select event_id into strict v_missing_id from tr8_private.google_event_links where connection_id=v_connection and task_id=v_missing;
  select event_id into strict v_retained_id from tr8_private.google_event_links where connection_id=v_connection and task_id=v_retained;
  perform pg_temp.r_assert((select count(*)=3 from tr8_private.google_event_links where connection_id=v_connection),'dated synthetic tasks have one link each');
  -- Initial known-success fixture, followed by a real date-removal RPC.
  update tr8_private.google_event_links set state='synced',synced_hash=desired_hash where id=v_link;
  update tr8_private.google_jobs set state='succeeded',finished_at=clock_timestamp() where connection_id=v_connection and kind='upsert';
  select version into strict v_task_version from public.tr8_workspace_tasks where id=v_task;
  perform public.tr8_v2_update_task(v_workspace,v_task,v_task_version,'{"due_date":null}');
  perform tr8_private.v5_enqueue(v_connection,'reconcile_scan');
  perform tr8_private.v5_scan(v_scan);
  perform pg_temp.r_assert((select state='deleting' from tr8_private.google_event_links where id=v_link),'removing every date requests cleanup');
  select id into strict v_delete from tr8_private.google_jobs where connection_id=v_connection and kind='delete' and link_id=v_link;
  update tr8_private.google_jobs set state='leased',lease_token=v_token,lease_expires_at=clock_timestamp()+interval '60 seconds',attempts=1 where id=v_delete;
  perform pg_temp.r_assert(tr8_private.v5_finish(v_delete,v_token,'{"outcome":"succeeded"}'),'simulated confirmed provider deletion accepted with valid lease');
  perform pg_temp.r_assert((select state='deleted' and event_id=v_old from tr8_private.google_event_links where id=v_link),'confirmed deletion keeps its durable tombstone');
  -- Manual Google deletion and intentional retention must not become automatic
  -- rebuilds merely because another task changes or a scan runs.
  update tr8_private.google_event_links set state='remote_missing' where connection_id=v_connection and task_id=v_missing;
  update tr8_private.google_event_links set state='retained' where connection_id=v_connection and task_id=v_retained;
  select desired_revision into v_queued from tr8_private.google_jobs where connection_id=v_connection and kind='upsert' and link_id=(select id from tr8_private.google_event_links where connection_id=v_connection and task_id=v_missing);
  select version into strict v_task_version from public.tr8_workspace_tasks where id=v_task;
  perform public.tr8_v2_update_task(v_workspace,v_task,v_task_version,'{"due_date":"2026-11-08"}');
  perform tr8_private.v5_enqueue(v_connection,'reconcile_scan');
  perform tr8_private.v5_scan(v_scan);
  select event_id into strict v_new from tr8_private.google_event_links where id=v_link;
  perform pg_temp.r_assert(v_new<>v_old and v_new ~ '^[0-9a-f]{32}$','eligibility restored after cleanup allocates a new compatible ID');
  perform pg_temp.r_assert((select state='pending' and synced_hash is null and cleanup_not_before is null from tr8_private.google_event_links where id=v_link),'new incarnation starts unsynced with its own cleanup barrier');
  perform pg_temp.r_assert((select v_old=any(retired_event_ids) from tr8_private.google_event_links where id=v_link),'confirmed old remote identifier remains recorded');
  perform pg_temp.r_assert((select count(*)=1 from tr8_private.google_event_links where connection_id=v_connection and task_id=v_task),'link identity is stable without duplicate task mappings');
  perform pg_temp.r_assert((select state='pending' and attempts=0 from tr8_private.google_jobs where connection_id=v_connection and kind='upsert' and link_id=v_link),'new remote incarnation has durable pending work');
  perform pg_temp.r_assert((select state='remote_missing' and event_id=v_missing_id and cardinality(retired_event_ids)=0 from tr8_private.google_event_links where connection_id=v_connection and task_id=v_missing),'manually missing event is not automatically rebuilt');
  perform pg_temp.r_assert((select desired_revision=v_queued from tr8_private.google_jobs where connection_id=v_connection and kind='upsert' and link_id=(select id from tr8_private.google_event_links where connection_id=v_connection and task_id=v_missing)),'missing event does not gain an automatic upsert request');
  perform pg_temp.r_assert((select state='retained' and event_id=v_retained_id from tr8_private.google_event_links where connection_id=v_connection and task_id=v_retained),'retained copy is left untouched');
  perform tr8_private.v5_enqueue(v_connection,'reconcile_scan');
  perform tr8_private.v5_scan(v_scan);
  perform pg_temp.r_assert((select event_id=v_new and cardinality(retired_event_ids)=1 from tr8_private.google_event_links where id=v_link),'repeated scans do not allocate more remote incarnations');
  perform pg_temp.r_assert((select config from pg_temp.tr8_reeligibility_before)=(select to_jsonb(c) from tr8_private.google_config c where singleton),'configuration, counters and wake state unchanged');
  perform pg_temp.r_assert((select schedules from pg_temp.tr8_reeligibility_before)=(select jsonb_agg(jsonb_build_object('name',jobname,'active',active,'command',command) order by jobname) from cron.job where jobname in ('tr8-google-worker','tr8-google-maintenance')),'scheduler remains inactive and unchanged');
  perform pg_temp.r_assert((select app_config from pg_temp.tr8_reeligibility_before)=(select to_jsonb(c) from tr8_private.app_config c where singleton),'external signup configuration unchanged');
  perform pg_temp.r_assert((select projects from pg_temp.tr8_reeligibility_before)=(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb) from public.tr8_workspace_projects p where id<>v_project),'pre-existing project fields preserved');
  perform pg_temp.r_assert((select tasks from pg_temp.tr8_reeligibility_before)=(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.tr8_workspace_tasks t where id not in (v_task,v_missing,v_retained)),'pre-existing task fields preserved');
end; $$;
select current_setting('tr8.reeligibility_assertions')::integer assertions_passed,'Confirmed deletion can become eligible again; unknown/retained copies unchanged' result;
rollback;
