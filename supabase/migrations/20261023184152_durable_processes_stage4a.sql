-- Stage 4A: transactional metadata and a bounded internal reconciliation worker.
-- No provider credentials, delivery adapters, external signups or historical
-- domain backfill. A successful internal job never means an email/event was sent.
create extension if not exists pg_cron;
lock table public.tr8_workspace_projects,public.tr8_workspace_tasks,
  tr8_private.workspace_authz_state,tr8_private.app_config in access exclusive mode nowait;
create temporary table tr8_stage4_snapshot on commit drop as
select 'public.tr8_workspace_projects'::regclass::oid projects_oid,
  'public.tr8_workspace_tasks'::regclass::oid tasks_oid,
  pg_get_serial_sequence('public.tr8_workspace_tasks','task_number')::regclass::oid sequence_oid,
  (select md5(coalesce(string_agg(to_jsonb(p)::text,E'\n' order by id),'')) from public.tr8_workspace_projects p) projects_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by id),'')) from public.tr8_workspace_tasks t) tasks_hash,
  (select jsonb_build_object('last_value',q.last_value,'is_called',q.is_called) from public.tr8_tasks_task_number_seq q) sequence_state,
  (select to_jsonb(c) from tr8_private.app_config c where singleton) app_config,
  (select jsonb_object_agg(p.oid::text,jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','tr8_private')
      and (p.proname like 'tr8_v2_%' or p.proname like 'v2_%' or p.proname like 'v3_%' or p.proname in ('guard_task','guard_project'))) old_api;

create table tr8_private.process_outbox (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  workspace_id uuid not null references tr8_private.workspaces(id) on delete restrict,
  project_id uuid,
  entity_id uuid not null,
  entity_kind text not null check(entity_kind in ('task','project','authorization')),
  event_kind text not null check(event_kind in ('task.created','task.changed','task.deleted','project.created','project.changed','project.deleted','authorization.changed')),
  entity_version bigint not null check(entity_version>0),
  entity_created_at timestamptz not null,
  authz_version bigint not null check(authz_version>0),
  actor_id uuid,
  previous_member_id uuid,
  member_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_id,entity_kind,entity_id,entity_created_at,entity_version)
);
create index tr8_process_outbox_actor on tr8_private.process_outbox(actor_id,workspace_id,created_at desc,id);
create index tr8_process_outbox_entity on tr8_private.process_outbox(workspace_id,entity_kind,entity_id,entity_created_at,entity_version desc);

create table tr8_private.process_jobs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  outbox_id uuid not null unique references tr8_private.process_outbox(id) on delete restrict,
  channel text not null default 'internal' check(channel='internal'),
  state text not null default 'pending' check(state in ('pending','leased','retry','succeeded','cancelled','unknown','dead')),
  attempts integer not null default 0 check(attempts between 0 and 8),
  available_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  reason text check(reason in ('reconciled','superseded','resource_removed','access_changed','lease_expired','temporary_failure','permanent_failure','outcome_unknown','attempt_limit','cancelled')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  check((state='leased')=(lease_token is not null and lease_expires_at is not null)),
  check((state in ('succeeded','cancelled','unknown','dead'))=(finished_at is not null))
);
create index tr8_process_jobs_due on tr8_private.process_jobs(available_at,id) where state in ('pending','retry','leased');
create index tr8_process_jobs_terminal on tr8_private.process_jobs(finished_at,id) where state in ('succeeded','cancelled');

create table tr8_private.process_runtime (
  singleton boolean primary key default true check(singleton),
  scheduler_enabled boolean not null default false,
  last_run_at timestamptz,
  last_finished_at timestamptz,
  day date not null default (clock_timestamp() at time zone 'UTC')::date,
  used_today integer not null default 0 check(used_today>=0),
  month date not null default date_trunc('month',clock_timestamp() at time zone 'UTC')::date,
  used_month integer not null default 0 check(used_month>=0),
  daily_limit integer not null default 500 check(daily_limit between 1 and 500),
  monthly_limit integer not null default 10000 check(monthly_limit between 1 and 10000)
);
insert into tr8_private.process_runtime(singleton) values(true);
-- Reservation receipts are metadata, not business audit. They distinguish empty
-- polling from real attempts and let the UI show only the caller's own usage.
create table tr8_private.process_attempts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  job_id uuid not null,
  actor_id uuid,
  workspace_id uuid not null,
  leased_at timestamptz not null default clock_timestamp()
);
create index tr8_process_attempts_actor on tr8_private.process_attempts(actor_id,workspace_id,leased_at desc);
create index tr8_process_attempts_time on tr8_private.process_attempts(leased_at,id);

