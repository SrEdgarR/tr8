-- Stage 5. Additive Google Calendar adapter. Applied v2/v3/v4 APIs and rows
-- are immutable. This migration is inert until an administrator supplies the
-- environment-specific worker endpoint/secrets and explicitly enables it.
lock table public.tr8_workspace_projects, public.tr8_workspace_tasks,
  tr8_private.app_users, tr8_private.app_config in access exclusive mode nowait;
create temporary table tr8_stage5_snapshot on commit drop as
select 'public.tr8_workspace_projects'::regclass::oid projects_oid,
  'public.tr8_workspace_tasks'::regclass::oid tasks_oid,
  (select md5(coalesce(string_agg(to_jsonb(p)::text,E'\n' order by id),'')) from public.tr8_workspace_projects p) projects_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by id),'')) from public.tr8_workspace_tasks t) tasks_hash,
  (select md5(coalesce(string_agg(to_jsonb(a)::text,E'\n' order by user_id),'')) from tr8_private.app_users a) users_hash,
  (select jsonb_build_object('last_value',q.last_value,'is_called',q.is_called) from public.tr8_tasks_task_number_seq q) sequence_state,
  (select to_jsonb(c) from tr8_private.app_config c where singleton) app_config,
  (select jsonb_object_agg(p.oid::text,jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','tr8_private')
    and (p.proname like 'tr8_v2_%' or p.proname like 'v2_%' or p.proname like 'v3_%' or p.proname like 'v4_%'
      or p.proname in ('guard_task','guard_project'))) old_api;

create table tr8_private.google_config (
  singleton boolean primary key default true check(singleton),
  configured boolean not null default false,
  scheduler_enabled boolean not null default false,
  worker_url text check(worker_url is null or worker_url ~ '^https://(ggbjezprlsnhidlbjivl|kajcbwlnqcwcpbtqyieo)\.supabase\.co/functions/v1/tr8-google-worker$'),
  worker_secret_name text not null default 'tr8_google_worker_secret' check(worker_secret_name='tr8_google_worker_secret'),
  app_origins text[] not null default array['https://tr8.vercel.app','http://127.0.0.1:5174','http://127.0.0.1:5173'],
  day date not null default (clock_timestamp() at time zone 'UTC')::date,
  used_today integer not null default 0 check(used_today>=0),
  month date not null default date_trunc('month',clock_timestamp() at time zone 'UTC')::date,
  used_month integer not null default 0 check(used_month>=0),
  daily_limit integer not null default 500 check(daily_limit between 1 and 500),
  monthly_limit integer not null default 10000 check(monthly_limit between 1 and 10000),
  last_wake_at timestamptz,
  last_run_at timestamptz
);
insert into tr8_private.google_config(singleton) values(true);
create table tr8_private.google_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references tr8_private.app_users(user_id) on delete restrict,
  generation integer not null default 0 check(generation>=0),
  version integer not null default 0 check(version>=0),
  state text not null default 'disconnected' check(state in ('disconnected','authorizing','provisioning','provisioning_unknown','connected','needs_reauthorization','disconnecting','cleanup_failed','error')),
  calendar_id text check(calendar_id is null or length(calendar_id) between 1 and 1024),
  credential_envelope jsonb,
  reason text check(reason in ('config_pending','oauth_denied','oauth_expired','oauth_exchange_failed','scope_missing','refresh_missing','reauthorization_required','different_google_account','provisioning_unknown','remote_missing','temporary_failure','permanent_failure','cleanup_failed','budget_exhausted')),
  disconnect_mode text check(disconnect_mode in ('keep','delete')),
  last_sync_at timestamptz,
  last_reconcile_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create table tr8_private.google_oauth_attempts (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references tr8_private.google_connections(id) on delete restrict,
  user_id uuid not null,
  session_id uuid not null,
  state_hash text not null unique check(state_hash ~ '^[A-Za-z0-9_-]{43}$'),
  browser_hash text not null check(browser_hash ~ '^[A-Za-z0-9_-]{43}$'),
  pkce_envelope jsonb,
  result_envelope jsonb,
  result_hash text check(result_hash is null or result_hash ~ '^[A-Za-z0-9_-]{43}$'),
  result_received_at timestamptz,
  expires_at timestamptz not null default clock_timestamp()+interval '10 minutes',
  consumed_at timestamptz,
  completed_at timestamptz,
  previous_state text not null,
  target_generation integer not null check(target_generation>0),
  app_origin text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index tr8_google_attempts_connection on tr8_private.google_oauth_attempts(connection_id,created_at desc);
create index tr8_google_attempts_expiry on tr8_private.google_oauth_attempts(expires_at);
create table tr8_private.google_event_links (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references tr8_private.google_connections(id) on delete restrict,
  generation integer not null,
  workspace_id uuid not null,
  project_id uuid not null,
  task_id uuid not null,
  task_created_at timestamptz not null,
  event_id text not null default replace(gen_random_uuid()::text,'-','') check(event_id ~ '^[0-9a-f]{32}$'),
  retired_event_ids text[] not null default '{}',
  state text not null default 'pending' check(state in ('pending','synced','deleting','deleted','retained','remote_missing')),
  desired_hash text,
  synced_hash text,
  cleanup_not_before timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(connection_id,generation,task_id,task_created_at),
  unique(connection_id,generation,event_id)
);
create index tr8_google_links_workspace on tr8_private.google_event_links(workspace_id,connection_id);
create index tr8_google_links_project on tr8_private.google_event_links(project_id,connection_id);
create table tr8_private.google_jobs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references tr8_private.google_connections(id) on delete restrict,
  generation integer not null,
  kind text not null check(kind in ('provision','reconcile_scan','upsert','delete','revoke')),
  link_id uuid references tr8_private.google_event_links(id) on delete restrict,
  state text not null default 'pending' check(state in ('pending','leased','retry','succeeded','cancelled','unknown','dead')),
  desired_revision bigint not null default 1 check(desired_revision>0),
  leased_revision bigint,
  prepared_hash text,
  cursor_id uuid,
  scan_more boolean not null default false,
  attempts integer not null default 0 check(attempts between 0 and 8),
  available_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  unique nulls not distinct(connection_id,generation,kind,link_id),
  check((kind in ('upsert','delete'))=(link_id is not null)),
  check((state='leased')=(lease_token is not null and lease_expires_at is not null))
);
create index tr8_google_jobs_due on tr8_private.google_jobs(available_at,id) where state in ('pending','retry','leased');
create index tr8_google_jobs_link on tr8_private.google_jobs(link_id) where link_id is not null;
create table tr8_private.google_requests (
  user_id uuid not null references tr8_private.app_users(user_id) on delete restrict,
  request_id uuid not null,
  action text not null,
  payload_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(user_id,request_id)
);
create index tr8_google_requests_time on tr8_private.google_requests(created_at);
create table tr8_private.google_request_receipts (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references tr8_private.google_connections(id) on delete restrict,
  job_id uuid,
  purpose text not null check(purpose in ('oauth','refresh','calendar_create','calendar_get','event_get','event_upsert','event_delete','revoke')),
  lease_token uuid,
  reserved_at timestamptz not null default clock_timestamp()
);
create index tr8_google_receipts_connection on tr8_private.google_request_receipts(connection_id,reserved_at);
create index tr8_google_receipts_time on tr8_private.google_request_receipts(reserved_at);

create function tr8_private.v5_valid_envelope(p_value jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
  select coalesce(p_value is not null and jsonb_typeof(p_value)='object'
    and p_value->'v'='1'::jsonb and (p_value-'v'-'kid'-'iv'-'ciphertext')='{}'::jsonb
    and p_value->>'kid' ~ '^[A-Za-z0-9_-]{1,64}$'
    and p_value->>'iv' ~ '^[A-Za-z0-9_-]{16}$'
    and length(p_value->>'ciphertext') between 22 and 44000
    and p_value->>'ciphertext' ~ '^[A-Za-z0-9_-]+$',false);
$$;
alter table tr8_private.google_connections add constraint tr8_google_credentials_cipher check(credential_envelope is null or tr8_private.v5_valid_envelope(credential_envelope));
alter table tr8_private.google_oauth_attempts add constraint tr8_google_pkce_cipher check(pkce_envelope is null or tr8_private.v5_valid_envelope(pkce_envelope));
alter table tr8_private.google_oauth_attempts add constraint tr8_google_result_cipher check(result_envelope is null or tr8_private.v5_valid_envelope(result_envelope));

create function tr8_private.v5_require_session(p_actor uuid,p_session uuid)
returns void language plpgsql volatile security definer set search_path='' as $$ begin
  if p_actor is null or p_session is null or not tr8_private.v2_user_live(p_actor)
    or not exists(select 1 from tr8_private.app_users where user_id=p_actor and enabled)
    or not exists(select 1 from auth.sessions where id=p_session and user_id=p_actor
      and (not_after is null or not_after>clock_timestamp())) then
    raise exception using errcode='42501',message='This account session is not authorized';
  end if;
end; $$;

create function tr8_private.v5_status(p_actor uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c tr8_private.google_connections; v_config boolean; v_pending integer; v_failed integer;
begin
  select configured into v_config from tr8_private.google_config where singleton;
  select * into c from tr8_private.google_connections where user_id=p_actor;
  select count(*) filter(where state in ('pending','leased','retry'))::integer,
    count(*) filter(where state in ('dead','unknown'))::integer into v_pending,v_failed
    from tr8_private.google_jobs where connection_id=c.id and generation=c.generation;
  return jsonb_build_object('configured',v_config,'state',coalesce(c.state,'disconnected'),
    'generation',coalesce(c.generation,0),'version',coalesce(c.version,0),'last_sync_at',c.last_sync_at,
    'pending',v_pending,'failed',v_failed,'reason',case when not v_config then 'config_pending' else c.reason end);
end; $$;
create function tr8_private.v5_get_status()
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_session uuid;
begin
  perform tr8_private.v2_require_actor();
  v_session:=nullif(auth.jwt()->>'session_id','')::uuid;
  perform tr8_private.v5_require_session(auth.uid(),v_session);
  return tr8_private.v5_status(auth.uid());
end; $$;
create function public.tr8_v2_get_google_status()
returns jsonb language sql volatile security invoker set search_path='' as $$ select tr8_private.v5_get_status(); $$;

create function tr8_private.v5_enqueue(p_connection uuid,p_kind text,p_link uuid default null)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare v_generation integer; v_id uuid;
begin
  select generation into strict v_generation from tr8_private.google_connections where id=p_connection;
  insert into tr8_private.google_jobs(connection_id,generation,kind,link_id)
    values(p_connection,v_generation,p_kind,p_link)
    on conflict(connection_id,generation,kind,link_id) do update set
      desired_revision=google_jobs.desired_revision+1,
      state=case when google_jobs.state='leased' then 'leased' else 'pending' end,
      attempts=case when google_jobs.state='leased' then google_jobs.attempts else 0 end,
      cursor_id=case when google_jobs.state='leased' then google_jobs.cursor_id else null end,
      available_at=clock_timestamp(),finished_at=null,updated_at=clock_timestamp(),reason=null
    returning id into v_id;
  if p_kind='delete' then
    update tr8_private.google_jobs set available_at=greatest(available_at,
      coalesce((select cleanup_not_before from tr8_private.google_event_links where id=p_link),available_at),coalesce((
      select max(q.lease_expires_at)+interval '10 seconds' from tr8_private.google_jobs q
      where q.connection_id=p_connection and q.kind='upsert' and q.link_id=p_link and q.state='leased'
    ),available_at)) where id=v_id and state<>'leased';
  end if;
  return v_id;
end; $$;

create function tr8_private.v5_task_eligible(p_connection uuid,p_task uuid,p_created timestamptz default null)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from tr8_private.google_connections c
    join public.tr8_workspace_tasks t on t.id=p_task
    join tr8_private.workspaces w on w.id=t.workspace_id
    left join tr8_private.workspace_members m on m.workspace_id=w.id and m.id=t.assignee_member_id and m.status='active'
    where c.id=p_connection and c.state='connected'
      and (p_created is null or t.created_at=p_created)
      and (t.scheduled_start_at is not null or t.due_date is not null or t.start_date is not null)
      and ((w.kind='personal' and w.owner_id=c.user_id) or (w.kind='team' and m.user_id=c.user_id))
      and tr8_private.v2_project_readable_for(w.id,t.project_id,c.user_id,true));
$$;
create function tr8_private.v5_task_hash(p_task uuid)
returns text language sql stable security definer set search_path='' as $$
  select md5(jsonb_build_array(t.id,t.created_at,t.version,p.version,a.version)::text)
    from public.tr8_workspace_tasks t join public.tr8_workspace_projects p on p.id=t.project_id and p.workspace_id=t.workspace_id
    join tr8_private.workspace_authz_state a on a.workspace_id=t.workspace_id where t.id=p_task;
$$;
create function tr8_private.v5_capture_outbox()
returns trigger language plpgsql security definer set search_path='' as $$
declare c record;
begin
  for c in select g.id from tr8_private.google_connections g where g.state='connected'
    and (exists(select 1 from tr8_private.workspace_members m where m.workspace_id=new.workspace_id and m.user_id=g.user_id and m.status='active')
      or exists(select 1 from tr8_private.google_event_links l where l.connection_id=g.id and l.workspace_id=new.workspace_id and l.generation=g.generation)) loop
    perform tr8_private.v5_enqueue(c.id,'reconcile_scan');
  end loop;
  return null;
end; $$;
create trigger tr8_google_capture_outbox after insert on tr8_private.process_outbox
  for each row execute function tr8_private.v5_capture_outbox();

create function tr8_private.v5_scan(p_job uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare j tr8_private.google_jobs; c tr8_private.google_connections; t public.tr8_workspace_tasks;
  k record; l record; v_count integer:=0; v_last uuid; v_link uuid; v_hash text;
begin
  select * into strict j from tr8_private.google_jobs where id=p_job;
  select * into strict c from tr8_private.google_connections where id=j.connection_id;
  for k in select q.task_id from(
      select t0.id task_id from public.tr8_workspace_tasks t0
        join tr8_private.workspaces w on w.id=t0.workspace_id
        left join tr8_private.workspace_members m on m.workspace_id=w.id and m.id=t0.assignee_member_id
        where (w.kind='personal' and w.owner_id=c.user_id) or (w.kind='team' and m.user_id=c.user_id)
      union select task_id from tr8_private.google_event_links where connection_id=c.id and generation=c.generation
    ) q where j.cursor_id is null or q.task_id>j.cursor_id order by q.task_id limit 100 loop
    v_count:=v_count+1;v_last:=k.task_id;
    select * into t from public.tr8_workspace_tasks where id=k.task_id;
    if found and tr8_private.v5_task_eligible(c.id,t.id,t.created_at) then
      v_hash:=tr8_private.v5_task_hash(t.id);
      insert into tr8_private.google_event_links(connection_id,generation,workspace_id,project_id,task_id,task_created_at,desired_hash)
        values(c.id,c.generation,t.workspace_id,t.project_id,t.id,t.created_at,v_hash)
        on conflict(connection_id,generation,task_id,task_created_at) do nothing;
      select id into v_link from tr8_private.google_event_links where connection_id=c.id and generation=c.generation and task_id=t.id and task_created_at=t.created_at;
      update tr8_private.google_event_links set desired_hash=v_hash,updated_at=clock_timestamp() where id=v_link;
      if exists(select 1 from tr8_private.google_event_links where id=v_link and state in ('pending','synced') and synced_hash is distinct from v_hash) then
        perform tr8_private.v5_enqueue(c.id,'upsert',v_link);
      end if;
    end if;
    for l in select * from tr8_private.google_event_links where connection_id=c.id and generation=c.generation and task_id=k.task_id
      and state not in ('deleted','retained') loop
      if not tr8_private.v5_task_eligible(c.id,l.task_id,l.task_created_at) then
        update tr8_private.google_event_links set state='deleting',updated_at=clock_timestamp() where id=l.id;
        perform tr8_private.v5_enqueue(c.id,'delete',l.id);
      end if;
    end loop;
  end loop;
  update tr8_private.google_jobs set cursor_id=coalesce(v_last,cursor_id),scan_more=v_count=100 where id=p_job;
  return jsonb_build_object('internal',true,'scanned',v_count,'more',v_count=100);
end; $$;

create function tr8_private.v5_claim(p_limit integer default 2)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='500ms' as $$
declare j record; v_result jsonb:='[]'; v_token uuid; cfg tr8_private.google_config;
begin
  if p_limit is null or p_limit not between 1 and 2 then raise exception using errcode='22023',message='Invalid Google batch limit'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception using errcode='25000',message='Worker requires read committed isolation'; end if;
  select * into strict cfg from tr8_private.google_config where singleton;
  if not cfg.configured then return v_result; end if;
  for j in select q.*,c.state connection_state,c.user_id,c.generation current_generation from tr8_private.google_jobs q
    join tr8_private.google_connections c on c.id=q.connection_id
    where ((q.state in ('pending','retry') and q.available_at<=clock_timestamp()) or (q.state='leased' and q.lease_expires_at<=clock_timestamp()))
    order by q.available_at,q.id limit 100 for update of q skip locked loop
    exit when jsonb_array_length(v_result)>=p_limit;
    if j.kind<>'reconcile_scan' and ((cfg.day=(clock_timestamp() at time zone 'UTC')::date and cfg.used_today>=cfg.daily_limit)
      or (cfg.month=date_trunc('month',clock_timestamp() at time zone 'UTC')::date and cfg.used_month>=cfg.monthly_limit)) then continue;end if;
    -- Lock without waiting before changing any connection state. Other paths
    -- acquire connection before job; SKIP LOCKED breaks the inverse claim order.
    select state,generation into j.connection_state,j.current_generation from tr8_private.google_connections
      where id=j.connection_id for update skip locked;
    if not found then continue;end if;
    if j.kind='provision' and j.connection_state='provisioning_unknown' then
      update tr8_private.google_jobs set state='unknown',lease_token=null,lease_expires_at=null,finished_at=clock_timestamp(),reason='outcome_unknown' where id=j.id;
      continue;
    end if;
    if j.generation<>j.current_generation or (j.kind in ('upsert','reconcile_scan') and j.connection_state<>'connected')
      or (j.kind='provision' and j.connection_state<>'provisioning')
      or (j.kind in ('delete','revoke') and j.connection_state not in ('connected','disconnecting')) then
      update tr8_private.google_jobs set state='cancelled',lease_token=null,lease_expires_at=null,finished_at=clock_timestamp(),reason='access_changed' where id=j.id;
      continue;
    end if;
    if j.attempts>=8 then
      update tr8_private.google_jobs set state='dead',lease_token=null,lease_expires_at=null,finished_at=clock_timestamp(),reason='attempt_limit' where id=j.id;
      if j.connection_state='disconnecting' then
        update tr8_private.google_connections set state='cleanup_failed',reason='cleanup_failed',version=version+1,updated_at=clock_timestamp() where id=j.connection_id;
      end if;
      continue;
    end if;
    if exists(select 1 from tr8_private.google_jobs q where q.connection_id=j.connection_id and q.id<>j.id and q.state='leased' and q.lease_expires_at>clock_timestamp()) then continue; end if;
    v_token:=gen_random_uuid();
    update tr8_private.google_jobs set state='leased',lease_token=v_token,lease_expires_at=clock_timestamp()+interval '60 seconds',
      leased_revision=desired_revision,attempts=attempts+1,prepared_hash=null,updated_at=clock_timestamp(),finished_at=null where id=j.id;
    v_result:=v_result||jsonb_build_array(jsonb_build_object('job_id',j.id,'lease_token',v_token,'kind',j.kind));
  end loop;
  if jsonb_array_length(v_result)>0 then update tr8_private.google_config set last_run_at=clock_timestamp() where singleton; end if;
  return v_result;
end; $$;

create function tr8_private.v5_prepare(p_job uuid,p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare j tr8_private.google_jobs; c tr8_private.google_connections; l tr8_private.google_event_links;
  v_event jsonb; v_hash text; v_result jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception using errcode='25000',message='Worker requires read committed isolation'; end if;
  select * into j from tr8_private.google_jobs where id=p_job;
  if not found then return jsonb_build_object('valid',false);end if;
  select * into strict c from tr8_private.google_connections where id=j.connection_id for update;
  select * into j from tr8_private.google_jobs where id=p_job for update;
  if not found or j.state<>'leased' or j.lease_token is distinct from p_token or j.lease_expires_at<=clock_timestamp() then return jsonb_build_object('valid',false); end if;
  if c.generation<>j.generation then return jsonb_build_object('valid',false); end if;
  v_result:=jsonb_build_object('valid',true,'kind',j.kind,'connection_id',c.id,'generation',c.generation,'user_id',c.user_id,
    'calendar_id',c.calendar_id,'credential_envelope',c.credential_envelope,
    'time_zone',coalesce((select calendar_time_zone from tr8_private.app_users where user_id=c.user_id),'UTC'));
  if j.kind='reconcile_scan' then
    if c.state<>'connected' or not tr8_private.v2_user_live(c.user_id) or not exists(select 1 from tr8_private.app_users where user_id=c.user_id and enabled) then return jsonb_build_object('valid',false); end if;
    return (v_result-'credential_envelope')||tr8_private.v5_scan(j.id);
  elsif j.kind='provision' then
    if c.state<>'provisioning' or c.calendar_id is not null or c.credential_envelope is null
      or not tr8_private.v2_user_live(c.user_id) or not exists(select 1 from tr8_private.app_users where user_id=c.user_id and enabled) then return jsonb_build_object('valid',false); end if;
    return v_result;
  elsif j.kind='revoke' then
    if c.state<>'disconnecting' then return jsonb_build_object('valid',false); end if;
    if c.disconnect_mode='delete' and exists(select 1 from tr8_private.google_event_links where connection_id=c.id and generation=c.generation and state not in ('deleted','retained')) then
      update tr8_private.google_jobs set state='retry',attempts=0,lease_token=null,lease_expires_at=null,
        available_at=clock_timestamp()+interval '30 seconds',reason='cleanup_pending' where id=j.id;
      return jsonb_build_object('valid',false,'wait',true);
    end if;
    return v_result;
  end if;
  select * into strict l from tr8_private.google_event_links where id=j.link_id;
  v_result:=v_result||jsonb_build_object('link',jsonb_build_object('id',l.id,'event_id',l.event_id));
  if j.kind='delete' then
    -- Cleanup is identifier-only and remains possible after ACL/account removal.
    if c.state not in ('connected','disconnecting') or l.state in ('deleted','retained') then return jsonb_build_object('valid',false); end if;
    return v_result;
  end if;
  if not tr8_private.v5_task_eligible(c.id,l.task_id,l.task_created_at) then
    update tr8_private.google_event_links set state='deleting',updated_at=clock_timestamp() where id=l.id;
    perform tr8_private.v5_enqueue(c.id,'delete',l.id);
    return jsonb_build_object('valid',false);
  end if;
  if l.state in ('remote_missing','deleted','retained','deleting') then return jsonb_build_object('valid',false); end if;
  -- Ephemeral, ACL-checked projection input. Descriptions, membership directory,
  -- financial content and tokens never enter the durable queue or the UI.
  -- Content and its revision hash must come from ONE statement snapshot. A
  -- second SELECT under READ COMMITTED could otherwise label old content with
  -- a newer revision and falsely suppress the compensating reconciliation.
  select jsonb_build_object('id',t.id,'project_id',t.project_id,'title',t.title,'project_title',p.name,
      'project_status',p.status,'project_archived',p.archived_at is not null,'status',t.status,
      'start_date',t.start_date,'due_date',t.due_date,'scheduled_start_at',t.scheduled_start_at,
      'scheduled_end_at',t.scheduled_end_at,'scheduled_time_zone',t.scheduled_time_zone),
    md5(jsonb_build_array(t.id,t.created_at,t.version,p.version,a.version)::text)
    into strict v_event,v_hash from public.tr8_workspace_tasks t
      join public.tr8_workspace_projects p on p.id=t.project_id and p.workspace_id=t.workspace_id
      join tr8_private.workspace_authz_state a on a.workspace_id=t.workspace_id
      where t.id=l.task_id and t.created_at=l.task_created_at;
  update tr8_private.google_jobs set prepared_hash=v_hash where id=j.id;
  return v_result||jsonb_build_object('event',v_event,'previously_synced',l.synced_hash is not null);
end; $$;

create function tr8_private.v5_reserve_request(p_actor uuid,p_session uuid,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='500ms' as $$
declare cfg tr8_private.google_config; j tr8_private.google_jobs; c tr8_private.google_connections;
  v_purpose text:=p_payload->>'purpose'; v_connection uuid; v_now timestamptz:=clock_timestamp(); v_id uuid;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception using errcode='25000',message='Worker requires read committed isolation'; end if;
  if v_purpose is null or v_purpose not in ('oauth','refresh','calendar_create','calendar_get','event_get','event_upsert','event_delete','revoke') then raise exception using errcode='22023',message='Invalid Google request purpose'; end if;
  if p_payload ? 'job_id' then
    select * into j from tr8_private.google_jobs where id=(p_payload->>'job_id')::uuid;
    if not found then return jsonb_build_object('allowed',false,'reason','lease_expired');end if;
    select * into strict c from tr8_private.google_connections where id=j.connection_id for update;
    select * into j from tr8_private.google_jobs where id=(p_payload->>'job_id')::uuid for update;
    if not found or j.state<>'leased' or j.lease_token is distinct from (p_payload->>'lease_token')::uuid or j.lease_expires_at<=clock_timestamp() then return jsonb_build_object('allowed',false,'reason','lease_expired'); end if;
    if c.generation<>j.generation then return jsonb_build_object('allowed',false,'reason','access_changed'); end if;
    if j.kind='upsert' and not tr8_private.v5_task_eligible(c.id,(select task_id from tr8_private.google_event_links where id=j.link_id),(select task_created_at from tr8_private.google_event_links where id=j.link_id)) then return jsonb_build_object('allowed',false,'reason','access_changed'); end if;
    if j.kind='provision' and (c.state not in ('provisioning','provisioning_unknown') or not tr8_private.v2_user_live(c.user_id)
      or not exists(select 1 from tr8_private.app_users where user_id=c.user_id and enabled)) then return jsonb_build_object('allowed',false,'reason','access_changed'); end if;
    if j.kind='delete' and c.state not in ('connected','disconnecting') then return jsonb_build_object('allowed',false,'reason','access_changed'); end if;
    if j.kind='revoke' and c.state<>'disconnecting' then return jsonb_build_object('allowed',false,'reason','access_changed'); end if;
    if v_purpose='calendar_create' and (j.kind<>'provision' or exists(select 1 from tr8_private.google_request_receipts where job_id=j.id and lease_token=j.lease_token and purpose='calendar_create')) then return jsonb_build_object('allowed',false,'reason','provisioning_unknown'); end if;
    if (v_purpose='event_upsert' and j.kind<>'upsert') or (v_purpose='event_delete' and j.kind<>'delete') or (v_purpose='revoke' and j.kind<>'revoke') then raise exception using errcode='22023',message='Mismatched Google request purpose'; end if;
    v_connection:=c.id;
  else
    perform tr8_private.v5_require_session(p_actor,p_session);
    if v_purpose not in ('oauth','refresh','calendar_get') then raise exception using errcode='22023',message='A worker lease is required'; end if;
    select * into c from tr8_private.google_connections where user_id=p_actor for update;
    if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
    v_connection:=c.id;
  end if;
  select * into strict cfg from tr8_private.google_config where singleton for update;
  if not cfg.configured then return jsonb_build_object('allowed',false,'reason','config_pending'); end if;
  if cfg.day<>(v_now at time zone 'UTC')::date then cfg.day:=(v_now at time zone 'UTC')::date;cfg.used_today:=0;end if;
  if cfg.month<>date_trunc('month',v_now at time zone 'UTC')::date then cfg.month:=date_trunc('month',v_now at time zone 'UTC')::date;cfg.used_month:=0;end if;
  if cfg.used_today>=cfg.daily_limit or cfg.used_month>=cfg.monthly_limit then return jsonb_build_object('allowed',false,'reason','budget_exhausted'); end if;
  update tr8_private.google_config set day=cfg.day,used_today=cfg.used_today+1,month=cfg.month,used_month=cfg.used_month+1 where singleton;
  insert into tr8_private.google_request_receipts(connection_id,job_id,lease_token,purpose) values(v_connection,j.id,j.lease_token,v_purpose) returning id into v_id;
  if v_purpose='event_upsert' then
    -- Retain this barrier after a lease is cancelled, expires or exhausts its
    -- retries. Cleanup must not lose the grace period when job fields clear.
    update tr8_private.google_event_links set cleanup_not_before=greatest(coalesce(cleanup_not_before,'-infinity'::timestamptz),j.lease_expires_at+interval '10 seconds') where id=j.link_id;
  end if;
  if v_purpose='calendar_create' then
    update tr8_private.google_connections set state='provisioning_unknown',reason='provisioning_unknown',version=version+1,updated_at=v_now where id=c.id;
  end if;
  return jsonb_build_object('allowed',true,'receipt_id',v_id);
end; $$;

create function tr8_private.v5_server(p_action text,p_actor uuid default null,p_session uuid default null,p_payload jsonb default '{}')
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='500ms' as $$
declare c tr8_private.google_connections; a tr8_private.google_oauth_attempts; r tr8_private.google_requests;
  v_result jsonb; v_request uuid; v_hash text; v_expected integer; v_reason text; v_previous_state text; v_link record; j tr8_private.google_jobs;
begin
  if p_action is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>50000 then raise exception using errcode='22023',message='Invalid Google request'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception using errcode='25000',message='Google operations require read committed isolation'; end if;
  if p_action='claim' then return tr8_private.v5_claim(coalesce((p_payload->>'limit')::integer,2));
  elsif p_action='prepare' then return tr8_private.v5_prepare((p_payload->>'job_id')::uuid,(p_payload->>'lease_token')::uuid);
  elsif p_action='finish' then return to_jsonb(tr8_private.v5_finish((p_payload->>'job_id')::uuid,(p_payload->>'lease_token')::uuid,p_payload));
  elsif p_action='reserve_request' then return tr8_private.v5_reserve_request(p_actor,p_session,p_payload);
  elsif p_action='relay' then
    select * into a from tr8_private.google_oauth_attempts where state_hash=p_payload->>'state_hash' and consumed_at is null and completed_at is null and expires_at>clock_timestamp();
    if not found then raise exception using errcode='PT404',message='OAuth attempt unavailable'; end if;
    perform tr8_private.v5_require_session(a.user_id,a.session_id);
    select * into strict c from tr8_private.google_connections where id=a.connection_id;
    if c.state<>'authorizing' or a.target_generation<>(case when c.calendar_id is null then c.generation+1 else c.generation end)
      or not exists(select 1 from tr8_private.google_config where configured and a.app_origin=any(app_origins)) then raise exception using errcode='PT404',message='OAuth attempt unavailable';end if;
    return jsonb_build_object('app_origin',a.app_origin,'user_id',a.user_id);
  elsif p_action='record_oauth_result' then
    if p_payload->>'result_hash' is null or p_payload->>'result_hash' !~ '^[A-Za-z0-9_-]{43}$'
      or not coalesce(tr8_private.v5_valid_envelope(p_payload->'result_envelope'),false) then raise exception using errcode='22023',message='Invalid encrypted OAuth result';end if;
    select * into a from tr8_private.google_oauth_attempts where state_hash=p_payload->>'state_hash';
    if not found then raise exception using errcode='PT404',message='OAuth attempt unavailable';end if;
    select * into strict c from tr8_private.google_connections where id=a.connection_id for update;
    select * into a from tr8_private.google_oauth_attempts where state_hash=p_payload->>'state_hash' for update;
    perform tr8_private.v5_require_session(a.user_id,a.session_id);
    if a.consumed_at is not null or a.completed_at is not null or a.expires_at<=clock_timestamp() or c.state<>'authorizing'
      or a.target_generation<>(case when c.calendar_id is null then c.generation+1 else c.generation end)
      or not exists(select 1 from tr8_private.google_config where configured and a.app_origin=any(app_origins)) then raise exception using errcode='PT404',message='OAuth attempt unavailable';end if;
    if a.result_hash is not null then
      if a.result_hash is distinct from p_payload->>'result_hash' then raise exception using errcode='PT409',message='OAuth result identity conflict';end if;
    else
      update tr8_private.google_oauth_attempts set result_hash=p_payload->>'result_hash',result_envelope=p_payload->'result_envelope',result_received_at=clock_timestamp() where id=a.id;
    end if;
    return jsonb_build_object('app_origin',a.app_origin);
  elsif p_action='save_credentials' then
    if not coalesce(tr8_private.v5_valid_envelope(p_payload->'credential_envelope'),false) then raise exception using errcode='22023',message='Invalid encrypted credentials'; end if;
    if not (p_payload ? 'job_id') then
      perform tr8_private.v5_require_session(p_actor,p_session);
      update tr8_private.google_connections set credential_envelope=p_payload->'credential_envelope',updated_at=clock_timestamp()
        where user_id=p_actor and generation=(p_payload->>'generation')::integer and credential_envelope is not null;
      return to_jsonb(found);
    end if;
    select * into j from tr8_private.google_jobs where id=(p_payload->>'job_id')::uuid;
    if not found then return 'false'::jsonb;end if;
    perform 1 from tr8_private.google_connections where id=j.connection_id for update;
    select * into j from tr8_private.google_jobs where id=(p_payload->>'job_id')::uuid for update;
    if not found or j.state<>'leased' or j.lease_token is distinct from (p_payload->>'lease_token')::uuid or j.lease_expires_at<=clock_timestamp() then return 'false'::jsonb; end if;
    update tr8_private.google_connections set credential_envelope=p_payload->'credential_envelope',updated_at=clock_timestamp()
      where id=j.connection_id and generation=j.generation and credential_envelope is not null;
    return to_jsonb(found);
  end if;
  perform tr8_private.v5_require_session(p_actor,p_session);
  if p_action='status' then return tr8_private.v5_status(p_actor); end if;
  if p_action='inspect_connection' then
    select * into c from tr8_private.google_connections where user_id=p_actor;
    if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
    return jsonb_build_object('user_id',c.user_id,'connection_id',c.id,'generation',c.generation,'calendar_id',c.calendar_id,
      'credential_envelope',c.credential_envelope,'state',c.state,'version',c.version);
  end if;
  if p_action='consume_attempt' then
    select * into a from tr8_private.google_oauth_attempts where state_hash=p_payload->>'state_hash';
    if not found then raise exception using errcode='PT404',message='OAuth attempt unavailable';end if;
    select * into strict c from tr8_private.google_connections where id=a.connection_id for update;
    select * into a from tr8_private.google_oauth_attempts where state_hash=p_payload->>'state_hash' for update;
    if not found or a.user_id<>p_actor or a.session_id<>p_session or a.browser_hash is distinct from p_payload->>'browser_hash'
      or a.consumed_at is not null or a.completed_at is not null or a.expires_at<=clock_timestamp()
      or a.result_envelope is null or a.result_received_at is null then raise exception using errcode='PT404',message='OAuth attempt unavailable'; end if;
    if c.state<>'authorizing' then raise exception using errcode='PT409',message='OAuth connection changed'; end if;
    update tr8_private.google_oauth_attempts set consumed_at=clock_timestamp() where id=a.id;
    return jsonb_build_object('attempt_id',a.id,'user_id',a.user_id,'connection_id',c.id,'generation',a.target_generation,
      'pkce_envelope',a.pkce_envelope,'result_envelope',a.result_envelope,'calendar_id',c.calendar_id,'credential_envelope',c.credential_envelope);
  elsif p_action in ('complete_authorization','authorization_failed') then
    select * into a from tr8_private.google_oauth_attempts where id=(p_payload->>'attempt_id')::uuid;
    if not found then raise exception using errcode='PT404',message='OAuth attempt unavailable';end if;
    select * into strict c from tr8_private.google_connections where id=a.connection_id for update;
    select * into a from tr8_private.google_oauth_attempts where id=(p_payload->>'attempt_id')::uuid for update;
    if not found or a.user_id<>p_actor or a.session_id<>p_session or a.consumed_at is null or a.completed_at is not null
      or a.expires_at<=clock_timestamp() then raise exception using errcode='PT404',message='OAuth attempt unavailable'; end if;
    if c.state<>'authorizing' then raise exception using errcode='PT409',message='OAuth connection changed'; end if;
    if p_action='authorization_failed' then
      v_reason:=p_payload->>'reason';
      if v_reason is null or v_reason not in ('oauth_denied','oauth_expired','oauth_exchange_failed','scope_missing','refresh_missing','different_google_account','budget_exhausted') then raise exception using errcode='22023',message='Invalid OAuth result'; end if;
      update tr8_private.google_connections set state=case when a.previous_state in ('needs_reauthorization','error') then a.previous_state
        when a.previous_state='connected' and calendar_id is not null and credential_envelope is not null then 'connected' else 'disconnected' end,
        reason=v_reason,version=version+1,updated_at=clock_timestamp() where id=c.id;
    else
      if not coalesce(tr8_private.v5_valid_envelope(p_payload->'credential_envelope'),false) then raise exception using errcode='22023',message='Invalid encrypted credentials'; end if;
      if c.calendar_id is not null and not coalesce((p_payload->>'keep_existing_calendar')::boolean,false) then raise exception using errcode='PT409',message='Different Google account requires explicit disconnection'; end if;
      update tr8_private.google_connections set generation=a.target_generation,credential_envelope=p_payload->'credential_envelope',reason=null,
        state=case when calendar_id is null then 'provisioning' else 'connected' end,version=version+1,disconnect_mode=null,updated_at=clock_timestamp() where id=c.id;
      perform tr8_private.v5_enqueue(c.id,case when c.calendar_id is null then 'provision' else 'reconcile_scan' end);
    end if;
    update tr8_private.google_oauth_attempts set pkce_envelope=null,result_envelope=null,completed_at=clock_timestamp() where id=a.id;
    return tr8_private.v5_status(p_actor);
  end if;
  if p_action not in ('begin','reconcile','disconnect','retry_cleanup','abandon_cleanup','recover_calendar','rebuild_missing') then raise exception using errcode='22023',message='Unknown Google action'; end if;
  v_request:=(p_payload->>'request_id')::uuid;v_expected:=(p_payload->>'expected_version')::integer;
  if v_request is null or v_expected is null or v_expected<0 then raise exception using errcode='22023',message='Request identity and version are required'; end if;
  -- Serialize per user before testing the request receipt. No authority comes
  -- from request IDs or expected versions.
  perform 1 from tr8_private.app_users where user_id=p_actor for update;
  perform tr8_private.v5_require_session(p_actor,p_session);
  v_hash:=md5(p_action||case when p_action='begin' then
    (p_payload-'state_hash'-'pkce_envelope')::text||p_session::text else p_payload::text end);
  select * into r from tr8_private.google_requests where user_id=p_actor and request_id=v_request;
  if found then
    if r.action<>p_action or r.payload_hash<>v_hash then raise exception using errcode='PT409',message='Request identity conflict'; end if;
    if p_action='begin' then
      select * into a from tr8_private.google_oauth_attempts where id=(r.response->>'attempt_id')::uuid;
      select * into c from tr8_private.google_connections where id=a.connection_id;
      if a.id is null or a.user_id<>p_actor or a.session_id<>p_session or a.browser_hash is distinct from p_payload->>'browser_hash'
        or a.consumed_at is not null or a.completed_at is not null or a.expires_at<=clock_timestamp() or a.pkce_envelope is null
        or c.state<>'authorizing' or c.version<>(r.response->>'version')::integer
        or a.target_generation<>(case when c.calendar_id is null then c.generation+1 else c.generation end) then
        raise exception using errcode='PT409',message='OAuth initiation can no longer be replayed';
      end if;
      return r.response||jsonb_build_object('state_hash',a.state_hash,'pkce_envelope',a.pkce_envelope);
    end if;
    return r.response;
  end if;
  if p_action='begin' then
    if not (select configured from tr8_private.google_config where singleton) then raise exception using errcode='PT503',message='Google configuration pending'; end if;
    insert into tr8_private.google_connections(user_id) values(p_actor) on conflict(user_id) do nothing;
  end if;
  select * into c from tr8_private.google_connections where user_id=p_actor for update;
  if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  if c.version<>v_expected then raise exception using errcode='PT409',message='Stale Google connection version'; end if;
  if p_action='begin' then
    if c.state in ('disconnecting','cleanup_failed','provisioning','provisioning_unknown') then raise exception using errcode='PT409',message='Resolve the current connection operation first'; end if;
    if p_payload->>'state_hash' is null or p_payload->>'state_hash' !~ '^[A-Za-z0-9_-]{43}$'
      or p_payload->>'browser_hash' is null or p_payload->>'browser_hash' !~ '^[A-Za-z0-9_-]{43}$'
      or not coalesce(tr8_private.v5_valid_envelope(p_payload->'pkce_envelope'),false)
      or not exists(select 1 from tr8_private.google_config where p_payload->>'app_origin'=any(app_origins)) then raise exception using errcode='22023',message='Invalid OAuth initiation'; end if;
    if c.state='authorizing' then
      select previous_state into v_previous_state from tr8_private.google_oauth_attempts where connection_id=c.id
        order by created_at desc,id limit 1;
    end if;
    v_previous_state:=coalesce(v_previous_state,c.state);
    if v_previous_state='authorizing' then v_previous_state:='disconnected';end if;
    update tr8_private.google_oauth_attempts set completed_at=clock_timestamp(),pkce_envelope=null,result_envelope=null where connection_id=c.id and completed_at is null;
    insert into tr8_private.google_oauth_attempts(connection_id,user_id,session_id,state_hash,browser_hash,pkce_envelope,previous_state,target_generation,app_origin)
      values(c.id,p_actor,p_session,p_payload->>'state_hash',p_payload->>'browser_hash',p_payload->'pkce_envelope',v_previous_state,
        case when c.calendar_id is null then c.generation+1 else c.generation end,p_payload->>'app_origin') returning * into a;
    update tr8_private.google_connections set state='authorizing',reason=null,version=version+1,updated_at=clock_timestamp() where id=c.id;
    v_result:=jsonb_build_object('attempt_id',a.id,'connection_id',c.id,'generation',a.target_generation,'version',c.version+1,
      'state_hash',a.state_hash,'pkce_envelope',a.pkce_envelope);
  elsif p_action='reconcile' then
    if c.state<>'connected' then raise exception using errcode='PT409',message='Google connection is not ready'; end if;
    if c.last_reconcile_at>clock_timestamp()-interval '30 seconds' then raise exception using errcode='PT429',message='Please wait before reconciling again'; end if;
    perform tr8_private.v5_enqueue(c.id,'reconcile_scan');
    update tr8_private.google_connections set version=version+1,last_reconcile_at=clock_timestamp() where id=c.id;
    v_result:=tr8_private.v5_status(p_actor);
  elsif p_action='rebuild_missing' then
    if c.state<>'connected' or not exists(select 1 from tr8_private.google_event_links where connection_id=c.id and generation=c.generation and state='remote_missing') then raise exception using errcode='PT409',message='No missing events to rebuild'; end if;
    for v_link in select * from tr8_private.google_event_links where connection_id=c.id and generation=c.generation and state='remote_missing' for update loop
      if tr8_private.v5_task_eligible(c.id,v_link.task_id,v_link.task_created_at) then
        update tr8_private.google_event_links set retired_event_ids=array_append(retired_event_ids,event_id),event_id=replace(gen_random_uuid()::text,'-',''),state='pending',synced_hash=null,updated_at=clock_timestamp() where id=v_link.id;
        perform tr8_private.v5_enqueue(c.id,'upsert',v_link.id);
      end if;
    end loop;
    update tr8_private.google_connections set reason=null,version=version+1 where id=c.id;
    v_result:=tr8_private.v5_status(p_actor);
  elsif p_action='recover_calendar' then
    if c.state<>'provisioning_unknown' or c.credential_envelope is null or p_payload->>'calendar_id' is null or length(p_payload->>'calendar_id') not between 1 and 1024 then raise exception using errcode='PT409',message='Calendar recovery is unavailable'; end if;
    update tr8_private.google_connections set calendar_id=p_payload->>'calendar_id',state='connected',reason=null,version=version+1 where id=c.id;
    if p_payload ? 'credential_envelope' then
      if not tr8_private.v5_valid_envelope(p_payload->'credential_envelope') then raise exception using errcode='22023',message='Invalid encrypted credentials'; end if;
      update tr8_private.google_connections set credential_envelope=p_payload->'credential_envelope' where id=c.id;
    end if;
    update tr8_private.google_jobs set state='cancelled',lease_token=null,lease_expires_at=null,finished_at=clock_timestamp() where connection_id=c.id and kind='provision';
    perform tr8_private.v5_enqueue(c.id,'reconcile_scan');v_result:=tr8_private.v5_status(p_actor);
  else
    if p_action='disconnect' then
      if p_payload->>'mode' is null or p_payload->>'mode' not in ('keep','delete') then raise exception using errcode='22023',message='Invalid disconnect choice'; end if;
      if c.state='disconnected' then
        v_result:=tr8_private.v5_status(p_actor);
      else
        update tr8_private.google_connections set state='disconnecting',disconnect_mode=p_payload->>'mode',reason=null,version=version+1 where id=c.id;
      end if;
    elsif p_action='retry_cleanup' then
      if c.state<>'cleanup_failed' then raise exception using errcode='PT409',message='Cleanup retry is unavailable'; end if;
      update tr8_private.google_connections set state='disconnecting',reason=null,version=version+1 where id=c.id;
    elsif p_action='abandon_cleanup' then
      if c.state not in ('disconnecting','cleanup_failed') then raise exception using errcode='PT409',message='Cleanup is unavailable'; end if;
      update tr8_private.google_connections set state='disconnecting',disconnect_mode='keep',reason=null,version=version+1 where id=c.id;
    end if;
    if v_result is null then
      select * into strict c from tr8_private.google_connections where id=c.id;
      update tr8_private.google_oauth_attempts set completed_at=clock_timestamp(),pkce_envelope=null,result_envelope=null where connection_id=c.id and completed_at is null;
      update tr8_private.google_jobs set state='cancelled',finished_at=clock_timestamp(),reason='disconnected'
        where connection_id=c.id and state in ('pending','retry','unknown','dead') and kind in ('provision','reconcile_scan','upsert');
      if c.disconnect_mode='keep' then
        update tr8_private.google_event_links set state='retained' where connection_id=c.id and generation=c.generation and state<>'deleted';
        update tr8_private.google_jobs set state='cancelled',finished_at=clock_timestamp(),reason='retained'
          where connection_id=c.id and kind='delete' and state in ('pending','retry','unknown','dead');
      else
        for v_link in select id from tr8_private.google_event_links where connection_id=c.id and generation=c.generation and state not in ('deleted','retained') loop
          update tr8_private.google_event_links set state='deleting' where id=v_link.id;
          perform tr8_private.v5_enqueue(c.id,'delete',v_link.id);
        end loop;
      end if;
      if c.credential_envelope is null then
        update tr8_private.google_connections set state='disconnected',calendar_id=null,disconnect_mode=null,reason=null,version=version+1 where id=c.id;
      else perform tr8_private.v5_enqueue(c.id,'revoke');end if;
      v_result:=tr8_private.v5_status(p_actor);
    end if;
  end if;
  insert into tr8_private.google_requests(user_id,request_id,action,payload_hash,response)
    values(p_actor,v_request,p_action,v_hash,case when p_action='begin' then v_result-'state_hash'-'pkce_envelope' else v_result end);
  return v_result;
end; $$;
create function public.tr8_server_google(p_action text,p_actor uuid default null,p_session uuid default null,p_payload jsonb default '{}')
returns jsonb language sql volatile security invoker set search_path='' as $$ select tr8_private.v5_server(p_action,p_actor,p_session,p_payload); $$;

create function tr8_private.v5_finish(p_job uuid,p_token uuid,p_result jsonb)
returns boolean language plpgsql volatile security definer set search_path='' set lock_timeout='500ms' as $$
declare j tr8_private.google_jobs; c tr8_private.google_connections; l tr8_private.google_event_links;
  v_outcome text:=p_result->>'outcome'; v_reason text; v_delay integer; v_continue boolean:=false; v_id text;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception using errcode='25000',message='Worker requires read committed isolation'; end if;
  if v_outcome is null or v_outcome not in ('succeeded','retry','dead','unknown','cancelled','needs_reauthorization','remote_missing') then raise exception using errcode='22023',message='Invalid Google outcome'; end if;
  select * into j from tr8_private.google_jobs where id=p_job;
  if not found then return false;end if;
  select * into strict c from tr8_private.google_connections where id=j.connection_id for update;
  select * into j from tr8_private.google_jobs where id=p_job for update;
  if not found or j.state<>'leased' or j.lease_token is distinct from p_token or j.lease_expires_at<=clock_timestamp() then return false; end if;
  if c.generation<>j.generation then
    update tr8_private.google_jobs set state='cancelled',reason='superseded',lease_token=null,lease_expires_at=null,finished_at=clock_timestamp() where id=j.id;
    return false;
  end if;
  if j.link_id is not null then select * into strict l from tr8_private.google_event_links where id=j.link_id for update; end if;
  if p_result ? 'credential_envelope' then
    if not coalesce(tr8_private.v5_valid_envelope(p_result->'credential_envelope'),false) then raise exception using errcode='22023',message='Invalid encrypted credentials'; end if;
    update tr8_private.google_connections set credential_envelope=p_result->'credential_envelope' where id=c.id;
  end if;
  if v_outcome='needs_reauthorization' then
    update tr8_private.google_connections set state=case when state='disconnecting' then 'cleanup_failed' else 'needs_reauthorization' end,
      reason='reauthorization_required',version=version+1,updated_at=clock_timestamp() where id=c.id;
    v_outcome:='dead';v_reason:='reauthorization_required';
  elsif v_outcome='remote_missing' then
    if j.kind='upsert' then
      update tr8_private.google_event_links set state='remote_missing',updated_at=clock_timestamp() where id=l.id;
      update tr8_private.google_connections set reason='remote_missing',version=version+1 where id=c.id;
    else
      update tr8_private.google_connections set state='error',reason='remote_missing',version=version+1 where id=c.id;
    end if;
    v_outcome:='dead';v_reason:='remote_missing';
  elsif v_outcome='succeeded' then
    if j.kind='provision' then
      v_id:=p_result->>'calendar_id';
      if v_id is null or length(v_id) not between 1 and 1024 then raise exception using errcode='22023',message='Missing calendar identifier'; end if;
      -- Even if disconnected concurrently, retain the known ID and clean up
      -- only registered events. Never delete the remote calendar itself.
      update tr8_private.google_connections set calendar_id=v_id,
        state=case when state in ('provisioning','provisioning_unknown') then 'connected' else state end,
        reason=null,version=version+1,updated_at=clock_timestamp() where id=c.id;
      if c.state in ('provisioning','provisioning_unknown') then perform tr8_private.v5_enqueue(c.id,'reconcile_scan'); end if;
    elsif j.kind='upsert' then
      -- Recording a successful external request precedes eligibility repair.
      update tr8_private.google_event_links set synced_hash=j.prepared_hash,state='synced',updated_at=clock_timestamp() where id=l.id;
      if c.state in ('authorizing','needs_reauthorization') then
        -- Reauthorization pauses ordinary writes. It is not a request to erase
        -- existing copies; a successful reconnect queues a fresh ACL scan.
        null;
      elsif not tr8_private.v5_task_eligible(c.id,l.task_id,l.task_created_at) then
        if c.disconnect_mode='keep' and c.state in ('disconnecting','disconnected') then
          update tr8_private.google_event_links set state='retained' where id=l.id;
        else
          update tr8_private.google_event_links set state='deleting' where id=l.id;
          perform tr8_private.v5_enqueue(c.id,'delete',l.id);
        end if;
      elsif tr8_private.v5_task_hash(l.task_id) is distinct from j.prepared_hash then
        perform tr8_private.v5_enqueue(c.id,'upsert',l.id);v_continue:=true;
      end if;
      update tr8_private.google_connections set last_sync_at=clock_timestamp() where id=c.id;
    elsif j.kind='delete' then
      update tr8_private.google_event_links set state='deleted',updated_at=clock_timestamp() where id=l.id;
      if tr8_private.v5_task_eligible(c.id,l.task_id,l.task_created_at) then
        -- A delete raced with renewed eligibility. New remote incarnation;
        -- the prior identifier remains in this tombstone, never reused.
        update tr8_private.google_event_links set retired_event_ids=array_append(retired_event_ids,event_id),event_id=replace(gen_random_uuid()::text,'-',''),state='pending',synced_hash=null where id=l.id;
        perform tr8_private.v5_enqueue(c.id,'upsert',l.id);
      end if;
    elsif j.kind='revoke' then
      update tr8_private.google_connections set state='disconnected',credential_envelope=null,calendar_id=null,reason=null,
        disconnect_mode=null,version=version+1,updated_at=clock_timestamp() where id=c.id;
    elsif j.kind='reconcile_scan' then
      v_continue:=j.scan_more or j.desired_revision<>j.leased_revision;
    end if;
  elsif v_outcome='unknown' and j.kind='provision' then
    update tr8_private.google_connections set state='provisioning_unknown',reason='provisioning_unknown',version=version+1 where id=c.id;
  end if;
  if v_outcome='retry' and j.kind='provision' and c.state='provisioning_unknown' then
    -- Only a classified, known no-effect HTTP failure may choose retry.
    update tr8_private.google_connections set state='provisioning',reason='temporary_failure',version=version+1 where id=c.id;
  end if;
  if v_outcome in ('dead','unknown') and c.state='disconnecting' then
    update tr8_private.google_connections set state='cleanup_failed',reason='cleanup_failed',version=version+1 where id=c.id;
  end if;
  if v_outcome='retry' and j.attempts>=8 then v_outcome:='dead';v_reason:='attempt_limit'; end if;
  if v_outcome='dead' and c.state='disconnecting' then
    update tr8_private.google_connections set state='cleanup_failed',reason='cleanup_failed',version=version+1 where id=c.id;
  end if;
  if v_outcome='retry' then
    v_delay:=least(21600,greatest(coalesce((p_result->>'retry_after_seconds')::integer,0),least(21600,(30*power(2,j.attempts-1))::integer)+floor(random()*10)::integer));
  end if;
  if v_outcome='succeeded' and j.desired_revision<>j.leased_revision then v_continue:=true; end if;
  update tr8_private.google_jobs set state=case when v_continue then 'pending' else v_outcome end,
    attempts=case when v_continue then 0 else attempts end,
    cursor_id=case when desired_revision<>leased_revision then null else cursor_id end,
    reason=coalesce(v_reason,case v_outcome when 'succeeded' then 'reconciled' when 'retry' then 'temporary_failure' when 'dead' then 'permanent_failure' when 'unknown' then 'outcome_unknown' else 'cancelled' end),
    lease_token=null,lease_expires_at=null,available_at=case when v_outcome='retry' then clock_timestamp()+make_interval(secs=>v_delay) when v_continue then clock_timestamp() else available_at end,
    updated_at=clock_timestamp(),finished_at=case when v_continue or v_outcome='retry' then null else clock_timestamp() end where id=j.id;
  return true;
end; $$;

-- pg_net is only a wake-up transport. The durable state remains in the private
-- tables above; its unlogged HTTP queue cannot serve as the delivery ledger.
create extension if not exists pg_net with schema extensions;
create function tr8_private.v5_wake_worker()
returns boolean language plpgsql volatile security definer set search_path='' set statement_timeout='8s' set lock_timeout='500ms' as $$
declare cfg tr8_private.google_config; v_secret text; v_request bigint;
begin
  select * into cfg from tr8_private.google_config where singleton for update skip locked;
  if not found or not cfg.configured or not cfg.scheduler_enabled or cfg.worker_url is null
    or cfg.last_wake_at>clock_timestamp()-interval '55 seconds'
    or (cfg.day=(clock_timestamp() at time zone 'UTC')::date and cfg.used_today>=cfg.daily_limit)
    or (cfg.month=date_trunc('month',clock_timestamp() at time zone 'UTC')::date and cfg.used_month>=cfg.monthly_limit)
    or not exists(select 1 from tr8_private.google_jobs j join tr8_private.google_connections c on c.id=j.connection_id
      where j.generation=c.generation and ((j.state in ('pending','retry') and j.available_at<=clock_timestamp())
        or (j.state='leased' and j.lease_expires_at<=clock_timestamp()))
      and ((c.state='connected' and j.kind in ('upsert','delete','reconcile_scan'))
        or (c.state='provisioning' and j.kind='provision') or (c.state='disconnecting' and j.kind in ('delete','revoke')))) then return false; end if;
  if to_regclass('vault.decrypted_secrets') is null then return false; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name=$1 limit 1' into v_secret using cfg.worker_secret_name;
  if v_secret is null or length(v_secret)<32 then return false; end if;
  execute 'select net.http_post(url:=$1,headers:=$2,body:=$3,timeout_milliseconds:=50000)'
    into v_request using cfg.worker_url,jsonb_build_object('Content-Type','application/json','x-tr8-worker-secret',v_secret),'{}'::jsonb;
  update tr8_private.google_config set last_wake_at=clock_timestamp() where singleton;
  return v_request is not null;
end; $$;

create function tr8_private.v5_maintain()
returns integer language plpgsql volatile security definer set search_path='' set statement_timeout='8s' set lock_timeout='500ms' as $$
declare v_count integer; c tr8_private.google_connections; v_previous text;
begin
  -- Same connection-before-attempt lock order as begin/consume/complete. Skip
  -- active connections rather than deadlocking against an OAuth callback.
  for c in select g.* from tr8_private.google_connections g where
    exists(select 1 from tr8_private.google_oauth_attempts a where a.connection_id=g.id and a.expires_at<=clock_timestamp() and (a.pkce_envelope is not null or a.result_envelope is not null))
    or (g.state='authorizing' and not exists(select 1 from tr8_private.google_oauth_attempts a where a.connection_id=g.id and a.completed_at is null and a.expires_at>clock_timestamp()))
    order by g.id limit 100 for update of g skip locked loop
    update tr8_private.google_oauth_attempts set pkce_envelope=null,result_envelope=null,completed_at=coalesce(completed_at,clock_timestamp())
      where connection_id=c.id and expires_at<=clock_timestamp();
    if c.state='authorizing' and not exists(select 1 from tr8_private.google_oauth_attempts a where a.connection_id=c.id and a.completed_at is null and a.expires_at>clock_timestamp()) then
      select previous_state into v_previous from tr8_private.google_oauth_attempts where connection_id=c.id order by created_at desc,id limit 1;
      update tr8_private.google_connections set state=case when v_previous in ('needs_reauthorization','error') then v_previous
        when calendar_id is not null and credential_envelope is not null then 'connected' else 'disconnected' end,
        reason='oauth_expired',version=version+1,updated_at=clock_timestamp() where id=c.id;
    end if;
  end loop;
  delete from tr8_private.google_oauth_attempts where id in(select id from tr8_private.google_oauth_attempts where expires_at<clock_timestamp()-interval '1 day' order by expires_at limit 500);
  delete from tr8_private.google_request_receipts where id in(select id from tr8_private.google_request_receipts where reserved_at<clock_timestamp()-interval '32 days' order by reserved_at limit 1000);
  delete from tr8_private.google_requests where (user_id,request_id) in(select user_id,request_id from tr8_private.google_requests where created_at<clock_timestamp()-interval '32 days' order by created_at limit 500);
  -- Links and unresolved work survive. Removing their remote identifiers would
  -- prevent compensation after deletion/revocation or an ambiguous HTTP result.
  delete from cron.job_run_details where runid in(select r.runid from cron.job_run_details r join cron.job j on j.jobid=r.jobid
    where j.jobname in ('tr8-google-worker','tr8-google-maintenance') and r.end_time<clock_timestamp()-interval '7 days' order by r.end_time,r.runid limit 1000);
  get diagnostics v_count=row_count;
  return v_count;
end; $$;

do $stage5_grants$
declare t text; f record;
begin
  foreach t in array array['google_config','google_connections','google_oauth_attempts','google_event_links','google_jobs','google_requests','google_request_receipts'] loop
    execute format('alter table tr8_private.%I enable row level security',t);
    execute format('revoke all on table tr8_private.%I from public,anon,authenticated,service_role',t);
  end loop;
  for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='tr8_private' and p.proname like 'v5_%')
      or (n.nspname='public' and p.proname in ('tr8_server_google','tr8_v2_get_google_status')) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
    if f.proname in ('tr8_v2_get_google_status','v5_get_status') then execute format('grant execute on function %s to authenticated',f.signature);
    elsif f.proname in ('tr8_server_google','v5_server') then execute format('grant execute on function %s to service_role',f.signature);end if;
  end loop;
end; $stage5_grants$;
grant usage on schema tr8_private to service_role;

-- Both schedules start disabled. Enabling needs deployed endpoints, encrypted
-- credential keys, consent audit and Vault wake secret; creating this migration
-- cannot perform HTTP or enable external registrations.
select cron.schedule('tr8-google-worker','* * * * *',$cron$set statement_timeout='8s'; set lock_timeout='500ms'; select tr8_private.v5_wake_worker();$cron$);
select cron.schedule('tr8-google-maintenance','23 3 * * *',$cron$set statement_timeout='8s'; set lock_timeout='500ms'; select tr8_private.v5_maintain();$cron$);
do $$ declare j record; begin for j in select jobid from cron.job where jobname in ('tr8-google-worker','tr8-google-maintenance') loop perform cron.alter_job(j.jobid,active:=false);end loop;end $$;

do $stage5_preservation$
declare s record;
begin
  select * into strict s from tr8_stage5_snapshot;
  if s.projects_oid<>'public.tr8_workspace_projects'::regclass::oid or s.tasks_oid<>'public.tr8_workspace_tasks'::regclass::oid
    or s.projects_hash is distinct from (select md5(coalesce(string_agg(to_jsonb(p)::text,E'\n' order by id),'')) from public.tr8_workspace_projects p)
    or s.tasks_hash is distinct from (select md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by id),'')) from public.tr8_workspace_tasks t)
    or s.users_hash is distinct from (select md5(coalesce(string_agg(to_jsonb(a)::text,E'\n' order by user_id),'')) from tr8_private.app_users a)
    or s.sequence_state is distinct from (select jsonb_build_object('last_value',q.last_value,'is_called',q.is_called) from public.tr8_tasks_task_number_seq q)
    or s.app_config is distinct from (select to_jsonb(c) from tr8_private.app_config c where singleton)
    or s.old_api is distinct from (select jsonb_object_agg(p.oid::text,jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','tr8_private')
      and (p.proname like 'tr8_v2_%' or p.proname like 'v2_%' or p.proname like 'v3_%' or p.proname like 'v4_%'
        or p.proname in ('guard_task','guard_project')) and p.proname<>'tr8_v2_get_google_status')
    or exists(select 1 from tr8_private.google_connections) or exists(select 1 from tr8_private.google_jobs)
    or (select configured or scheduler_enabled from tr8_private.google_config where singleton)
    or exists(select 1 from cron.job where jobname in ('tr8-google-worker','tr8-google-maintenance') and active) then
    raise exception 'Stage 5 modified historical data, APIs, sequence, settings or enabled an unconfigured integration';
  end if;
end; $stage5_preservation$;
comment on table tr8_private.google_connections is 'Google OAuth connection per TR8 user. AES-GCM envelopes only; keys and OAuth client secrets remain outside PostgreSQL.';
comment on table tr8_private.google_event_links is 'Durable random event identifiers and task incarnation tombstones. No cascade from projects/tasks; external cleanup never requires their private content.';
comment on table tr8_private.google_jobs is 'Google-only two-phase lease queue, independent of stage 4 internal reconciliation. Unknown calendar creation is never automatically replayed.';
notify pgrst,'reload schema';
