-- Stage 6b: opt-in export of future TR8 tasks. No domain rows are backfilled.
-- A durable intent precedes POST; an uncertain POST is never automatically repeated.
lock table public.tr8_workspace_projects, public.tr8_workspace_tasks,
  tr8_private.google_tasks_sync, tr8_private.google_tasks_links,
  tr8_private.google_tasks_jobs in access exclusive mode nowait;
create temporary table tr8_stage6b_snapshot on commit drop as select
  (select md5(coalesce(string_agg(to_jsonb(p)::text,E'\n' order by id),'')) from public.tr8_workspace_projects p) projects,
  (select md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by id),'')) from public.tr8_workspace_tasks t) tasks,
  (select to_jsonb(c) from tr8_private.app_config c where singleton) app_config,
  (select count(*) from tr8_private.google_tasks_links) links,
  (select count(*) from tr8_private.google_tasks_jobs) jobs,
  (select jsonb_build_object('last_value',q.last_value,'is_called',q.is_called) from public.tr8_tasks_task_number_seq q) sequence_state;

alter table tr8_private.google_tasks_sync
  add column export_enabled boolean not null default false,
  add column export_list_id text,
  add column export_enabled_at timestamptz,
  add constraint google_tasks_export_list_length check(export_list_id is null or length(export_list_id) between 1 and 1024),
  add constraint google_tasks_export_enabled_check check(not export_enabled or (export_list_id is not null and export_enabled_at is not null));
alter table tr8_private.google_tasks_links
  alter column remote_task_id drop not null,
  add column origin text not null default 'google' check(origin in ('google','tr8')),
  add column creation_state text check(creation_state in ('ready','uncertain','bound','blocked')),
  add column creation_marker text unique,
  add column creation_projection jsonb,
  add column creation_hash text,
  add column cleanup_requested boolean not null default false,
  add column recovery_candidate jsonb,
  add column recovery_matches integer not null default 0 check(recovery_matches>=0),
  add constraint google_tasks_creation_shape check(
    (origin='google' and remote_task_id is not null and creation_state is null and creation_marker is null)
    or (origin='tr8' and creation_state is not null and creation_marker is not null and creation_marker ~ '^tr8:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and (creation_state<>'bound' or remote_task_id is not null)));
alter table tr8_private.google_tasks_jobs drop constraint google_tasks_jobs_kind_check;
alter table tr8_private.google_tasks_jobs add constraint google_tasks_jobs_kind_check check(kind in ('discover','pull','patch','delete','create'));
alter table tr8_private.google_tasks_jobs drop constraint google_tasks_jobs_check;
alter table tr8_private.google_tasks_jobs add constraint google_tasks_jobs_check check((kind in ('patch','delete','create'))=(link_id is not null));
alter table tr8_private.google_request_receipts drop constraint google_request_receipts_purpose_check;
alter table tr8_private.google_request_receipts add constraint google_request_receipts_purpose_check
  check(purpose in ('oauth','refresh','calendar_create','calendar_get','event_get','event_upsert','event_delete','event_list','revoke',
    'tasks_lists','tasks_list','tasks_get','tasks_patch','tasks_delete','tasks_insert'));

-- The arbitrary-user helpers remain private and receive no client grant.
create function tr8_private.v7_domain_permission(p_workspace uuid,p_project uuid,p_user uuid,p_permission text)
returns boolean language sql stable security definer set search_path='' as $$
  select tr8_private.v2_project_readable_for(p_workspace,p_project,p_user,true)
    and p_permission=any(tr8_private.v2_permissions_for(p_workspace,p_user))
    and exists(select 1 from public.tr8_workspace_projects p join tr8_private.workspaces w on w.id=p.workspace_id
      where p.id=p_project and p.workspace_id=p_workspace and p.archived_at is null
        and (w.owner_id=p_user or exists(select 1 from tr8_private.workspace_members m
          join tr8_private.project_access a on a.workspace_id=m.workspace_id and a.member_id=m.id
          where m.workspace_id=w.id and m.user_id=p_user and m.status='active' and a.project_id=p.id and a.access_level='write')));
$$;
create function tr8_private.v7_task_eligible(p_connection uuid,p_task uuid,p_created timestamptz)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from tr8_private.google_connections c
    join public.tr8_workspace_tasks t on t.id=p_task and t.created_at=p_created
    join tr8_private.workspaces w on w.id=t.workspace_id
    join public.tr8_workspace_projects p on p.workspace_id=w.id and p.id=t.project_id and p.archived_at is null
    left join tr8_private.workspace_members m on m.workspace_id=w.id and m.id=t.assignee_member_id and m.status='active'
    where c.id=p_connection and tr8_private.v2_project_readable_for(w.id,p.id,c.user_id,true)
      and ((w.kind='personal' and w.owner_id=c.user_id) or (w.kind='team' and m.user_id=c.user_id)));
$$;

-- AFTER INSERT would run after another outbox trigger. This BEFORE intent
-- excludes Calendar even before the task row is visible to its own outbox.
create function tr8_private.v7_capture_new_task()
returns trigger language plpgsql security definer set search_path='' as $$
declare r record; v_link uuid; v_event record;
begin
  if exists(select 1 from tr8_private.google_tasks_links where local_task_id=new.id and local_task_created_at=new.created_at and origin='google') then return new;end if;
  for r in select c.id,c.generation,s.export_list_id from tr8_private.google_connections c
    join tr8_private.google_tasks_sync s on s.connection_id=c.id and s.generation=c.generation and s.enabled and s.export_enabled
    join tr8_private.google_tasks_lists z on z.connection_id=c.id and z.generation=c.generation and z.list_id=s.export_list_id and z.selected
    join tr8_private.workspaces w on w.id=new.workspace_id
    join public.tr8_workspace_projects p on p.workspace_id=w.id and p.id=new.project_id and p.archived_at is null
    left join tr8_private.workspace_members m on m.workspace_id=w.id and m.id=new.assignee_member_id and m.status='active'
    where c.state='connected' and c.tasks_granted and c.credential_envelope is not null
      and s.export_enabled_at<=new.created_at
      and tr8_private.v2_project_readable_for(w.id,p.id,c.user_id,true)
      and ((w.kind='personal' and w.owner_id=c.user_id) or (w.kind='team' and m.user_id=c.user_id))
    order by c.id loop
    if exists(select 1 from tr8_private.google_tasks_links where connection_id=r.id and local_task_id=new.id and local_task_created_at=new.created_at) then continue;end if;
    insert into tr8_private.google_tasks_links(connection_id,generation,list_id,workspace_id,project_id,local_task_id,local_task_created_at,
      state,origin,creation_state,creation_marker)
      values(r.id,r.generation,r.export_list_id,new.workspace_id,new.project_id,new.id,new.created_at,'dirty','tr8','ready','tr8:'||gen_random_uuid())
      on conflict(connection_id,generation,local_task_id,local_task_created_at) do nothing returning id into v_link;
    if v_link is not null then
      -- Assignment is a separate UI RPC. An event from an earlier scan is
      -- retired by its exact identity before Tasks can post this new intent.
      for v_event in select id from tr8_private.google_event_links where connection_id=r.id and generation=r.generation
        and task_id=new.id and task_created_at=new.created_at and state not in ('deleted','retained') loop
        update tr8_private.google_event_links set state='deleting' where id=v_event.id;
        perform tr8_private.v5_enqueue(r.id,'delete',v_event.id);
      end loop;
      perform tr8_private.v6_enqueue(r.id,'create',v_link,r.export_list_id);
    end if;
  end loop;
  return new;
end; $$;
create trigger tr8_zz_google_tasks_new before insert or update on public.tr8_workspace_tasks
  for each row execute function tr8_private.v7_capture_new_task();

create or replace function tr8_private.v6_capture_task()
returns trigger language plpgsql security definer set search_path='' as $$
declare l tr8_private.google_tasks_links; r record; v_hash text;
begin
  if tg_op='DELETE' then r:=old;else r:=new;end if;
  v_hash:=case when tg_op='DELETE' then null else tr8_private.v6_projection_hash(jsonb_build_object('title',r.title,'completed',r.status='done','start_date',r.start_date)) end;
  for l in select * from tr8_private.google_tasks_links where local_task_id=r.id and local_task_created_at=r.created_at for update loop
    if l.state in ('deleted','retained') or (tg_op<>'DELETE' and v_hash is not distinct from l.synced_local_hash) then continue;end if;
    if l.origin='tr8' and l.remote_task_id is null then
      update tr8_private.google_tasks_links set revision=revision+1,cleanup_requested=cleanup_requested or tg_op='DELETE',updated_at=clock_timestamp()
        where id=l.id;
      -- A ready intent has not crossed the HTTP boundary; a deleted task can
      -- be retired. An uncertain one must recover its identity for cleanup.
      if tg_op='DELETE' and l.creation_state='ready' then
        update tr8_private.google_tasks_links set state='deleted',creation_state='blocked',conflict_reason=null where id=l.id;
        update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='local_deleted',finished_at=clock_timestamp()
          where link_id=l.id and state in ('pending','retry','leased');
      end if;
      continue;
    end if;
    update tr8_private.google_tasks_links set state=case when state='conflict' then state when tg_op='DELETE' then 'deleting' else 'dirty' end,resolution=null,
      revision=revision+1,updated_at=clock_timestamp() where id=l.id;
    if l.state='conflict' then continue;end if;
    if exists(select 1 from tr8_private.google_connections c join tr8_private.google_tasks_sync s on s.connection_id=c.id and s.generation=c.generation
      join tr8_private.google_tasks_lists z on z.connection_id=c.id and z.generation=c.generation and z.list_id=l.list_id and z.selected
      where c.id=l.connection_id and c.generation=l.generation and c.state='connected' and c.tasks_granted and s.enabled) then
      perform tr8_private.v6_enqueue(l.connection_id,case when tg_op='DELETE' then 'delete' else 'patch' end,l.id,l.list_id);
    end if;
  end loop;
  return null;
end; $$;

create function tr8_private.v7_begin_create(p_job uuid,p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare j tr8_private.google_tasks_jobs;l tr8_private.google_tasks_links;v_prepared jsonb;v_projection jsonb;v_hash text;
begin
  v_prepared:=tr8_private.v6_prepare(p_job,p_token);
  if v_prepared->>'valid'<>'true' or v_prepared->>'kind'<>'create' then return jsonb_build_object('allowed',false);end if;
  select * into strict j from tr8_private.google_tasks_jobs where id=p_job;
  select * into strict l from tr8_private.google_tasks_links where id=j.link_id;
  perform tr8_private.v2_lock_workspace(l.workspace_id);
  perform 1 from public.tr8_workspace_projects where id=l.project_id and workspace_id=l.workspace_id for share;
  perform 1 from public.tr8_workspace_tasks where id=l.local_task_id and created_at=l.local_task_created_at for share;
  select * into strict l from tr8_private.google_tasks_links where id=l.id for update;
  if l.creation_state<>'ready' or l.remote_task_id is not null or l.cleanup_requested
    or not tr8_private.v7_task_eligible(j.connection_id,l.local_task_id,l.local_task_created_at)
    or not exists(select 1 from tr8_private.google_request_receipts where job_id=j.id and lease_token=p_token and purpose='tasks_insert') then
    return jsonb_build_object('allowed',false);
  end if;
  v_projection:=tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at);v_hash:=tr8_private.v6_projection_hash(v_projection);
  update tr8_private.google_tasks_links set creation_state='uncertain',creation_projection=v_projection,creation_hash=v_hash,
    recovery_candidate=null,recovery_matches=0,updated_at=clock_timestamp() where id=l.id;
  update tr8_private.google_tasks_jobs set prepared_hash=v_hash,page_token=null,page_more=false where id=j.id;
  return jsonb_build_object('allowed',true,'marker',l.creation_marker,'projection',v_projection,'prepared_hash',v_hash);
end; $$;

-- Identity attachment is shared by a known POST response and later marker
-- recovery. It never imports a second task and never changes a local projection.
create function tr8_private.v7_bind_observed(p_link uuid,p_remote jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare l tr8_private.google_tasks_links;c tr8_private.google_connections;v_remote jsonb;v_local jsonb;v_cleanup boolean;v_state text;v_result jsonb;
begin
  select * into strict l from tr8_private.google_tasks_links where id=p_link;
  select * into strict c from tr8_private.google_connections where id=l.connection_id;
  perform tr8_private.v2_lock_workspace(l.workspace_id);
  perform 1 from public.tr8_workspace_projects where id=l.project_id and workspace_id=l.workspace_id for share;
  perform 1 from public.tr8_workspace_tasks where id=l.local_task_id and created_at=l.local_task_created_at for share;
  select * into strict l from tr8_private.google_tasks_links where id=l.id for update;
  v_remote:=tr8_private.v6_remote_projection(p_remote-'creation_marker');
  if l.conflict_reason='creation_duplicate' then return jsonb_build_object('applied',true,'blocked',true);end if;
  if l.origin<>'tr8' or l.creation_state='ready' or v_remote is null or coalesce((p_remote->>'assigned')::boolean,false)
    or p_remote->>'creation_marker' is distinct from l.creation_marker then raise exception using errcode='22023',message='Invalid creation identity receipt';end if;
  if l.remote_task_id is not null and l.remote_task_id is distinct from p_remote->>'id' then
    update tr8_private.google_tasks_links set creation_state='blocked',state='conflict',conflict_reason='creation_duplicate' where id=l.id;
    return jsonb_build_object('applied',true,'blocked',true);
  end if;
  if exists(select 1 from tr8_private.google_tasks_links x where x.connection_id=c.id and x.generation=c.generation and x.list_id=l.list_id
    and x.remote_task_id=p_remote->>'id' and x.id<>l.id) then
    update tr8_private.google_tasks_links set creation_state='blocked',state='conflict',conflict_reason='creation_duplicate' where id=l.id;
    return jsonb_build_object('applied',true,'blocked',true);
  end if;
  v_local:=tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at);
  v_cleanup:=l.cleanup_requested or v_local is null or not tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at);
  v_state:=case when v_cleanup then 'deleting' when tr8_private.v6_projection_hash(v_local) is distinct from l.creation_hash then 'dirty' else 'synced' end;
  update tr8_private.google_tasks_links set generation=c.generation,remote_task_id=p_remote->>'id',creation_state='bound',state=v_state,
    remote_etag=p_remote->>'etag',remote_projection=v_remote,base_projection_hash=l.creation_hash,
    synced_local_hash=l.creation_hash,cleanup_requested=v_cleanup,resolution=null,conflict_reason=null,updated_at=clock_timestamp() where id=l.id;
  if v_cleanup then perform tr8_private.v6_enqueue(c.id,'delete',l.id,l.list_id);
  else
    -- Recovery may observe a remote edit made after the uncertain POST. The
    -- creation snapshot, not this newer read, is the common comparison base.
    v_result:=tr8_private.v6_observe(c.id,l.list_id,p_remote);
    if v_result->>'action' in ('patch','delete') then
      perform tr8_private.v6_enqueue(c.id,v_result->>'action',l.id,l.list_id);
    end if;
  end if;
  return jsonb_build_object('applied',true,'link_id',l.id);