do $private_tables$
declare v_table text;
begin
  foreach v_table in array array['process_outbox','process_jobs','process_runtime','process_attempts'] loop
    execute format('alter table tr8_private.%I enable row level security',v_table);
    execute format('revoke all on table tr8_private.%I from public,anon,authenticated,service_role',v_table);
  end loop;
end; $private_tables$;

create function tr8_private.v4_capture_domain()
returns trigger language plpgsql security definer set search_path='' as $$
declare r record; v_kind text; v_event text; v_version bigint; v_outbox uuid; v_previous uuid; v_project uuid; v_member uuid;
begin
  if tg_op='DELETE' then r:=old; else r:=new; end if;
  v_kind:=case when tg_table_name='tr8_workspace_tasks' then 'task' else 'project' end;
  v_event:=v_kind||case tg_op when 'INSERT' then '.created' when 'DELETE' then '.deleted' else '.changed' end;
  v_version:=r.version+case when tg_op='DELETE' then 1 else 0 end;
  if v_kind='task' then
    v_project:=r.project_id; v_member:=r.assignee_member_id;
    if tg_op<>'INSERT' then v_previous:=old.assignee_member_id; end if;
  else v_project:=r.id; end if;
  insert into tr8_private.process_outbox(workspace_id,project_id,entity_id,entity_kind,event_kind,entity_version,entity_created_at,authz_version,actor_id,previous_member_id,member_id)
    values(r.workspace_id,v_project,r.id,v_kind,v_event,v_version,r.created_at,
      (select version from tr8_private.workspace_authz_state where workspace_id=r.workspace_id),auth.uid(),v_previous,
      v_member)
    returning id into v_outbox;
  insert into tr8_private.process_jobs(outbox_id) values(v_outbox);
  return null;
end; $$;
create trigger tr8_projects_process_outbox after insert or update or delete on public.tr8_workspace_projects
  for each row execute function tr8_private.v4_capture_domain();
create trigger tr8_tasks_process_outbox after insert or update or delete on public.tr8_workspace_tasks
  for each row execute function tr8_private.v4_capture_domain();

create function tr8_private.v4_capture_authorization()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_outbox uuid;
begin
  if new.version=old.version then return null; end if;
  insert into tr8_private.process_outbox(workspace_id,entity_id,entity_kind,event_kind,entity_version,entity_created_at,authz_version,actor_id)
    values(new.workspace_id,new.workspace_id,'authorization','authorization.changed',new.version,
      (select created_at from tr8_private.workspaces where id=new.workspace_id),new.version,auth.uid()) returning id into v_outbox;
  insert into tr8_private.process_jobs(outbox_id) values(v_outbox);
  return null;
end; $$;
create trigger tr8_authorization_process_outbox after update on tr8_private.workspace_authz_state
  for each row execute function tr8_private.v4_capture_authorization();

