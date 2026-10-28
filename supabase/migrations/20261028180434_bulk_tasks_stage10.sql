-- Bulk commands preserve the existing per-task authorization, audit and provider
-- paths. Only minimal idempotency receipts are added; existing data is untouched.
begin;

create table tr8_private.bulk_task_receipts (
  owner_id uuid not null references tr8_private.app_users(user_id) on delete cascade,
  workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
  request_id uuid not null,
  payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
  results jsonb not null check(jsonb_typeof(results)='array' and jsonb_array_length(results) between 1 and 50),
  created_at timestamptz not null default clock_timestamp(),
  primary key(owner_id,workspace_id,request_id)
);
create index tr8_bulk_task_receipts_workspace on tr8_private.bulk_task_receipts(workspace_id);
create index tr8_bulk_task_receipts_retention on tr8_private.bulk_task_receipts(owner_id,workspace_id,created_at,request_id);
alter table tr8_private.bulk_task_receipts enable row level security;
revoke all on tr8_private.bulk_task_receipts from public,anon,authenticated,service_role;

create function tr8_private.bulk_tasks(w uuid,rid uuid,requested_at timestamptz,op jsonb,items jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_variable
declare
  actor uuid:=auth.uid();kind text;permission text;item jsonb;pid uuid;tid uuid;
  allowed_projects uuid[]:=array[]::uuid[];results jsonb:='[]';replay jsonb;h text;
  receipt tr8_private.bulk_task_receipts;task public.tr8_workspace_tasks;child_id uuid;row_code text;
begin
  -- Browser-only capability; neither a valid MCP credential nor a JWT from a
  -- terminated Auth session authorizes this endpoint.
  perform tr8_private.v7_require_browser_session();
  perform tr8_private.v2_require_workspace(w,'project.read');
  if rid is null or requested_at is null or not isfinite(requested_at) then
    raise exception using errcode='22023',message='A request identifier and finite request time are required';
  end if;
  if requested_at < clock_timestamp()-interval '24 hours' or requested_at > clock_timestamp()+interval '5 minutes' then
    raise exception using errcode='PT410',message='This bulk request expired. Review the tasks before submitting a new request';
  end if;
  if op is null or jsonb_typeof(op)<>'object' or jsonb_typeof(op->'kind') is distinct from 'string' then
    raise exception using errcode='22023',message='Invalid bulk operation';
  end if;
  kind:=op->>'kind';
  if kind='status' then
    perform tr8_private.productivity_keys(op,array['kind','status']);
    if jsonb_typeof(op->'status') is distinct from 'string' or op->>'status'<>all(array['backlog','todo','progress','review','done']) then
      raise exception using errcode='22023',message='Invalid bulk status';
    end if;
  elsif kind='priority' then
    perform tr8_private.productivity_keys(op,array['kind','priority']);
    if jsonb_typeof(op->'priority') is distinct from 'string' or op->>'priority'<>all(array['none','low','medium','high','urgent']) then
      raise exception using errcode='22023',message='Invalid bulk priority';
    end if;
  elsif kind='assign' then
    perform tr8_private.productivity_keys(op,array['kind','assignee_member_id']);
    if jsonb_typeof(op->'assignee_member_id') is distinct from 'null' and
      (jsonb_typeof(op->'assignee_member_id') is distinct from 'string' or op->>'assignee_member_id'!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception using errcode='22023',message='Invalid bulk assignee';
    end if;
  elsif kind in ('archive','delete') then
    perform tr8_private.productivity_keys(op,array['kind']);
  else
    raise exception using errcode='22023',message='Unknown bulk operation';
  end if;
  if items is null or jsonb_typeof(items)<>'array' then
    raise exception using errcode='22023',message='Bulk items must be an array';
  end if;
  if jsonb_array_length(items) not between 1 and 50 then
    raise exception using errcode='22023',message='Choose between one and fifty tasks';
  end if;
  -- Validate the entire envelope before the first mutation. A bad last item must
  -- not turn a malformed input into a partially applied batch.
  for item in select value from jsonb_array_elements(items) loop
    perform tr8_private.productivity_keys(item,array['id','project_id','version']);
    if jsonb_typeof(item->'id') is distinct from 'string' or item->>'id'!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(item->'project_id') is distinct from 'string' or item->>'project_id'!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(item->'version') is distinct from 'number' or item->>'version'!~'^[1-9][0-9]{0,9}$' then
      raise exception using errcode='22023',message='Every bulk item requires its task, project and expected version';
    end if;
    if (item->>'version')::numeric>2147483647 then raise exception using errcode='22023',message='Invalid task version';end if;
  end loop;
  if (select count(distinct (value->>'id')::uuid) from jsonb_array_elements(items))<>jsonb_array_length(items) then
    raise exception using errcode='22023',message='Bulk task identifiers must be unique';
  end if;
  permission:=case kind when 'assign' then 'task.assign' when 'delete' then 'task.delete' else 'task.edit' end;
  -- This is the same lock/order as work_management: workspace authorization,
  -- actor/workspace command lock, then projects, then tasks. Taking project locks
  -- before this advisory lock would deadlock against an individual archive.
  perform pg_advisory_xact_lock(hashtextextended('tr8-wm:'||actor::text||':'||w::text,0));
  perform tr8_private.v7_require_browser_session();
  if requested_at < clock_timestamp()-interval '24 hours' or requested_at > clock_timestamp()+interval '5 minutes' then
    raise exception using errcode='PT410',message='This bulk request expired. Review the tasks before submitting a new request';
  end if;
  h:=encode(extensions.digest(convert_to(jsonb_build_object('operation',op,'items',items,'requested_at_epoch',extract(epoch from requested_at))::text,'UTF8'),'sha256'),'hex');
  select * into receipt from tr8_private.bulk_task_receipts where owner_id=actor and workspace_id=w and request_id=rid;
  if found then
    if receipt.payload_hash<>h then raise exception using errcode='PT409',message='Bulk request identifier reused with different data';end if;
    replay:=receipt.results;
  end if;
  -- Retention is opportunistic, scoped and bounded. Expired requests are rejected
  -- above even if their receipt was removed, including after task UUID reuse.
  delete from tr8_private.bulk_task_receipts r where r.owner_id=actor and r.workspace_id=w and r.request_id in (
    select q.request_id from tr8_private.bulk_task_receipts q where q.owner_id=actor and q.workspace_id=w
      and q.created_at<clock_timestamp()-interval '7 days' order by q.created_at,q.request_id limit 1000
  );
  if replay is null and (select count(*) from tr8_private.bulk_task_receipts q where q.owner_id=actor and q.workspace_id=w
    and q.created_at>=clock_timestamp()-interval '24 hours')>=1000 then
    raise exception using errcode='PT429',message='Bulk request budget reached. Exact retries remain available; new requests become available as the daily window advances';
  end if;
  for pid in select distinct (value->>'project_id')::uuid from jsonb_array_elements(items) order by 1 loop
    begin
      perform tr8_private.v2_require_project(w,pid,permission,true);
      allowed_projects:=array_append(allowed_projects,pid);
    exception when sqlstate 'PT404' then
      -- Absence and denied access deliberately have the same per-item outcome.
      null;
    end;
  end loop;
  if replay is null then
    perform 1 from public.tr8_workspace_projects p where p.workspace_id=w and p.id=any(allowed_projects) order by p.id for update;
    perform 1 from public.tr8_workspace_tasks t where t.workspace_id=w and t.project_id=any(allowed_projects)
      and t.id in(select (value->>'id')::uuid from jsonb_array_elements(items)) order by t.id for update;
  end if;
  for item in select value from jsonb_array_elements(items) loop
    tid:=(item->>'id')::uuid;pid:=(item->>'project_id')::uuid;row_code:=null;
    if not pid=any(allowed_projects) then
      row_code:='PT404';
    elsif replay is not null then
      -- A receipt is proof of an earlier result, never proof of current access.
      results:=results||jsonb_build_array((select value from jsonb_array_elements(replay) where value->>'id'=tid::text));
      continue;
    else
      begin
        select * into task from public.tr8_workspace_tasks t where t.workspace_id=w and t.id=tid;
        if not found or task.project_id<>pid then raise exception using errcode='PT404',message='Resource unavailable';end if;
        if task.version<>(item->>'version')::integer then raise exception using errcode='PT409',message='Task changed';end if;
        if task.archived_at is not null or exists(select 1 from public.tr8_workspace_projects p where p.workspace_id=w and p.id=pid and p.archived_at is not null) then
          raise exception using errcode='PT409',message='Restore archived resources before editing';
        end if;
        if kind in ('status','priority') then
          perform tr8_private.v2_update_task(w,tid,(item->>'version')::integer,jsonb_build_object(kind,op->kind));
        elsif kind='assign' then
          perform tr8_private.v2_assign_task(w,tid,(item->>'version')::integer,(op->>'assignee_member_id')::uuid);
        elsif kind='archive' then
          -- The child id is deterministic and separate from user-supplied UUIDs.
          child_id:=md5('tr8-bulk-archive:'||actor::text||':'||w::text||':'||rid::text||':'||tid::text)::uuid;
          perform tr8_private.work_management(w,'archive_task',jsonb_build_object('id',tid,'version',(item->>'version')::integer,'archived',true,'request_id',child_id));
        else
          perform tr8_private.v2_delete_task(w,tid,(item->>'version')::integer);
        end if;
      exception
        when sqlstate 'PT404' or sqlstate 'PT409' or sqlstate '55000' or sqlstate '22023' or
          sqlstate '23503' or sqlstate '23514' or sqlstate '23505' or sqlstate 'PT429' then row_code:=sqlstate;
      end;
    end if;
    results:=results||jsonb_build_array(jsonb_build_object('id',tid,'outcome',case when row_code is null then 'applied' else 'rejected' end,'code',row_code));
  end loop;
  perform tr8_private.v7_require_browser_session();
  perform tr8_private.v2_require_actor();
  if replay is null then
    insert into tr8_private.bulk_task_receipts(owner_id,workspace_id,request_id,payload_hash,results) values(actor,w,rid,h,results);
  end if;
  return jsonb_build_object('request_id',rid,'results',results);
end;
$$;

create function public.tr8_v2_bulk_tasks(p_workspace_id uuid,p_request_id uuid,p_requested_at timestamptz,p_operation jsonb,p_items jsonb)
returns jsonb language sql volatile security invoker set search_path='' as $$
  select tr8_private.bulk_tasks(p_workspace_id,p_request_id,p_requested_at,p_operation,p_items);
$$;
revoke all on function tr8_private.bulk_tasks(uuid,uuid,timestamptz,jsonb,jsonb),public.tr8_v2_bulk_tasks(uuid,uuid,timestamptz,jsonb,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function tr8_private.bulk_tasks(uuid,uuid,timestamptz,jsonb,jsonb),public.tr8_v2_bulk_tasks(uuid,uuid,timestamptz,jsonb,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