end; $$;

create function tr8_private.v7_bind_create(p_job uuid,p_token uuid,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare j tr8_private.google_tasks_jobs;l tr8_private.google_tasks_links;v_prepared jsonb;
begin
  v_prepared:=tr8_private.v6_prepare(p_job,p_token);
  if v_prepared->>'valid'<>'true' or v_prepared->>'kind'<>'create' then return jsonb_build_object('applied',false);end if;
  select * into strict j from tr8_private.google_tasks_jobs where id=p_job;
  select * into strict l from tr8_private.google_tasks_links where id=j.link_id;
  if l.creation_state not in ('uncertain','bound') or p_payload->>'prepared_hash' is distinct from l.creation_hash then
    raise exception using errcode='22023',message='Changed creation projection receipt';end if;
  return tr8_private.v7_bind_observed(l.id,p_payload->'remote');
end; $$;

create function tr8_private.v7_recover_create_page(p_job uuid,p_token uuid,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare j tr8_private.google_tasks_jobs;l tr8_private.google_tasks_links;v_prepared jsonb;r jsonb;v_next text;v_projection jsonb;
begin
  v_prepared:=tr8_private.v6_prepare(p_job,p_token);
  if v_prepared->>'valid'<>'true' or v_prepared->>'kind'<>'create' then return jsonb_build_object('applied',false);end if;
  select * into strict j from tr8_private.google_tasks_jobs where id=p_job;
  select * into strict l from tr8_private.google_tasks_links where id=j.link_id;
  perform tr8_private.v2_lock_workspace(l.workspace_id);
  perform 1 from public.tr8_workspace_projects where id=l.project_id and workspace_id=l.workspace_id for share;
  perform 1 from public.tr8_workspace_tasks where id=l.local_task_id and created_at=l.local_task_created_at for share;
  select * into strict l from tr8_private.google_tasks_links where id=l.id for update;
  if l.creation_state<>'uncertain' or not coalesce((p_payload ? 'page_token') and p_payload->>'page_token' is not distinct from j.page_token
    and jsonb_typeof(p_payload->'items')='array' and jsonb_array_length(p_payload->'items')<=100
    and (p_payload ? 'next_page_token') and jsonb_typeof(p_payload->'next_page_token') in ('string','null'),false) then return jsonb_build_object('applied',false);end if;
  v_next:=p_payload->>'next_page_token';
  if length(v_next)>4096 or v_next='' or (v_next is not null and v_next=j.page_token) then raise exception using errcode='22023',message='Invalid creation recovery cursor';end if;
  for r in select value from jsonb_array_elements(p_payload->'items') loop
    if r->>'creation_marker' is distinct from l.creation_marker then continue;end if;
    v_projection:=tr8_private.v6_remote_projection(r-'creation_marker');
    if v_projection is null or coalesce((r->>'assigned')::boolean,false) then continue;end if;
    if l.recovery_candidate is null then l.recovery_candidate:=r;l.recovery_matches:=1;
    elsif l.recovery_candidate->>'id' is distinct from r->>'id' then l.recovery_matches:=l.recovery_matches+1;end if;
  end loop;
  update tr8_private.google_tasks_links set recovery_candidate=l.recovery_candidate,recovery_matches=l.recovery_matches where id=l.id;
  update tr8_private.google_tasks_jobs set page_token=v_next,page_more=v_next is not null where id=j.id;
  if v_next is null then
    if l.recovery_matches=1 then return tr8_private.v7_bind_observed(l.id,l.recovery_candidate)||jsonb_build_object('more',false);end if;
    update tr8_private.google_tasks_links set creation_state='blocked',state='conflict',conflict_reason=case when l.recovery_matches=0 then 'creation_uncertain' else 'creation_duplicate' end where id=l.id;
    update tr8_private.google_tasks_sync set reason='creation_uncertain' where connection_id=j.connection_id;
  end if;
  return jsonb_build_object('applied',true,'more',v_next is not null);
end; $$;
create or replace function tr8_private.v6_remote_projection(p_remote jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare v_date date;
begin
  if not coalesce(p_remote is not null and jsonb_typeof(p_remote)='object' and length(p_remote::text)<=8192
    and (p_remote-array['id','etag','title','completed','start_date','deleted','assigned','creation_marker'])='{}'::jsonb
    and jsonb_typeof(p_remote->'id')='string' and length(p_remote->>'id') between 1 and 1024
    and (p_remote->>'id') !~ '[[:cntrl:]]' and jsonb_typeof(p_remote->'deleted')='boolean',false) then
    raise exception using errcode='22023',message='Invalid normalized Google Task';
  end if;
  if p_remote ? 'creation_marker' and (jsonb_typeof(p_remote->'creation_marker')<>'string'
    or (p_remote->>'creation_marker') !~ '^tr8:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception using errcode='22023',message='Invalid creation marker';end if;
  if (p_remote->>'deleted')::boolean then return null;end if;
  if not coalesce(jsonb_typeof(p_remote->'title')='string' and length(btrim(p_remote->>'title')) between 1 and 500
    and jsonb_typeof(p_remote->'completed')='boolean' and jsonb_typeof(p_remote->'assigned')='boolean'
    and jsonb_typeof(p_remote->'etag')='string' and length(p_remote->>'etag') between 1 and 2048
    and (p_remote ? 'start_date') and jsonb_typeof(p_remote->'start_date') in ('string','null'),false) then
    raise exception using errcode='22023',message='Unsupported normalized Google Task';
  end if;
  if p_remote->>'start_date' is not null then
    if (p_remote->>'start_date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception using errcode='22023',message='Invalid Google Task date';end if;
    begin v_date:=(p_remote->>'start_date')::date;exception when others then raise exception using errcode='22023',message='Invalid Google Task date';end;
    if not isfinite(v_date) or v_date<'0001-01-01'::date or v_date>='10000-01-01'::date then raise exception using errcode='22023',message='Invalid Google Task date';end if;
  end if;
  return jsonb_build_object('title',btrim(p_remote->>'title'),'completed',(p_remote->>'completed')::boolean,'start_date',v_date);
end; $$;

create or replace function tr8_private.v6_prepare(p_job uuid,p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare j tr8_private.google_tasks_jobs; c tr8_private.google_connections; l tr8_private.google_tasks_links; v_local jsonb; v_result jsonb;
begin
  select * into j from tr8_private.google_tasks_jobs where id=p_job;
  if not found then return jsonb_build_object('valid',false);end if;
  select * into strict c from tr8_private.google_connections where id=j.connection_id for no key update;
  select * into j from tr8_private.google_tasks_jobs where id=p_job;
  if not found or j.state<>'leased' or j.lease_token is distinct from p_token or j.lease_expires_at<=clock_timestamp()
    or c.generation<>j.generation or c.state<>'connected' or not c.tasks_granted or c.credential_envelope is null
    or not tr8_private.v2_user_live(c.user_id) or not exists(select 1 from tr8_private.app_users where user_id=c.user_id and enabled)
    or not exists(select 1 from tr8_private.google_tasks_sync s where s.connection_id=c.id and s.generation=c.generation and s.enabled)
    or (j.kind<>'discover' and not exists(select 1 from tr8_private.google_tasks_lists z where z.connection_id=c.id and z.generation=c.generation and z.list_id=j.list_id and z.selected)) then
    return jsonb_build_object('valid',false);
  end if;
  v_result:=jsonb_build_object('valid',true,'kind',j.kind,'connection_id',c.id,'user_id',c.user_id,'generation',c.generation,
    'calendar_id',c.calendar_id,'credential_envelope',c.credential_envelope,
    'time_zone',coalesce((select calendar_time_zone from tr8_private.app_users where user_id=c.user_id),'UTC'));
  if j.kind in ('discover','pull') then return v_result||jsonb_build_object('list_id',j.list_id,'page_token',j.page_token);end if;
  select * into l from tr8_private.google_tasks_links where id=j.link_id;
  if not found or l.connection_id<>c.id or l.generation<>c.generation or l.list_id is distinct from j.list_id then
    return jsonb_build_object('valid',false);
  end if;
  if j.kind='create' then
    if l.origin<>'tr8' or l.creation_state not in ('ready','uncertain','bound') or l.state in ('deleted','retained','conflict') then
      update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='creation_inactive',finished_at=clock_timestamp() where id=j.id;
      return jsonb_build_object('valid',false);
    end if;
    if l.creation_state='ready' and exists(select 1 from tr8_private.google_event_links e
      where e.connection_id=c.id and e.task_id=l.local_task_id and e.task_created_at=l.local_task_created_at and e.state not in ('deleted','retained')) then
      return jsonb_build_object('valid',false);
    end if;
    -- Uncertain creates remain recoverable after local deletion or loss of
    -- access. Recovery attaches the ID and queues cleanup, never new content.
    if l.creation_state='ready' and (l.cleanup_requested or not tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at)) then
      update tr8_private.google_tasks_links set state='retained',creation_state='blocked',conflict_reason=null where id=l.id;
      update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='access_changed',finished_at=clock_timestamp() where id=j.id;
      return jsonb_build_object('valid',false);
    end if;
    return v_result||jsonb_build_object('list_id',j.list_id,'page_token',j.page_token,
      'link',jsonb_build_object('id',l.id,'remote_task_id',l.remote_task_id),'create_state',l.creation_state,
      'creation_marker',l.creation_marker,'creation_projection',l.creation_projection,'prepared_hash',l.creation_hash,
      'local',tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at));
  end if;
  if l.state in ('deleted','retained','conflict') then
    update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='link_inactive',finished_at=clock_timestamp() where id=j.id;
    return jsonb_build_object('valid',false);
  end if;
  if l.origin='tr8' then
    if l.cleanup_requested or (tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at) is not null
      and not tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at)) then
      update tr8_private.google_tasks_links set cleanup_requested=true,state='deleting' where id=l.id;
    end if;
  elsif not exists(select 1 from tr8_private.workspaces w join public.tr8_workspace_projects p on p.workspace_id=w.id
    where w.id=l.workspace_id and w.kind='personal' and w.owner_id=c.user_id and p.id=l.project_id and p.archived_at is null) then
    update tr8_private.google_tasks_sync set reason='project_archived' where connection_id=c.id;
    update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='project_archived',finished_at=clock_timestamp() where id=j.id;
    return jsonb_build_object('valid',false);
  end if;
  v_local:=tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at);
  return v_result||jsonb_build_object('list_id',j.list_id,'link',jsonb_build_object('id',l.id,'remote_task_id',l.remote_task_id),
    'local',case when v_local is null then null else v_local||jsonb_build_object('id',l.local_task_id) end,'previously_synced',true);
end; $$;

create or replace function tr8_private.v6_reserve(p_job uuid,p_token uuid,p_purpose text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare j tr8_private.google_tasks_jobs; cfg tr8_private.google_config; v_prepared jsonb; v_now timestamptz:=clock_timestamp();v_id uuid;
begin
  if p_purpose is null or p_purpose not in ('refresh','tasks_lists','tasks_list','tasks_get','tasks_patch','tasks_delete','tasks_insert') then
    raise exception using errcode='22023',message='Invalid Tasks request purpose';
  end if;
  v_prepared:=tr8_private.v6_prepare(p_job,p_token);
  if v_prepared->>'valid'<>'true' then return jsonb_build_object('allowed',false,'reason','lease_expired');end if;
  select * into strict j from tr8_private.google_tasks_jobs where id=p_job;
  if (p_purpose='tasks_lists' and j.kind<>'discover') or (p_purpose='tasks_list' and j.kind not in ('pull','create'))
    or (p_purpose='tasks_insert' and (j.kind<>'create' or v_prepared->>'create_state'<>'ready'))
    or (p_purpose in ('tasks_get','tasks_patch','tasks_delete') and j.kind not in ('patch','delete')) then
    raise exception using errcode='22023',message='Mismatched Tasks request purpose';
  end if;
  select * into strict cfg from tr8_private.google_config where singleton for update;
  if not cfg.configured then return jsonb_build_object('allowed',false,'reason','config_pending');end if;
  if cfg.day<>(v_now at time zone 'UTC')::date then cfg.day:=(v_now at time zone 'UTC')::date;cfg.used_today:=0;end if;
  if cfg.month<>date_trunc('month',v_now at time zone 'UTC')::date then cfg.month:=date_trunc('month',v_now at time zone 'UTC')::date;cfg.used_month:=0;end if;
  if cfg.used_today>=cfg.daily_limit or cfg.used_month>=cfg.monthly_limit then
    update tr8_private.google_tasks_sync set reason='budget_exhausted' where connection_id=j.connection_id;
    return jsonb_build_object('allowed',false,'reason','budget_exhausted');
  end if;
  update tr8_private.google_config set day=cfg.day,used_today=cfg.used_today+1,month=cfg.month,used_month=cfg.used_month+1 where singleton;
  insert into tr8_private.google_request_receipts(connection_id,job_id,lease_token,purpose) values(j.connection_id,j.id,j.lease_token,p_purpose) returning id into v_id;
  return jsonb_build_object('allowed',true,'receipt_id',v_id);
end; $$;

create or replace function tr8_private.v6_observe(p_connection uuid,p_list text,p_remote jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c tr8_private.google_connections; l tr8_private.google_tasks_links; t public.tr8_workspace_tasks;
  v_remote jsonb; v_local jsonb; v_remote_hash text; v_local_hash text; v_project jsonb;
  v_remote_changed boolean; v_local_changed boolean; v_deleted boolean; v_id uuid; v_created timestamptz;v_candidates bigint;v_adopt boolean:=false;
begin
  v_remote:=tr8_private.v6_remote_projection(p_remote);v_deleted:=v_remote is null;
  if coalesce((p_remote->>'assigned')::boolean,false) then return jsonb_build_object('action','none','skipped',true);end if;
  select * into strict c from tr8_private.google_connections where id=p_connection;
  select * into l from tr8_private.google_tasks_links where connection_id=c.id and generation=c.generation and list_id=p_list and remote_task_id=p_remote->>'id';
  if p_remote ? 'creation_marker' then
    if l.id is null then
      select * into l from tr8_private.google_tasks_links where connection_id=c.id and list_id=p_list and origin='tr8'
        and creation_marker=p_remote->>'creation_marker';
      if l.id is null then return jsonb_build_object('action','none','skipped',true);end if;
      -- An ordinary pull cannot prove that this marker occurs only once in
      -- the complete list. Quarantine it until dedicated paginated recovery.
      if not v_deleted and l.creation_state='bound' and l.remote_task_id=p_remote->>'id' then
        v_adopt:=l.generation<>c.generation;
      else
        if not v_deleted and l.creation_state<>'ready' and l.conflict_reason is distinct from 'creation_duplicate' then
          if l.creation_state='blocked' and l.remote_task_id is null then
            update tr8_private.google_tasks_links set creation_state='uncertain',state='dirty',conflict_reason=null,
              recovery_candidate=null,recovery_matches=0 where id=l.id;
          end if;
          if l.remote_task_id is null then
            update tr8_private.google_tasks_links set generation=c.generation where id=l.id;
            if not exists(select 1 from tr8_private.google_tasks_jobs where connection_id=c.id and generation=c.generation
              and link_id=l.id and kind='create' and state in ('pending','retry','leased')) then
              perform tr8_private.v6_enqueue(c.id,'create',l.id,p_list);
            end if;
          end if;
        end if;
        return jsonb_build_object('action','none','link_id',l.id,'skipped',true);
      end if;
    elsif l.origin='tr8' and l.creation_marker is distinct from p_remote->>'creation_marker' then
      return jsonb_build_object('action','none','skipped',true);
    end if;
  end if;
  if l.id is not null and l.origin='tr8' then
    if l.cleanup_requested or (tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at) is not null
      and not tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at)) then
      update tr8_private.google_tasks_links set cleanup_requested=true,state=case when v_deleted then 'retained' else 'deleting' end,
        remote_projection=v_remote,remote_etag=p_remote->>'etag' where id=l.id;
      return jsonb_build_object('action',case when v_deleted then 'none' else 'delete' end,'link_id',l.id,'etag',p_remote->>'etag',
        'prepared_hash',null);
    end if;
  end if;
  if l.id is null and not v_deleted and p_list<>'@default' then
    -- A new grant proved access to the exact canonical resource path. Adopt
    -- its historical local identity, never a title match or another connection.
    select count(*) into v_candidates from tr8_private.google_tasks_links x
      join tr8_private.workspaces w on w.id=x.workspace_id and w.kind='personal' and w.owner_id=c.user_id
      where x.connection_id=c.id and x.list_id=p_list and x.remote_task_id=p_remote->>'id';
    if v_candidates>1 then
      update tr8_private.google_tasks_sync set reason='identity_conflict' where connection_id=c.id;
      return jsonb_build_object('action','conflict','reason','identity_conflict');
    elsif v_candidates=1 then
      select x.* into l from tr8_private.google_tasks_links x
        join tr8_private.workspaces w on w.id=x.workspace_id and w.kind='personal' and w.owner_id=c.user_id
        where x.connection_id=c.id and x.list_id=p_list and x.remote_task_id=p_remote->>'id';
      v_adopt:=true;
    end if;
  end if;
  if l.id is null then
    if v_deleted then return jsonb_build_object('action','none','skipped',true);end if;
    v_project:=tr8_private.v6_ensure_import_project(c.id);
    perform tr8_private.v2_lock_workspace((v_project->>'workspace_id')::uuid);
    perform 1 from public.tr8_workspace_projects p where p.id=(v_project->>'project_id')::uuid and p.workspace_id=(v_project->>'workspace_id')::uuid and p.archived_at is null for share;
    if not found then return jsonb_build_object('action','none','skipped',true,'reason','project_archived');end if;
    v_id:=gen_random_uuid();v_created:=statement_timestamp();v_remote_hash:=tr8_private.v6_projection_hash(v_remote);
    insert into tr8_private.google_tasks_links(connection_id,generation,list_id,remote_task_id,workspace_id,project_id,local_task_id,local_task_created_at,
      remote_etag,remote_projection,base_projection_hash,synced_local_hash)
      values(c.id,c.generation,p_list,p_remote->>'id',(v_project->>'workspace_id')::uuid,(v_project->>'project_id')::uuid,v_id,v_created,
        p_remote->>'etag',v_remote,v_remote_hash,v_remote_hash) returning * into l;
    insert into public.tr8_workspace_tasks(id,workspace_id,project_id,owner_id,title,status,priority,start_date)
      values(v_id,l.workspace_id,l.project_id,c.user_id,v_remote->>'title',case when (v_remote->>'completed')::boolean then 'done' else 'todo' end,'none',(v_remote->>'start_date')::date);
    insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
      values(l.workspace_id,l.project_id,c.user_id,'google.tasks.imported',v_id);
    return jsonb_build_object('action','none','link_id',l.id,'imported',true);
  end if;
  -- Follow domain order: workspace -> project -> task -> link. A user editing a
  -- task must never deadlock against a worker holding its link first.
  perform tr8_private.v2_lock_workspace(l.workspace_id);
  perform 1 from tr8_private.workspaces w join public.tr8_workspace_projects p on p.workspace_id=w.id
    where w.id=l.workspace_id and p.id=l.project_id and p.archived_at is null
      and ((l.origin='google' and w.kind='personal' and w.owner_id=c.user_id)
        or (l.origin='tr8' and (tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at)
          or tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at) is null))) for share of p;
  if not found then return jsonb_build_object('action','none','skipped',true,'reason','project_archived');end if;
  select * into t from public.tr8_workspace_tasks where id=l.local_task_id and created_at=l.local_task_created_at for update;
  v_local:=tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at);
  select * into strict l from tr8_private.google_tasks_links where id=l.id for update;
  if v_adopt then
    -- Acquire its domain rows before the link and jobs, just like a user edit.
    update tr8_private.google_tasks_links set generation=c.generation where id=l.id returning * into l;
    update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='superseded',finished_at=clock_timestamp()
      where link_id=l.id and generation<>c.generation and state in ('pending','retry','leased');
  end if;
  if l.state='retained' then return jsonb_build_object('action','none','skipped',true);end if;
  v_remote_hash:=tr8_private.v6_projection_hash(v_remote);v_local_hash:=tr8_private.v6_projection_hash(v_local);
  if l.resolution='local' and v_remote_hash is distinct from tr8_private.v6_projection_hash(l.remote_projection) then
    -- The choice covered the remote version displayed to the user, not a later
    -- edit made in Google while its resolution job was waiting.
    l.resolution:=null;
    update tr8_private.google_tasks_links set resolution=null where id=l.id;
  end if;
  v_remote_changed:=v_remote_hash is distinct from l.base_projection_hash;
  v_local_changed:=v_local_hash is distinct from l.synced_local_hash;
  update tr8_private.google_tasks_links set remote_etag=p_remote->>'etag',remote_projection=v_remote,updated_at=clock_timestamp() where id=l.id;
  if l.resolution='local' then
    if v_deleted and v_local is not null then
      update tr8_private.google_tasks_links set state='conflict',conflict_reason='remote_deleted',resolution=null where id=l.id;
      return jsonb_build_object('action','conflict','link_id',l.id);
    end if;
    return jsonb_build_object('action',case when v_local is null then 'delete' when v_deleted then 'conflict' else 'patch' end,'link_id',l.id,
      'etag',p_remote->>'etag','patch',case when v_local is null then null else jsonb_build_object('title',v_local->>'title','status',case when (v_local->>'completed')::boolean then 'completed' else 'needsAction' end,'due',v_local->>'start_date') end,
      'prepared_hash',v_local_hash);
  end if;
  if l.resolution<>'google' or l.resolution is null then
    if v_remote_changed and v_local_changed and v_remote_hash is distinct from v_local_hash then
      update tr8_private.google_tasks_links set state='conflict',conflict_reason=case when v_deleted then 'remote_deleted' else 'local_changed' end,resolution=null where id=l.id;
      return jsonb_build_object('action','conflict','link_id',l.id);
    end if;
    if not v_remote_changed and v_local_changed then
      if l.state='conflict' then return jsonb_build_object('action','conflict','link_id',l.id);end if;
      return jsonb_build_object('action',case when v_local is null then 'delete' else 'patch' end,'link_id',l.id,'etag',p_remote->>'etag',
        'patch',case when v_local is null then null else jsonb_build_object('title',v_local->>'title','status',case when (v_local->>'completed')::boolean then 'completed' else 'needsAction' end,'due',v_local->>'start_date') end,
        'prepared_hash',v_local_hash);
    end if;
  end if;
  if l.origin='tr8' and not (v_local is null and v_deleted) and v_remote_hash is distinct from v_local_hash
    and not tr8_private.v7_domain_permission(l.workspace_id,l.project_id,c.user_id,
      case when v_deleted then 'task.delete' when v_local is null then 'task.create' else 'task.edit' end) then
    update tr8_private.google_tasks_links set state='retained',conflict_reason='permission_changed',resolution=null where id=l.id;
    return jsonb_build_object('action','none','link_id',l.id,'skipped',true);
  end if;
  if v_deleted then
    update tr8_private.google_tasks_links set state='deleted',base_projection_hash=null,synced_local_hash=null,resolution=null,conflict_reason=null where id=l.id;
    if v_local is not null then
      delete from public.tr8_workspace_tasks where id=l.local_task_id and created_at=l.local_task_created_at;
      insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
        values(l.workspace_id,l.project_id,c.user_id,'google.tasks.deleted',l.local_task_id);
    end if;
    return jsonb_build_object('action','none','link_id',l.id,'deleted',v_local is not null);
  end if;
  if t.due_date is not null and (v_remote->>'start_date')::date>t.due_date then
    update tr8_private.google_tasks_links set state='conflict',conflict_reason='date_conflict',resolution=null where id=l.id;
    return jsonb_build_object('action','conflict','link_id',l.id);
  end if;
  -- Hash is recorded before domain triggers see the incoming projection. The
  -- internal outbox remains intact, while this known echo cannot enqueue PATCH.
  update tr8_private.google_tasks_links set state='synced',base_projection_hash=v_remote_hash,synced_local_hash=v_remote_hash,
    resolution=null,conflict_reason=null where id=l.id;
  if v_local is null then
    v_id:=gen_random_uuid();v_created:=statement_timestamp();
    update tr8_private.google_tasks_links set local_task_id=v_id,local_task_created_at=v_created where id=l.id;
    insert into public.tr8_workspace_tasks(id,workspace_id,project_id,owner_id,title,status,priority,start_date)
      values(v_id,l.workspace_id,l.project_id,c.user_id,v_remote->>'title',case when (v_remote->>'completed')::boolean then 'done' else 'todo' end,'none',(v_remote->>'start_date')::date);
  elsif v_local_hash is distinct from v_remote_hash then
    update public.tr8_workspace_tasks set title=v_remote->>'title',start_date=(v_remote->>'start_date')::date,
      status=case when (v_remote->>'completed')::boolean then 'done' when status='done' then 'todo' else status end
      where id=l.local_task_id and created_at=l.local_task_created_at;
  end if;
  return jsonb_build_object('action','none','link_id',l.id,'updated',v_local_hash is distinct from v_remote_hash);