-- Pure reference validation: never load/copy task title, description or finances.
-- Workspace revisions fence jobs produced before an access change. A later
-- authorization event handles the current state; old deliveries are not revived.
create function tr8_private.v4_job_reason(p_outbox_id uuid)
returns text language plpgsql volatile security definer set search_path='' as $$
declare e tr8_private.process_outbox; v_version bigint; v_authz bigint; v_created timestamptz;
begin
  select * into e from tr8_private.process_outbox where id=p_outbox_id;
  if not found then return 'resource_removed'; end if;
  select version into v_authz from tr8_private.workspace_authz_state where workspace_id=e.workspace_id;
  if v_authz is distinct from e.authz_version then return 'access_changed'; end if;
  if e.actor_id is not null and (not tr8_private.v2_user_live(e.actor_id)
    or not exists(select 1 from tr8_private.app_users a where a.user_id=e.actor_id and a.enabled)) then return 'access_changed'; end if;
  if e.entity_kind='authorization' then return null; end if;
  if e.entity_kind='task' then
    select version,created_at into v_version,v_created from public.tr8_workspace_tasks where workspace_id=e.workspace_id and id=e.entity_id;
  else
    select version,created_at into v_version,v_created from public.tr8_workspace_projects where workspace_id=e.workspace_id and id=e.entity_id;
  end if;
  if e.event_kind in ('task.deleted','project.deleted') then
    if v_version is not null then return 'superseded'; end if;
    return null; -- A durable tombstone is itself internal reconciliation work.
  end if;
  if v_version is null then return 'resource_removed'; end if;
  if v_created is distinct from e.entity_created_at then return 'superseded'; end if;
  if v_version<>e.entity_version then return 'superseded'; end if;
  return null;
end; $$;

-- Server-only two-phase lease API. Commit the claim before external network I/O
-- in a future adapter. Current 4A has no network adapter or public worker route.
create function tr8_private.v4_claim_jobs(p_limit integer default 20)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='500ms' as $$
declare j record; v_result jsonb:='[]'; v_count integer:=0; v_reason text; v_token uuid; v_now timestamptz;
  v_day date; v_month date; v_runtime tr8_private.process_runtime;
begin
  if p_limit is null or p_limit not between 1 and 20 then raise exception using errcode='22023',message='Invalid internal batch limit'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception using errcode='25000',message='Worker requires read committed isolation'; end if;
  -- Serializes budget reservations, but does not wait for a second worker.
  select * into v_runtime from tr8_private.process_runtime where singleton for update skip locked;
  if not found then return v_result; end if;
  v_now:=clock_timestamp(); v_day:=(v_now at time zone 'UTC')::date; v_month:=date_trunc('month',v_now at time zone 'UTC')::date;
  if v_runtime.day<>v_day then v_runtime.day:=v_day; v_runtime.used_today:=0; end if;
  if v_runtime.month<>v_month then v_runtime.month:=v_month; v_runtime.used_month:=0; end if;
  for j in select q.*,e.workspace_id,e.entity_kind,e.entity_id,e.actor_id from tr8_private.process_jobs q
    join tr8_private.process_outbox e on e.id=q.outbox_id
    where ((q.state in ('pending','retry') and q.available_at<=clock_timestamp())
      or (q.state='leased' and q.lease_expires_at<=clock_timestamp()))
    order by q.available_at,q.id limit 200 for update of q skip locked loop
    exit when v_count>=p_limit;
    v_reason:=tr8_private.v4_job_reason(j.outbox_id);
    if v_reason is not null then
      update tr8_private.process_jobs set state='cancelled',reason=v_reason,lease_token=null,lease_expires_at=null,
        updated_at=clock_timestamp(),finished_at=clock_timestamp() where id=j.id;
      continue;
    end if;
    if j.attempts>=8 then
      update tr8_private.process_jobs set state='dead',reason='attempt_limit',lease_token=null,lease_expires_at=null,
        updated_at=clock_timestamp(),finished_at=clock_timestamp() where id=j.id;
      continue;
    end if;
    if v_runtime.used_today>=v_runtime.daily_limit or v_runtime.used_month>=v_runtime.monthly_limit then exit; end if;
    -- One active lease per entity across revisions; a stale claim cannot overtake
    -- a newer one. No process lock survives outside a transaction.
    if exists(select 1 from tr8_private.process_jobs x join tr8_private.process_outbox e on e.id=x.outbox_id
      where x.id<>j.id and x.state='leased' and x.lease_expires_at>clock_timestamp()
        and (e.workspace_id,e.entity_kind,e.entity_id)=(j.workspace_id,j.entity_kind,j.entity_id)) then continue; end if;
    v_token:=gen_random_uuid();
    update tr8_private.process_jobs set state='leased',attempts=attempts+1,lease_token=v_token,
      lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp(),finished_at=null,
      reason=case when j.state='leased' then 'lease_expired' else null end where id=j.id;
    insert into tr8_private.process_attempts(job_id,actor_id,workspace_id) values(j.id,j.actor_id,j.workspace_id);
    v_runtime.used_today:=v_runtime.used_today+1; v_runtime.used_month:=v_runtime.used_month+1;
    v_count:=v_count+1;
    v_result:=v_result||jsonb_build_array(jsonb_build_object('id',j.id,'lease_token',v_token,'outbox_id',j.outbox_id,'attempt',j.attempts+1));
  end loop;
  update tr8_private.process_runtime set day=v_runtime.day,used_today=v_runtime.used_today,month=v_runtime.month,used_month=v_runtime.used_month where singleton;
  return v_result;
end; $$;

create function tr8_private.v4_finish_job(p_id uuid,p_lease_token uuid,p_outcome text,p_retry_after_seconds integer default null)
returns boolean language plpgsql volatile security definer set search_path='' set lock_timeout='500ms' as $$
declare j tr8_private.process_jobs; v_reason text; v_delay integer; v_state text;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception using errcode='25000',message='Worker requires read committed isolation'; end if;
  if p_id is null or p_lease_token is null or p_outcome is null
    or p_outcome not in ('succeeded','retry','dead','unknown','cancelled')
    or (p_retry_after_seconds is not null and (p_outcome<>'retry' or p_retry_after_seconds not between 0 and 21600)) then
    raise exception using errcode='22023',message='Invalid internal outcome';
  end if;
  select * into j from tr8_private.process_jobs where id=p_id for update;
  if not found or j.state<>'leased' or j.lease_token<>p_lease_token or j.lease_expires_at<=clock_timestamp() then return false; end if;
  v_reason:=tr8_private.v4_job_reason(j.outbox_id);
  if v_reason is not null then v_state:='cancelled';
  else
    v_state:=p_outcome;
    v_reason:=case p_outcome when 'succeeded' then 'reconciled' when 'retry' then 'temporary_failure'
      when 'dead' then 'permanent_failure' when 'unknown' then 'outcome_unknown' else 'cancelled' end;
  end if;
  if v_state='retry' and j.attempts>=8 then v_state:='dead';v_reason:='attempt_limit'; end if;
  if v_state='retry' then
    v_delay:=least(21600,greatest(coalesce(p_retry_after_seconds,0),least(21600,(30*power(2,j.attempts-1))::integer)+floor(random()*10)::integer));
  end if;
  update tr8_private.process_jobs set state=v_state,reason=v_reason,lease_token=null,lease_expires_at=null,
    available_at=case when v_state='retry' then clock_timestamp()+make_interval(secs=>v_delay) else available_at end,
    updated_at=clock_timestamp(),finished_at=case when v_state in ('succeeded','cancelled','dead','unknown') then clock_timestamp() else null end where id=p_id;
  return true;
end; $$;

create function tr8_private.v4_run_worker()
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='500ms' set statement_timeout='8s' as $$
declare v_jobs jsonb; j jsonb; v_done integer:=0;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('tr8-internal-process-worker',0)) then return jsonb_build_object('busy',true); end if;
  if not exists(select 1 from tr8_private.process_jobs where
    (state in ('pending','retry') and available_at<=clock_timestamp()) or (state='leased' and lease_expires_at<=clock_timestamp())) then
    return jsonb_build_object('internal_reconciled',0,'external_deliveries',0);
  end if;
  update tr8_private.process_runtime set last_run_at=clock_timestamp() where singleton;
  v_jobs:=tr8_private.v4_claim_jobs(20);
  for j in select value from jsonb_array_elements(v_jobs) loop
    if tr8_private.v4_finish_job((j->>'id')::uuid,(j->>'lease_token')::uuid,'succeeded') then v_done:=v_done+1; end if;
  end loop;
  update tr8_private.process_runtime set last_finished_at=clock_timestamp() where singleton;
  return jsonb_build_object('internal_reconciled',v_done,'external_deliveries',0);