end; $$;

create or replace function tr8_private.v6_finish(p_job uuid,p_token uuid,p_result jsonb)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare j tr8_private.google_tasks_jobs; c tr8_private.google_connections; l tr8_private.google_tasks_links;
  v_outcome text:=p_result->>'outcome';v_remote jsonb;v_current text;v_continue boolean:=false;v_delay integer;v_reason text;
begin
  if v_outcome is null or v_outcome not in ('succeeded','retry','dead','needs_reauthorization','cancelled') then raise exception using errcode='22023',message='Invalid Tasks outcome';end if;
  select * into j from tr8_private.google_tasks_jobs where id=p_job;
  if not found then return false;end if;
  select * into strict c from tr8_private.google_connections where id=j.connection_id for no key update;
  select * into j from tr8_private.google_tasks_jobs where id=p_job;
  if not found or j.state<>'leased' or j.lease_token is distinct from p_token or j.lease_expires_at<=clock_timestamp() or c.generation<>j.generation then return false;end if;
  if c.state<>'connected' or not c.tasks_granted or not exists(select 1 from tr8_private.google_tasks_sync s where s.connection_id=c.id and s.generation=c.generation and s.enabled) then
    v_outcome:='cancelled';
  end if;
  if v_outcome='needs_reauthorization' then
    update tr8_private.google_connections set state='needs_reauthorization',reason='reauthorization_required',version=version+1 where id=c.id;
    update tr8_private.google_tasks_sync set reason='reauthorization_required',version=version+1 where connection_id=c.id;
    v_outcome:='dead';v_reason:='reauthorization_required';
  elsif v_outcome='succeeded' and j.kind in ('patch','delete') then
    select * into strict l from tr8_private.google_tasks_links where id=j.link_id for update;
    if p_result ? 'remote' then
      if not (p_result ? 'prepared_hash') or (p_result->>'prepared_hash' is not null and p_result->>'prepared_hash' !~ '^[0-9a-f]{32}$')
        or p_result->>'prepared_hash' is distinct from j.prepared_hash then
        raise exception using errcode='22023',message='Missing or changed captured Tasks projection hash';
      end if;
      if p_result->'remote'->>'id' is distinct from l.remote_task_id then raise exception using errcode='22023',message='Google Task identity mismatch';end if;
      v_remote:=tr8_private.v6_remote_projection(p_result->'remote');
      -- Persist the result of a known write even if another local edit arrived.
      update tr8_private.google_tasks_links set remote_projection=v_remote,remote_etag=p_result->'remote'->>'etag',
        base_projection_hash=tr8_private.v6_projection_hash(v_remote),synced_local_hash=p_result->>'prepared_hash',
        state=case when v_remote is null then 'deleted' else 'synced' end,resolution=null,conflict_reason=null,updated_at=clock_timestamp() where id=l.id;
      v_current:=tr8_private.v6_projection_hash(tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at));
      if v_current is distinct from p_result->>'prepared_hash' and v_remote is not null then
        update tr8_private.google_tasks_links set state=case when v_current is null then 'deleting' else 'dirty' end where id=l.id;
        perform tr8_private.v6_enqueue(c.id,case when v_current is null then 'delete' else 'patch' end,l.id,l.list_id);
      elsif v_remote is null and v_current is not null then
        update tr8_private.google_tasks_links set state=case when l.cleanup_requested then 'retained' else 'conflict' end,conflict_reason=case when l.cleanup_requested then null else 'remote_deleted' end,remote_projection=null where id=l.id;
      end if;
    elsif l.state in ('dirty','deleting') then
      raise exception using errcode='PT409',message='An outbound Tasks change needs a known provider receipt';
    end if;
  elsif v_outcome='succeeded' and j.kind='create' then
    select * into strict l from tr8_private.google_tasks_links where id=j.link_id;
    if l.creation_state='ready' then raise exception using errcode='PT409',message='Creation has no provider receipt';end if;
    if l.creation_state='uncertain' and not j.page_more then raise exception using errcode='PT409',message='Creation requires complete recovery';end if;
    v_continue:=j.page_more;
  elsif v_outcome='succeeded' and j.kind in ('discover','pull') then v_continue:=j.page_more;end if;
  if v_outcome='succeeded' and exists(select 1 from tr8_private.google_tasks_jobs where id=j.id and desired_revision<>leased_revision) then v_continue:=true;end if;
  if v_outcome='retry' and j.attempts>=8 then v_outcome:='dead';v_reason:='attempt_limit';end if;
  v_delay:=least(21600,greatest(coalesce((p_result->>'retry_after_seconds')::integer,0),least(21600,(30*power(2,j.attempts-1))::integer)+floor(random()*10)::integer));
  update tr8_private.google_tasks_jobs set state=case when v_continue then 'pending' else v_outcome end,
    attempts=case when v_continue then 0 else attempts end,
    page_token=case when desired_revision<>leased_revision then null else page_token end,
    reason=coalesce(v_reason,case v_outcome when 'succeeded' then 'reconciled' when 'retry' then 'temporary_failure' when 'dead' then 'permanent_failure' else 'cancelled' end),
    lease_token=null,lease_expires_at=null,available_at=case when v_outcome='retry' then clock_timestamp()+make_interval(secs=>v_delay) when v_continue then clock_timestamp() else available_at end,
    finished_at=case when v_continue or v_outcome='retry' then null else clock_timestamp() end,updated_at=clock_timestamp() where id=j.id;
  if v_outcome='succeeded' then update tr8_private.google_tasks_sync set reason=null where connection_id=c.id and reason in ('temporary_failure','budget_exhausted');
  elsif v_outcome in ('retry','dead') then update tr8_private.google_tasks_sync set reason=coalesce(v_reason,case v_outcome when 'retry' then 'temporary_failure' else 'permanent_failure' end) where connection_id=c.id;end if;
  return true;
end; $$;

create or replace function tr8_private.v6_status(p_actor uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'configured',cfg.configured,
    'enabled',coalesce(c.tasks_granted and c.credential_envelope is not null,false),
    'state',case when c.state='needs_reauthorization' then 'needs_reauthorization'
      when c.state in ('error','cleanup_failed') then 'error'
      when c.id is null or c.state='disconnected' or not c.tasks_granted or c.credential_envelope is null then 'disconnected'
      when c.state<>'connected' or not coalesce(s.enabled,false) then 'paused' else 'connected' end,
    'version',coalesce(s.version,0),'last_sync_at',s.last_pull_at,'next_sync_at',s.next_pull_at,
    'pending',(select count(*) from tr8_private.google_tasks_jobs j where j.connection_id=c.id and j.generation=c.generation and j.state in ('pending','retry','leased')),
    'failed',(select count(*) from tr8_private.google_tasks_jobs j where j.connection_id=c.id and j.generation=c.generation and j.state='dead'),
    'conflicts',(select count(*) from tr8_private.google_tasks_links l where l.connection_id=c.id and l.generation=c.generation and l.state='conflict'),
    'outbound',jsonb_build_object('enabled',coalesce(s.export_enabled,false),'list_id',s.export_list_id,'enabled_at',s.export_enabled_at,
      'uncertain',(select count(*) from tr8_private.google_tasks_links z where z.connection_id=c.id and z.generation=c.generation and z.origin='tr8' and z.creation_state in ('uncertain','blocked') and z.state not in ('deleted','retained'))),
    'reason',case when not cfg.configured then 'config_pending' when c.state='needs_reauthorization' then 'reauthorization_required' else s.reason end,
    'lists',coalesce((select jsonb_agg(jsonb_build_object('id',l.list_id,'title',l.title,'selected',l.selected) order by l.title,l.list_id)
      from tr8_private.google_tasks_lists l where l.connection_id=c.id and l.generation=c.generation),'[]'::jsonb),
    'conflict_items',coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'title',q.title,'google_title',q.google_title,'reason',q.conflict_reason) order by q.id)
      from(select l.id,coalesce(t.title,'Tarea eliminada en TR8') title,l.remote_projection->>'title' google_title,l.conflict_reason
        from tr8_private.google_tasks_links l left join public.tr8_workspace_tasks t on t.id=l.local_task_id and t.created_at=l.local_task_created_at
        where l.connection_id=c.id and l.generation=c.generation and l.state='conflict' order by l.id limit 100)q),'[]'::jsonb))
  from tr8_private.google_config cfg left join tr8_private.google_connections c on c.user_id=p_actor
    left join tr8_private.google_tasks_sync s on s.connection_id=c.id and s.generation=c.generation where cfg.singleton;