end; $$;

create function tr8_private.v4_maintain_processes()
returns integer language plpgsql volatile security definer set search_path='' set lock_timeout='500ms' set statement_timeout='8s' as $$
declare v_ids uuid[]; v_count integer;
begin
  -- Only confirmed/cancelled operational records expire. Pending, leased, retry,
  -- unknown and dead records remain durable; business audit is never touched.
  select array_agg(q.id) into v_ids from(select id from tr8_private.process_jobs
    where state in ('succeeded','cancelled') and finished_at<clock_timestamp()-interval '30 days'
    order by finished_at,id limit 500 for update skip locked) q;
  with removed as(delete from tr8_private.process_jobs where id=any(v_ids) returning outbox_id)
    delete from tr8_private.process_outbox where id in(select outbox_id from removed);
  get diagnostics v_count=row_count;
  delete from tr8_private.process_attempts where id in(select id from tr8_private.process_attempts
    where leased_at<clock_timestamp()-interval '32 days' order by leased_at,id limit 1000);
  delete from cron.job_run_details where runid in(select r.runid from cron.job_run_details r join cron.job j on j.jobid=r.jobid
    where j.jobname in ('tr8-process-worker','tr8-process-maintenance') and r.end_time<clock_timestamp()-interval '7 days'
    order by r.end_time,r.runid limit 1000);
  return v_count;
end; $$;

create function tr8_private.v4_get_process_status(p_workspace_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_workspace uuid; v_counts jsonb; v_jobs jsonb; v_runtime tr8_private.process_runtime; v_today integer; v_month integer;
begin
  perform tr8_private.v2_require_actor();
  if p_workspace_id is null then
    select id into v_workspace from tr8_private.workspaces where kind='personal' and owner_id=auth.uid();
  else v_workspace:=p_workspace_id; end if;
  perform tr8_private.v2_require_workspace(v_workspace,'project.read');
  select * into strict v_runtime from tr8_private.process_runtime where singleton;
  with visible as(select j.*,e.entity_kind,e.event_kind from tr8_private.process_jobs j
    join tr8_private.process_outbox e on e.id=j.outbox_id
    where e.actor_id=auth.uid() and e.workspace_id=v_workspace
      and ((e.entity_kind='authorization') or tr8_private.v2_project_readable_for(e.workspace_id,e.project_id,auth.uid(),e.entity_kind='task'))),
  states as(select s.state,count(v.id)::integer count from unnest(array['pending','leased','retry','succeeded','cancelled','unknown','dead']) s(state)
    left join visible v on v.state=s.state group by s.state)
  select jsonb_object_agg(state,count) into v_counts from states;
  select coalesce(jsonb_agg(q.item order by q.created_at desc,q.id),'[]') into v_jobs from(
    select j.id,j.created_at,jsonb_build_object('id',j.id,'entity_kind',e.entity_kind,'event_kind',e.event_kind,'state',j.state,
      'attempts',j.attempts,'created_at',j.created_at,'available_at',j.available_at,'finished_at',j.finished_at,'reason',j.reason) item
    from tr8_private.process_jobs j join tr8_private.process_outbox e on e.id=j.outbox_id
    where e.actor_id=auth.uid() and e.workspace_id=v_workspace
      and (e.entity_kind='authorization' or tr8_private.v2_project_readable_for(e.workspace_id,e.project_id,auth.uid(),e.entity_kind='task'))
    order by j.created_at desc,j.id limit 20) q;
  select count(*) filter(where (a.leased_at at time zone 'UTC')::date=(clock_timestamp() at time zone 'UTC')::date)::integer,
    count(*)::integer into v_today,v_month from tr8_private.process_attempts a
    where a.actor_id=auth.uid() and a.workspace_id=v_workspace and a.leased_at>=date_trunc('month',clock_timestamp() at time zone 'UTC') at time zone 'UTC'
      and exists(select 1 from tr8_private.process_jobs j join tr8_private.process_outbox e on e.id=j.outbox_id where j.id=a.job_id
        and (e.entity_kind='authorization' or tr8_private.v2_project_readable_for(e.workspace_id,e.project_id,auth.uid(),e.entity_kind='task')));
  return jsonb_build_object('channels',jsonb_build_object('email',false,'google',false),
    'scheduler',jsonb_build_object('enabled',exists(select 1 from cron.job where jobname='tr8-process-worker' and active),'last_run_at',v_runtime.last_run_at),
    'budget',jsonb_build_object('daily_limit',v_runtime.daily_limit,'used_today',v_today,'batch_limit',20,'max_attempts',8,
      'monthly_limit',v_runtime.monthly_limit,'used_month',v_month,'blocked',
      (v_runtime.day=(clock_timestamp() at time zone 'UTC')::date and v_runtime.used_today>=v_runtime.daily_limit)
      or (v_runtime.month=date_trunc('month',clock_timestamp() at time zone 'UTC')::date and v_runtime.used_month>=v_runtime.monthly_limit)),
    'counts',v_counts,'jobs',v_jobs,'retention_days',30);
end; $$;
create function public.tr8_v2_get_process_status(p_workspace_id uuid default null)
returns jsonb language sql volatile security invoker set search_path='' as $$ select tr8_private.v4_get_process_status(p_workspace_id); $$;

do $stage4_grants$
declare f record;
begin
  for f in select p.oid::regprocedure signature,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='tr8_private' and p.proname like 'v4_%') or (n.nspname='public' and p.proname='tr8_v2_get_process_status') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
    if f.proname in ('tr8_v2_get_process_status','v4_get_process_status') then execute format('grant execute on function %s to authenticated',f.signature); end if;
  end loop;