$$;

create or replace function tr8_private.v6_server(p_action text,p_actor uuid default null,p_session uuid default null,p_payload jsonb default '{}')
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='500ms' as $$
declare c tr8_private.google_connections; s tr8_private.google_tasks_sync; j tr8_private.google_tasks_jobs;
  a tr8_private.google_oauth_attempts; l tr8_private.google_tasks_links; r tr8_private.google_requests;
  v_result jsonb;v_requested boolean;v_hash text;v_request uuid;v_expected integer;v_local jsonb;
begin
  if p_action is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or length(p_payload::text)>262144 then raise exception using errcode='22023',message='Invalid Google request';end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception using errcode='25000',message='Google operations require read committed isolation';end if;
  if p_action='begin' then
    if p_payload ? 'tasks_requested' and jsonb_typeof(p_payload->'tasks_requested')<>'boolean' then raise exception using errcode='22023',message='Invalid Tasks capability request';end if;
    select * into c from tr8_private.google_connections where user_id=p_actor;
    v_requested:=coalesce((p_payload->>'tasks_requested')::boolean,false) or coalesce(c.tasks_granted,false);
    -- The legacy receipt already hashes additional semantic payload fields.
    -- Persist the capability in the attempt and return it on exact replay.
    v_result:=tr8_private.v5_server(p_action,p_actor,p_session,case when v_requested then p_payload||'{"tasks_requested":true}'::jsonb else p_payload end);
    update tr8_private.google_oauth_attempts set tasks_requested=v_requested where id=(v_result->>'attempt_id')::uuid returning * into a;
    -- Fence refreshes from the old shared grant before a new grant can replace
    -- it without changing the Calendar generation. Old workers cannot finish.
    update tr8_private.google_jobs set state='pending',lease_token=null,lease_expires_at=null,attempts=0,prepared_hash=null,available_at=clock_timestamp(),reason='reauthorizing'
      where connection_id=a.connection_id and state='leased';
    update tr8_private.google_tasks_jobs set state='pending',lease_token=null,lease_expires_at=null,attempts=0,prepared_hash=null,available_at=clock_timestamp(),reason='reauthorizing'
      where connection_id=a.connection_id and state='leased';
    return v_result||jsonb_build_object('tasks_requested',a.tasks_requested);
  elsif p_action='consume_attempt' then
    v_result:=tr8_private.v5_server(p_action,p_actor,p_session,p_payload);
    return v_result||jsonb_build_object('tasks_requested',(select tasks_requested from tr8_private.google_oauth_attempts where id=(v_result->>'attempt_id')::uuid));
  elsif p_action='complete_authorization' then
    select * into a from tr8_private.google_oauth_attempts where id=(p_payload->>'attempt_id')::uuid;
    if a.tasks_requested and p_payload->'tasks_granted' is distinct from 'true'::jsonb then raise exception using errcode='PT409',message='Tasks grant was not verified';end if;
    if p_payload->'tasks_granted'='true'::jsonb and not a.tasks_requested then raise exception using errcode='22023',message='Unrequested Tasks grant';end if;
    v_result:=tr8_private.v5_server(p_action,p_actor,p_session,p_payload);
    select * into strict c from tr8_private.google_connections where id=a.connection_id for no key update;
    update tr8_private.google_connections set tasks_granted=a.tasks_requested where id=c.id;
    if a.tasks_requested then
      insert into tr8_private.google_tasks_sync(connection_id,generation,enabled,version,next_pull_at)
        values(c.id,c.generation,true,1,clock_timestamp()+interval '15 minutes')
        on conflict(connection_id) do update set generation=excluded.generation,enabled=true,version=google_tasks_sync.version+1,next_pull_at=excluded.next_pull_at,reason=null;
      perform tr8_private.v6_enqueue(c.id,'discover');
    end if;
    return v_result;
  elsif p_action='disconnect' then
    v_result:=tr8_private.v5_server(p_action,p_actor,p_session,p_payload);
    select * into strict c from tr8_private.google_connections where user_id=p_actor;
    update tr8_private.google_tasks_sync set enabled=false,version=version+1,next_pull_at=null where connection_id=c.id;
    update tr8_private.google_connections set tasks_granted=false where id=c.id;
    update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='disconnected',finished_at=clock_timestamp() where connection_id=c.id and state in ('pending','retry','leased');
    return v_result;
  elsif p_action='tasks_begin_create' then return tr8_private.v7_begin_create((p_payload->>'job_id')::uuid,(p_payload->>'lease_token')::uuid);
  elsif p_action='tasks_bind_create' then return tr8_private.v7_bind_create((p_payload->>'job_id')::uuid,(p_payload->>'lease_token')::uuid,p_payload);
  elsif p_action='tasks_recover_create_page' then return tr8_private.v7_recover_create_page((p_payload->>'job_id')::uuid,(p_payload->>'lease_token')::uuid,p_payload);
  elsif p_action='tasks_claim' then return tr8_private.v6_claim(coalesce((p_payload->>'limit')::integer,2));
  elsif p_action='tasks_prepare' then return tr8_private.v6_prepare((p_payload->>'job_id')::uuid,(p_payload->>'lease_token')::uuid);
  elsif p_action='tasks_apply_lists' then return tr8_private.v6_apply_lists((p_payload->>'job_id')::uuid,(p_payload->>'lease_token')::uuid,p_payload);
  elsif p_action='tasks_apply_page' then return tr8_private.v6_apply_page((p_payload->>'job_id')::uuid,(p_payload->>'lease_token')::uuid,p_payload);
  elsif p_action='tasks_compare_remote' then return tr8_private.v6_compare_remote((p_payload->>'job_id')::uuid,(p_payload->>'lease_token')::uuid,p_payload->'remote');
  elsif p_action='tasks_reserve_request' then return tr8_private.v6_reserve((p_payload->>'job_id')::uuid,(p_payload->>'lease_token')::uuid,p_payload->>'purpose');
  elsif p_action='tasks_finish' then return to_jsonb(tr8_private.v6_finish((p_payload->>'job_id')::uuid,(p_payload->>'lease_token')::uuid,p_payload));
  elsif p_action='tasks_save_credentials' then
    if not coalesce(tr8_private.v5_valid_envelope(p_payload->'credential_envelope'),false) then raise exception using errcode='22023',message='Invalid encrypted credentials';end if;
    if tr8_private.v6_prepare((p_payload->>'job_id')::uuid,(p_payload->>'lease_token')::uuid)->>'valid'<>'true' then return 'false'::jsonb;end if;
    select * into strict j from tr8_private.google_tasks_jobs where id=(p_payload->>'job_id')::uuid;
    update tr8_private.google_connections set credential_envelope=p_payload->'credential_envelope',updated_at=clock_timestamp()
      where id=j.connection_id and generation=j.generation and tasks_granted and state='connected';
    return to_jsonb(found);
  elsif p_action not like 'tasks_%' then return tr8_private.v5_server(p_action,p_actor,p_session,p_payload);
  end if;
  perform tr8_private.v5_require_session(p_actor,p_session);
  if p_action='tasks_status' then return tr8_private.v6_status(p_actor);end if;
  if p_action not in ('tasks_reconcile','tasks_pause','tasks_resume','tasks_select_list','tasks_resolve','tasks_configure_export') then raise exception using errcode='22023',message='Unknown Tasks action';end if;
  v_request:=(p_payload->>'request_id')::uuid;v_expected:=(p_payload->>'expected_version')::integer;
  if v_request is null or v_expected is null or v_expected<0 then raise exception using errcode='22023',message='Task action identity and version are required';end if;
  perform 1 from tr8_private.app_users where user_id=p_actor for update;
  perform tr8_private.v5_require_session(p_actor,p_session);
  v_hash:=md5(p_action||p_payload::text);
  select * into r from tr8_private.google_requests where user_id=p_actor and request_id=v_request;
  if found then
    if r.action<>p_action or r.payload_hash<>v_hash then raise exception using errcode='PT409',message='Task action identity conflict';end if;
    return r.response;
  end if;
  select * into c from tr8_private.google_connections where user_id=p_actor for no key update;
  if not found or c.state<>'connected' or not c.tasks_granted then raise exception using errcode='PT409',message='Tasks grant is not ready';end if;
  select * into s from tr8_private.google_tasks_sync where connection_id=c.id and generation=c.generation for update;
  if not found or s.version<>v_expected then raise exception using errcode='PT409',message='Stale Tasks configuration version';end if;
  if p_action='tasks_configure_export' then
    if jsonb_typeof(p_payload->'export_enabled') is distinct from 'boolean'
      or not (p_payload ? 'export_list_id') or jsonb_typeof(p_payload->'export_list_id') not in ('string','null') then
      raise exception using errcode='22023',message='Export configuration is required';end if;
    if (p_payload->>'export_enabled')::boolean then
      if p_payload->>'export_list_id' is null then
        if (select count(*) from tr8_private.google_tasks_lists where connection_id=c.id and generation=c.generation and selected)<>1 then
          raise exception using errcode='PT409',message='Choose a selected destination list';end if;
        select list_id into s.export_list_id from tr8_private.google_tasks_lists where connection_id=c.id and generation=c.generation and selected;
      else s.export_list_id:=p_payload->>'export_list_id';end if;
      if not exists(select 1 from tr8_private.google_tasks_lists where connection_id=c.id and generation=c.generation and list_id=s.export_list_id and selected) then
        raise exception using errcode='PT404',message='Destination task list unavailable';end if;
      update tr8_private.google_tasks_sync set export_enabled=true,export_list_id=s.export_list_id,
        export_enabled_at=case when export_enabled then export_enabled_at else statement_timestamp() end where connection_id=c.id;
    else
      update tr8_private.google_tasks_sync set export_enabled=false where connection_id=c.id;
    end if;
  elsif p_action='tasks_pause' then
    update tr8_private.google_tasks_sync set enabled=false,next_pull_at=null where connection_id=c.id;
    update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='paused',finished_at=clock_timestamp() where connection_id=c.id and state in ('pending','retry','leased');
  elsif p_action in ('tasks_reconcile','tasks_resume') then
    if p_action='tasks_reconcile' and s.last_manual_at>clock_timestamp()-interval '30 seconds' then raise exception using errcode='PT429',message='Wait before synchronizing Tasks again';end if;
    update tr8_private.google_tasks_sync set enabled=true,next_pull_at=clock_timestamp()+interval '15 minutes',last_manual_at=clock_timestamp(),reason=null where connection_id=c.id;
    perform tr8_private.v6_enqueue(c.id,'discover');
    for l in select q.* from tr8_private.google_tasks_links q join tr8_private.google_tasks_lists list_row on list_row.connection_id=q.connection_id and list_row.generation=q.generation and list_row.list_id=q.list_id and list_row.selected
      where q.connection_id=c.id and q.generation=c.generation and q.state in ('dirty','deleting') loop
      perform tr8_private.v6_enqueue(c.id,case when l.remote_task_id is null then 'create' when l.state='deleting' then 'delete' else 'patch' end,l.id,l.list_id);
    end loop;
  elsif p_action='tasks_select_list' then
    if jsonb_typeof(p_payload->'selected') is distinct from 'boolean' then raise exception using errcode='22023',message='List selection is required';end if;
    perform 1 from tr8_private.google_tasks_lists where connection_id=c.id and generation=c.generation and list_id=p_payload->>'list_id' for update;
    if not found then raise exception using errcode='PT404',message='Task list unavailable';end if;
    update tr8_private.google_tasks_lists set selected=(p_payload->>'selected')::boolean where connection_id=c.id and generation=c.generation and list_id=p_payload->>'list_id';
    if (p_payload->>'selected')::boolean and s.enabled then
      perform tr8_private.v6_enqueue(c.id,'pull',null,p_payload->>'list_id');
      for l in select * from tr8_private.google_tasks_links where connection_id=c.id and generation=c.generation and list_id=p_payload->>'list_id' and state in ('dirty','deleting') loop
        perform tr8_private.v6_enqueue(c.id,case when l.remote_task_id is null then 'create' when l.state='deleting' then 'delete' else 'patch' end,l.id,l.list_id);
      end loop;
    else
      update tr8_private.google_tasks_jobs set state='cancelled',lease_token=null,lease_expires_at=null,reason='list_disabled',finished_at=clock_timestamp()
        where connection_id=c.id and generation=c.generation and list_id=p_payload->>'list_id' and state in ('pending','retry','leased');
    end if;
  elsif p_action='tasks_resolve' then
    if p_payload->>'resolution' is null or p_payload->>'resolution' not in ('local','google') then raise exception using errcode='22023',message='Conflict resolution is required';end if;
    select * into l from tr8_private.google_tasks_links where id=(p_payload->>'link_id')::uuid and connection_id=c.id and generation=c.generation and state='conflict' for update;
    if not found then raise exception using errcode='PT404',message='Task conflict unavailable';end if;
    if l.origin='tr8' and l.creation_state='blocked' then raise exception using errcode='PT409',message='Creation identity must be reconciled before choosing a version';end if;
    if not s.enabled or not exists(select 1 from tr8_private.google_tasks_lists where connection_id=c.id and generation=c.generation and list_id=l.list_id and selected) then raise exception using errcode='PT409',message='Enable the task list before resolving its conflict';end if;
    v_local:=tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at);
    if p_payload->>'resolution'='local' and l.remote_projection is null and v_local is not null then
      -- Google does not accept a caller-chosen Task ID. Keeping the local task
      -- after confirmed remote deletion must not POST an uncertain duplicate.
      update tr8_private.google_tasks_links set state='retained',resolution=null,conflict_reason=null where id=l.id;
    else
      update tr8_private.google_tasks_links set state=case when v_local is null then 'deleting' else 'dirty' end,resolution=p_payload->>'resolution',conflict_reason=null where id=l.id;
      perform tr8_private.v6_enqueue(c.id,case when v_local is null then 'delete' else 'patch' end,l.id,l.list_id);
    end if;
  end if;
  update tr8_private.google_tasks_sync set version=version+1 where connection_id=c.id;
  v_result:=tr8_private.v6_status(p_actor);
  insert into tr8_private.google_requests(user_id,request_id,action,payload_hash,response) values(p_actor,v_request,p_action,v_hash,v_result);
  return v_result;
end; $$;

do $stage6b_grants$
declare f record;
begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='tr8_private' and p.proname like 'v7_%' loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  end loop;
end; $stage6b_grants$;

do $stage6b_preservation$
declare s record;
begin
  select * into strict s from pg_temp.tr8_stage6b_snapshot;
  if s.projects is distinct from (select md5(coalesce(string_agg(to_jsonb(p)::text,E'\n' order by id),'')) from public.tr8_workspace_projects p)
    or s.tasks is distinct from (select md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by id),'')) from public.tr8_workspace_tasks t)
    or s.app_config is distinct from (select to_jsonb(c) from tr8_private.app_config c where singleton)
    or s.sequence_state is distinct from (select jsonb_build_object('last_value',q.last_value,'is_called',q.is_called) from public.tr8_tasks_task_number_seq q)
    or s.links<>(select count(*) from tr8_private.google_tasks_links)
    or s.jobs<>(select count(*) from tr8_private.google_tasks_jobs)
    or exists(select 1 from tr8_private.google_tasks_sync where export_enabled) then
    raise exception 'Stage 6b unexpectedly changed domain data, backfilled tasks or enabled export';
  end if;
end; $stage6b_preservation$;
comment on column tr8_private.google_tasks_links.creation_marker is 'Opaque recovery receipt only; no TR8 description, project or user identifier is exported in Google notes.';
comment on column tr8_private.google_tasks_sync.export_enabled is 'Explicit opt-in for future own-personal and assigned-team tasks, without enrolling historical domain rows.';
comment on table tr8_private.google_tasks_jobs is 'Shared-budget fenced Tasks queue; uncertain POSTs recover by opaque marker and never repeat automatically.';