end; $stage4_grants$;

do $stage4_preservation$
declare s record;
begin
  select * into strict s from tr8_stage4_snapshot;
  if s.projects_oid<>'public.tr8_workspace_projects'::regclass::oid or s.tasks_oid<>'public.tr8_workspace_tasks'::regclass::oid
    or s.sequence_oid<>pg_get_serial_sequence('public.tr8_workspace_tasks','task_number')::regclass::oid
    or s.projects_hash is distinct from (select md5(coalesce(string_agg(to_jsonb(p)::text,E'\n' order by id),'')) from public.tr8_workspace_projects p)
    or s.tasks_hash is distinct from (select md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by id),'')) from public.tr8_workspace_tasks t)
    or s.sequence_state is distinct from (select jsonb_build_object('last_value',q.last_value,'is_called',q.is_called) from public.tr8_tasks_task_number_seq q)
    or s.app_config is distinct from (select to_jsonb(c) from tr8_private.app_config c where singleton)
    or s.old_api is distinct from (select jsonb_object_agg(p.oid::text,jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','tr8_private')
      and (p.proname like 'tr8_v2_%' or p.proname like 'v2_%' or p.proname like 'v3_%' or p.proname in ('guard_task','guard_project'))
      and p.proname<>'tr8_v2_get_process_status')
    or exists(select 1 from tr8_private.process_outbox) or exists(select 1 from tr8_private.process_jobs) then
    raise exception 'Stage 4A changed historical data, APIs, identities, sequence, settings or fabricated historical work';
  end if;
end; $stage4_preservation$;
comment on table tr8_private.process_outbox is 'Durable domain metadata only, with authorization revisions and deletion tombstones. No titles, descriptions, financial data or provider credentials.';
comment on table tr8_private.process_jobs is 'Stage 4A internal reconciliation only. Success never asserts external email/calendar delivery. Leases require exact unexpired tokens.';
select cron.schedule('tr8-process-worker','* * * * *',$cron$set statement_timeout='8s'; set lock_timeout='500ms'; select tr8_private.v4_run_worker() where exists(select 1 from tr8_private.process_jobs where (state in ('pending','retry') and available_at<=clock_timestamp()) or (state='leased' and lease_expires_at<=clock_timestamp()));$cron$);
select cron.schedule('tr8-process-maintenance','17 3 * * *',$cron$set statement_timeout='8s'; set lock_timeout='500ms'; select tr8_private.v4_maintain_processes();$cron$);
notify pgrst,'reload schema';