create or replace function tr8_private.v6_queue_due()
returns integer language plpgsql volatile security definer set search_path='' as $$
declare s record; z record; v_count integer:=0;
begin
  if not exists(select 1 from tr8_private.google_config where singleton and configured and scheduler_enabled) then return 0;end if;
  for s in select a.* from tr8_private.google_tasks_sync a join tr8_private.google_connections c on c.id=a.connection_id
    where a.enabled and a.generation=c.generation and c.state='connected' and c.tasks_granted
      and (a.next_pull_at is null or a.next_pull_at<=clock_timestamp())
    order by a.connection_id limit 100 for no key update of c skip locked loop
    if exists(select 1 from tr8_private.google_tasks_lists l where l.connection_id=s.connection_id and l.generation=s.generation) then
      for z in select list_id from tr8_private.google_tasks_lists where connection_id=s.connection_id and generation=s.generation and selected loop
        if not exists(select 1 from tr8_private.google_tasks_jobs j where j.connection_id=s.connection_id and j.generation=s.generation and j.kind='pull' and j.list_id=z.list_id and j.state in ('pending','retry','leased')) then
          perform tr8_private.v6_enqueue(s.connection_id,'pull',null,z.list_id);v_count:=v_count+1;
        end if;
      end loop;
    elsif not exists(select 1 from tr8_private.google_tasks_jobs j where j.connection_id=s.connection_id and j.generation=s.generation and j.kind='discover' and j.state in ('pending','retry','leased')) then
      perform tr8_private.v6_enqueue(s.connection_id,'discover');v_count:=v_count+1;
    end if;
    update tr8_private.google_tasks_sync set next_pull_at=clock_timestamp()+interval '15 minutes' where connection_id=s.connection_id;
  end loop;
  for z in select l.id,l.connection_id,l.list_id from tr8_private.google_tasks_links l
    join tr8_private.google_connections c on c.id=l.connection_id and c.generation=l.generation and c.state='connected' and c.tasks_granted
    join tr8_private.google_tasks_sync s on s.connection_id=c.id and s.generation=c.generation and s.enabled
    join tr8_private.google_tasks_lists list_row on list_row.connection_id=c.id and list_row.generation=c.generation and list_row.list_id=l.list_id and list_row.selected
    where l.origin='tr8' and l.remote_task_id is not null and l.state in ('synced','dirty') and not l.cleanup_requested
      and tr8_private.v6_task_projection(l.local_task_id,l.local_task_created_at) is not null
      and not tr8_private.v7_task_eligible(c.id,l.local_task_id,l.local_task_created_at) loop
    update tr8_private.google_tasks_links set cleanup_requested=true,state='deleting' where id=z.id;
    perform tr8_private.v6_enqueue(z.connection_id,'delete',z.id,z.list_id);
  end loop;
  return v_count;
end; $$;
