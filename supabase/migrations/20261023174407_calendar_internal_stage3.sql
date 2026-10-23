-- Stage 3: internal calendar only. No integration, mail, job, credential or
-- onboarding setting is enabled. All old RPC signatures and rows are retained.
lock table public.tr8_workspace_projects, public.tr8_workspace_tasks,
  tr8_private.app_users, tr8_private.app_config in access exclusive mode nowait;
create temporary table tr8_stage3_snapshot on commit drop as
select
  'public.tr8_workspace_projects'::regclass::oid as projects_oid,
  'public.tr8_workspace_tasks'::regclass::oid as tasks_oid,
  pg_get_serial_sequence('public.tr8_workspace_tasks','task_number')::regclass::oid as sequence_oid,
  (select md5(coalesce(string_agg(to_jsonb(p)::text,E'\n' order by id),'')) from public.tr8_workspace_projects p) as projects_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by id),'')) from public.tr8_workspace_tasks t) as tasks_hash,
  (select md5(coalesce(string_agg(to_jsonb(a)::text,E'\n' order by user_id),'')) from tr8_private.app_users a) as users_hash,
  (select jsonb_build_object('last_value',s.last_value,'is_called',s.is_called) from public.tr8_tasks_task_number_seq s) as sequence_state,
  (select to_jsonb(c) from tr8_private.app_config c where singleton) as app_config,
  (select jsonb_object_agg(p.oid::text,jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','tr8_private') and (p.proname like 'tr8_v2_%' or p.proname like 'v2_%' or p.proname='guard_task')) as old_api;

-- Named IANA zones and aliases come from the server tz database. Exclude SQL
-- abbreviations and POSIX offset expressions; UTC is the explicit fixed-zone
-- exception. Existing null preferences require an explicit user choice.
create function tr8_private.v3_valid_time_zone(p_time_zone text)
returns boolean language sql stable security invoker set search_path = '' as $$
  select p_time_zone is not null and length(p_time_zone) between 1 and 100
    and (p_time_zone='UTC' or (p_time_zone like '%/%' and p_time_zone not like 'posix/%' and p_time_zone not like 'right/%'))
    and exists(select 1 from pg_catalog.pg_timezone_names z where z.name=p_time_zone);
$$;
alter table public.tr8_workspace_tasks
  add column scheduled_start_at timestamptz,
  add column scheduled_end_at timestamptz,
  add column scheduled_time_zone text,
  add constraint tr8_tasks_schedule_complete check (
    (scheduled_start_at is null and scheduled_end_at is null and scheduled_time_zone is null)
    or (scheduled_start_at is not null and scheduled_end_at is not null and scheduled_time_zone is not null
      and isfinite(scheduled_start_at) and isfinite(scheduled_end_at)
      and scheduled_start_at >= '0001-01-01T00:00:00Z'::timestamptz
      and scheduled_end_at < '10000-01-01T00:00:00Z'::timestamptz
      and scheduled_start_at < scheduled_end_at and tr8_private.v3_valid_time_zone(scheduled_time_zone)));
alter table tr8_private.app_users
  add column calendar_time_zone text,
  add column calendar_preferences_version integer not null default 1 check(calendar_preferences_version>0),
  add constraint tr8_users_calendar_time_zone check(calendar_time_zone is null or tr8_private.v3_valid_time_zone(calendar_time_zone));
create index tr8_tasks_calendar_due on public.tr8_workspace_tasks(workspace_id,due_date,id) where due_date is not null;
create index tr8_tasks_calendar_start on public.tr8_workspace_tasks(workspace_id,start_date,id)
  where due_date is null and scheduled_start_at is null and start_date is not null;
create index tr8_tasks_calendar_block on public.tr8_workspace_tasks(workspace_id,scheduled_start_at,scheduled_end_at,id)
  where scheduled_start_at is not null;

create function tr8_private.v3_get_calendar_preferences()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform tr8_private.v2_require_actor();
  return (select jsonb_build_object('time_zone',a.calendar_time_zone,'version',a.calendar_preferences_version,'updated_at',a.updated_at)
    from tr8_private.app_users a where a.user_id=auth.uid());
end;
$$;
create function tr8_private.v3_set_calendar_preferences(p_version integer,p_time_zone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_user tr8_private.app_users;
begin
  perform tr8_private.v2_require_actor();
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception using errcode='25000',message='This operation requires read committed isolation';
  end if;
  if p_version is null or p_version<1 or not tr8_private.v3_valid_time_zone(p_time_zone) then
    raise exception using errcode='22023',message='A current version and an IANA time zone are required';
  end if;
  select * into v_user from tr8_private.app_users a where a.user_id=auth.uid() for update;
  perform tr8_private.v2_require_actor();
  if v_user.calendar_preferences_version<>p_version then
    raise exception using errcode='PT409',message='Calendar preferences changed. Reload them before saving',
      detail=jsonb_build_object('current_version',v_user.calendar_preferences_version)::text;
  end if;
  update tr8_private.app_users set calendar_time_zone=p_time_zone,
    calendar_preferences_version=calendar_preferences_version+1,updated_at=statement_timestamp() where user_id=auth.uid();
  return tr8_private.v3_get_calendar_preferences();
end;
$$;

-- A text boundary can reject offset-less local times after authenticating and
-- authorizing the resource; PostgREST must not infer an instant from server TZ.
create function tr8_private.v3_schedule_task(p_workspace_id uuid,p_id uuid,p_version integer,
  p_scheduled_start_at text,p_scheduled_end_at text,p_scheduled_time_zone text)
returns public.tr8_workspace_tasks language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.tr8_workspace_tasks; v_project uuid; v_start timestamptz; v_end timestamptz;
  v_rfc3339 text:='^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$';
begin
  perform tr8_private.v2_require_actor();
  if p_id is null or p_version is null or p_version<1 then
    raise exception using errcode='22023',message='A task identifier and current version are required';
  end if;
  perform tr8_private.v2_lock_workspace(p_workspace_id);
  perform tr8_private.v2_require_actor();
  select t.project_id into v_project from public.tr8_workspace_tasks t where t.workspace_id=p_workspace_id and t.id=p_id;
  if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  perform tr8_private.v2_require_project(p_workspace_id,v_project,'task.edit',true);
  if not ((p_scheduled_start_at is null and p_scheduled_end_at is null and p_scheduled_time_zone is null)
    or (p_scheduled_start_at is not null and p_scheduled_end_at is not null and p_scheduled_time_zone is not null
      and p_scheduled_start_at~v_rfc3339 and p_scheduled_end_at~v_rfc3339
      and tr8_private.v3_valid_time_zone(p_scheduled_time_zone))) then
    raise exception using errcode='22023',message='Provide both RFC3339 instants with explicit offsets and an IANA time zone, or clear all three';
  end if;
  if p_scheduled_start_at is not null then
    begin
      v_start:=p_scheduled_start_at::timestamptz; v_end:=p_scheduled_end_at::timestamptz;
    exception when datetime_field_overflow or invalid_datetime_format or invalid_time_zone_displacement_value then
      raise exception using errcode='22023',message='Invalid RFC3339 scheduled instants';
    end;
    if not isfinite(v_start) or not isfinite(v_end) or v_start>=v_end
      or v_start<'0001-01-01T00:00:00Z'::timestamptz or v_end>='10000-01-01T00:00:00Z'::timestamptz then
      raise exception using errcode='22023',message='The scheduled end must follow its finite start';
    end if;
  end if;
  perform 1 from public.tr8_workspace_projects p where p.workspace_id=p_workspace_id and p.id=v_project for share;
  select * into v_row from public.tr8_workspace_tasks t where t.workspace_id=p_workspace_id and t.id=p_id for update;
  if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  if v_row.version<>p_version then
    raise exception using errcode='PT409',message='This task changed. Reload it before scheduling',
      detail=jsonb_build_object('current_version',v_row.version)::text;
  end if;
  if exists(select 1 from public.tr8_workspace_projects p where p.workspace_id=p_workspace_id and p.id=v_project and p.archived_at is not null) then
    raise exception using errcode='PT409',message='Restore the archived project before editing its tasks';
  end if;
  update public.tr8_workspace_tasks set scheduled_start_at=v_start,scheduled_end_at=v_end,scheduled_time_zone=p_scheduled_time_zone
    where workspace_id=p_workspace_id and id=p_id returning * into v_row;
  insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
    values(p_workspace_id,v_project,auth.uid(),'task.scheduled',p_id);
  return v_row;
end;
$$;

-- Normalize filter arrays before binding them to the cursor. Every explicitly
-- requested workspace must be readable; project/assignee filters are selections,
-- never existence probes. Empty selections return empty authorized results.
create function tr8_private.v3_calendar_scope(p_workspace_ids uuid[],p_date_from date,p_date_to date,p_time_zone text,
  p_project_ids uuid[],p_assignee_member_ids uuid[],p_statuses text[],p_mine boolean,p_include_archived boolean,p_unscheduled boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_workspace uuid; v_workspaces uuid[]; v_projects uuid[]; v_assignees uuid[]; v_statuses text[];
begin
  perform tr8_private.v2_require_actor();
  if coalesce(array_ndims(p_workspace_ids),1)>1 or coalesce(array_ndims(p_project_ids),1)>1
    or coalesce(array_ndims(p_assignee_member_ids),1)>1 or coalesce(array_ndims(p_statuses),1)>1 then
    raise exception using errcode='22023',message='Calendar filters must be one-dimensional arrays';
  end if;
  if p_workspace_ids is null or cardinality(p_workspace_ids) not between 1 and 50 or array_position(p_workspace_ids,null) is not null
    or cardinality(p_project_ids)>250 or array_position(p_project_ids,null) is not null
    or cardinality(p_assignee_member_ids)>250 or array_position(p_assignee_member_ids,null) is not null
    or cardinality(p_statuses)>5 or array_position(p_statuses,null) is not null
    or exists(select 1 from unnest(p_statuses) x where x<>all(array['backlog','todo','progress','review','done']))
    or p_mine is null or p_include_archived is null or p_unscheduled is null then
    raise exception using errcode='22023',message='Invalid calendar filter set';
  end if;
  if not p_unscheduled and (p_date_from is null or p_date_to is null or not isfinite(p_date_from) or not isfinite(p_date_to)
    or p_date_from<'0001-01-01'::date or p_date_to>='10000-01-01'::date
    or p_date_to<=p_date_from or p_date_to-p_date_from>93 or not tr8_private.v3_valid_time_zone(p_time_zone)) then
    raise exception using errcode='22023',message='Calendar range must be 1 to 93 civil days and use an IANA time zone';
  end if;
  select array_agg(distinct x order by x) into v_workspaces from unnest(p_workspace_ids) x;
  if p_project_ids is not null then select coalesce(array_agg(distinct x order by x),array[]::uuid[]) into v_projects from unnest(p_project_ids) x; end if;
  if p_assignee_member_ids is not null then select coalesce(array_agg(distinct x order by x),array[]::uuid[]) into v_assignees from unnest(p_assignee_member_ids) x; end if;
  if p_statuses is not null then select coalesce(array_agg(distinct x order by x),array[]::text[]) into v_statuses from unnest(p_statuses) x; end if;
  -- A deterministic lock order permits general calendars across many spaces.
  foreach v_workspace in array v_workspaces loop
    perform tr8_private.v2_require_workspace(v_workspace,'task.read');
    if not tr8_private.v2_has_permission(v_workspace,'project.read') then
      raise exception using errcode='PT404',message='Resource unavailable';
    end if;
  end loop;
  return jsonb_build_object('kind',case when p_unscheduled then 'unscheduled' else 'calendar' end,
    'workspaces',v_workspaces,'projects',v_projects,'assignees',v_assignees,'statuses',v_statuses,
    'mine',p_mine,'archived',p_include_archived,'from',p_date_from,'to',p_date_to,'zone',p_time_zone);
end;
$$;

create function tr8_private.v3_calendar_cursor(p_scope jsonb,p_sort_at timestamp,p_task_id uuid,p_kind text)
returns text language sql immutable security invoker set search_path = '' as $$
  select replace(encode(convert_to(jsonb_build_object('scope',p_scope,'sort_at',p_sort_at,'task_id',p_task_id,'kind',p_kind)::text,'UTF8'),'base64'),E'\n','');
$$;
create function tr8_private.v3_parse_calendar_cursor(p_cursor text,p_scope jsonb,p_limit integer)
returns jsonb language plpgsql immutable security invoker set search_path = '' as $$
declare v_data jsonb; v_sort timestamp; v_id uuid;
begin
  if p_limit is null or p_limit not between 1 and 250 then
    raise exception using errcode='22023',message='Calendar limit must be between 1 and 250';
  end if;
  if p_cursor is null then return null; end if;
  if length(p_cursor)>32768 then raise exception using errcode='22023',message='Invalid calendar cursor'; end if;
  begin
    v_data:=convert_from(decode(p_cursor,'base64'),'UTF8')::jsonb;
    v_sort:=(v_data->>'sort_at')::timestamp; v_id:=(v_data->>'task_id')::uuid;
    if jsonb_typeof(v_data)<>'object' or (select count(*) from jsonb_object_keys(v_data))<>4
      or v_data->'scope' is distinct from p_scope or v_id is null
      or v_data->>'kind' is null or v_data->>'kind'<>all(array['block','due','start','unscheduled'])
      or (p_scope->>'kind'='calendar' and (v_sort is null or not isfinite(v_sort) or v_data->>'kind'='unscheduled'))
      or (p_scope->>'kind'='unscheduled' and (v_sort is not null or v_data->>'kind'<>'unscheduled')) then
      raise exception 'Invalid calendar cursor';
    end if;
  exception when others then
    raise exception using errcode='22023',message='Invalid calendar cursor';
  end;
  return v_data;
end;
$$;

-- This internal relation-like helper is never executable by clients. It checks
-- live project access and task.read for every task before materializing content;
-- the caller has separately locked/authorized every requested workspace.
create function tr8_private.v3_calendar_tasks(p_scope jsonb)
returns table(task public.tr8_workspace_tasks,project_name text,project_color text,project_archived_at timestamptz,
  assignee_name text,workspace_name text,can_edit boolean)
language sql stable security definer set search_path = '' as $$
  select t,p.name,p.color,p.archived_at,a.display_name,w.name,
    p.archived_at is null and tr8_private.v2_has_permission(t.workspace_id,'task.edit')
      and (w.owner_id=(select auth.uid()) or exists(select 1 from tr8_private.workspace_members em
        join tr8_private.project_access ea on ea.workspace_id=em.workspace_id and ea.member_id=em.id
        where em.workspace_id=t.workspace_id and em.user_id=(select auth.uid()) and em.status='active'
          and ea.project_id=t.project_id and ea.access_level='write'))
  from public.tr8_workspace_tasks t join public.tr8_workspace_projects p on p.workspace_id=t.workspace_id and p.id=t.project_id
    join tr8_private.workspaces w on w.id=t.workspace_id
    left join tr8_private.workspace_members m on m.workspace_id=t.workspace_id and m.id=t.assignee_member_id
    left join tr8_private.app_users a on a.user_id=m.user_id
  where t.workspace_id in(select x::uuid from jsonb_array_elements_text(p_scope->'workspaces') x)
    and tr8_private.v2_can_read_project(t.workspace_id,t.project_id)
    and tr8_private.v2_has_permission(t.workspace_id,'task.read')
    and (p_scope->'projects'='null'::jsonb or t.project_id in(select x::uuid from jsonb_array_elements_text(coalesce(nullif(p_scope->'projects','null'::jsonb),'[]'::jsonb)) x))
    and (p_scope->'assignees'='null'::jsonb or t.assignee_member_id in(select x::uuid from jsonb_array_elements_text(coalesce(nullif(p_scope->'assignees','null'::jsonb),'[]'::jsonb)) x))
    and (p_scope->'statuses'='null'::jsonb or t.status in(select x from jsonb_array_elements_text(coalesce(nullif(p_scope->'statuses','null'::jsonb),'[]'::jsonb)) x))
    and ((p_scope->>'archived')::boolean or p.archived_at is null)
    -- Bound the candidate relation before materializing projection rows. The
    -- date-leading partial indexes serve these independent civil references.
    and ((p_scope->>'kind'='unscheduled' and t.scheduled_start_at is null and t.start_date is null and t.due_date is null)
      or (p_scope->>'kind'='calendar' and (
        (t.due_date>=(p_scope->>'from')::date and t.due_date<(p_scope->>'to')::date)
        or (t.scheduled_start_at is null and t.due_date is null and t.start_date>=(p_scope->>'from')::date and t.start_date<(p_scope->>'to')::date)
        or (t.scheduled_start_at<((p_scope->>'to')::date::timestamp at time zone (p_scope->>'zone'))
          and t.scheduled_end_at>((p_scope->>'from')::date::timestamp at time zone (p_scope->>'zone'))))))
    and (not (p_scope->>'mine')::boolean or (w.kind='personal' and w.owner_id=(select auth.uid()))
      or (w.kind='team' and m.user_id=(select auth.uid()) and m.status='active'));
$$;
create function tr8_private.v3_calendar_item(p_task public.tr8_workspace_tasks,p_kind text,p_project_name text,p_project_color text,
  p_project_archived_at timestamptz,p_assignee_name text,p_workspace_name text,p_can_edit boolean,p_date date,p_start_at timestamptz,p_end_at timestamptz)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('id',p_task.id::text||':'||p_kind,'kind',p_kind,'workspace_id',p_task.workspace_id,
    'project_id',p_task.project_id,'project_name',p_project_name,'project_color',p_project_color,'project_archived_at',p_project_archived_at,
    'workspace_name',p_workspace_name,'can_edit',p_can_edit,
    'task_id',p_task.id,'task_number',p_task.task_number,'title',p_task.title,'status',p_task.status,'priority',p_task.priority,
    'version',p_task.version,'assignee_member_id',p_task.assignee_member_id,'assignee_name',p_assignee_name,
    'start_date',p_task.start_date,'due_date',p_task.due_date,'scheduled_start_at',p_task.scheduled_start_at,
    'scheduled_end_at',p_task.scheduled_end_at,'scheduled_time_zone',p_task.scheduled_time_zone,
    'date',p_date,'start_at',p_start_at,'end_at',p_end_at);
$$;

create function tr8_private.v3_list_calendar(p_workspace_ids uuid[],p_date_from date,p_date_to date,p_time_zone text,
  p_project_ids uuid[] default null,p_assignee_member_ids uuid[] default null,p_statuses text[] default null,
  p_mine boolean default false,p_include_archived boolean default false,p_cursor text default null,p_limit integer default 100)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_scope jsonb; v_cursor jsonb; v_items jsonb; v_next text; v_rows jsonb; v_last jsonb;
  v_from timestamptz; v_to timestamptz;
begin
  v_scope:=tr8_private.v3_calendar_scope(p_workspace_ids,p_date_from,p_date_to,p_time_zone,p_project_ids,p_assignee_member_ids,p_statuses,p_mine,p_include_archived,false);
  v_cursor:=tr8_private.v3_parse_calendar_cursor(p_cursor,v_scope,p_limit);
  v_from:=p_date_from::timestamp at time zone p_time_zone;
  v_to:=p_date_to::timestamp at time zone p_time_zone;
  with tasks as materialized(select * from tr8_private.v3_calendar_tasks(v_scope)),
  projected as (
    select (q.task).id as task_id,'block'::text kind,(q.task).scheduled_start_at at time zone p_time_zone as sort_at,
      tr8_private.v3_calendar_item(q.task,'block',q.project_name,q.project_color,q.project_archived_at,q.assignee_name,q.workspace_name,q.can_edit,null,(q.task).scheduled_start_at,(q.task).scheduled_end_at) item
    from tasks q where (q.task).scheduled_start_at<v_to and (q.task).scheduled_end_at>v_from
    union all
    select (q.task).id,'due',(q.task).due_date::timestamp,
      tr8_private.v3_calendar_item(q.task,'due',q.project_name,q.project_color,q.project_archived_at,q.assignee_name,q.workspace_name,q.can_edit,(q.task).due_date,null,null)
    from tasks q where (q.task).due_date>=p_date_from and (q.task).due_date<p_date_to
    union all
    select (q.task).id,'start',(q.task).start_date::timestamp,
      tr8_private.v3_calendar_item(q.task,'start',q.project_name,q.project_color,q.project_archived_at,q.assignee_name,q.workspace_name,q.can_edit,(q.task).start_date,null,null)
    from tasks q where (q.task).scheduled_start_at is null and (q.task).due_date is null and (q.task).start_date>=p_date_from and (q.task).start_date<p_date_to),
  page as(select * from projected p where v_cursor is null or (p.sort_at,p.task_id,p.kind)>
    ((v_cursor->>'sort_at')::timestamp,(v_cursor->>'task_id')::uuid,v_cursor->>'kind') order by sort_at,task_id,kind limit p_limit+1)
  select coalesce(jsonb_agg(jsonb_build_object('sort_at',p.sort_at,'task_id',p.task_id,'kind',p.kind,'item',p.item) order by sort_at,task_id,kind),'[]'::jsonb)
    into v_rows from page p;
  select coalesce(jsonb_agg(x.value->'item' order by x.ordinality),'[]'::jsonb) into v_items
    from jsonb_array_elements(v_rows) with ordinality x(value,ordinality) where x.ordinality<=p_limit;
  if jsonb_array_length(v_rows)>p_limit then
    v_last:=v_rows->(p_limit-1);
    v_next:=tr8_private.v3_calendar_cursor(v_scope,(v_last->>'sort_at')::timestamp,(v_last->>'task_id')::uuid,v_last->>'kind');
  end if;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

create function tr8_private.v3_list_unscheduled(p_workspace_ids uuid[],p_project_ids uuid[] default null,
  p_assignee_member_ids uuid[] default null,p_statuses text[] default null,p_mine boolean default false,
  p_include_archived boolean default false,p_cursor text default null,p_limit integer default 100)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_scope jsonb; v_cursor jsonb; v_rows jsonb; v_items jsonb; v_next text;
begin
  v_scope:=tr8_private.v3_calendar_scope(p_workspace_ids,null,null,null,p_project_ids,p_assignee_member_ids,p_statuses,p_mine,p_include_archived,true);
  v_cursor:=tr8_private.v3_parse_calendar_cursor(p_cursor,v_scope,p_limit);
  with page as(select q.* from tr8_private.v3_calendar_tasks(v_scope) q
    where (q.task).scheduled_start_at is null and (q.task).start_date is null and (q.task).due_date is null
      and (v_cursor is null or (q.task).id>(v_cursor->>'task_id')::uuid) order by (q.task).id limit p_limit+1)
  select coalesce(jsonb_agg(tr8_private.v3_calendar_item(q.task,'unscheduled',q.project_name,q.project_color,q.project_archived_at,q.assignee_name,q.workspace_name,q.can_edit,null,null,null) order by (q.task).id),'[]'::jsonb)
    into v_rows from page q;
  select coalesce(jsonb_agg(x.value order by x.ordinality),'[]'::jsonb) into v_items
    from jsonb_array_elements(v_rows) with ordinality x(value,ordinality) where x.ordinality<=p_limit;
  if jsonb_array_length(v_rows)>p_limit then
    v_next:=tr8_private.v3_calendar_cursor(v_scope,null,(v_rows->(p_limit-1)->>'task_id')::uuid,'unscheduled');
  end if;
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

create function public.tr8_v2_get_calendar_preferences()
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v3_get_calendar_preferences(); $$;
create function public.tr8_v2_set_calendar_preferences(p_version integer,p_time_zone text)
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v3_set_calendar_preferences(p_version,p_time_zone); $$;
create function public.tr8_v2_schedule_task(p_workspace_id uuid,p_id uuid,p_version integer,
  p_scheduled_start_at text,p_scheduled_end_at text,p_scheduled_time_zone text)
returns public.tr8_workspace_tasks language sql volatile security invoker set search_path = '' as $$
  select tr8_private.v3_schedule_task(p_workspace_id,p_id,p_version,p_scheduled_start_at,p_scheduled_end_at,p_scheduled_time_zone); $$;
create function public.tr8_v2_list_calendar(p_workspace_ids uuid[],p_date_from date,p_date_to date,p_time_zone text,
  p_project_ids uuid[] default null,p_assignee_member_ids uuid[] default null,p_statuses text[] default null,
  p_mine boolean default false,p_include_archived boolean default false,p_cursor text default null,p_limit integer default 100)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select tr8_private.v3_list_calendar(p_workspace_ids,p_date_from,p_date_to,p_time_zone,p_project_ids,p_assignee_member_ids,p_statuses,p_mine,p_include_archived,p_cursor,p_limit); $$;
create function public.tr8_v2_list_unscheduled(p_workspace_ids uuid[],p_project_ids uuid[] default null,
  p_assignee_member_ids uuid[] default null,p_statuses text[] default null,p_mine boolean default false,
  p_include_archived boolean default false,p_cursor text default null,p_limit integer default 100)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select tr8_private.v3_list_unscheduled(p_workspace_ids,p_project_ids,p_assignee_member_ids,p_statuses,p_mine,p_include_archived,p_cursor,p_limit); $$;
do $stage3_grants$
declare v_fn record; v_names text[]:=array['get_calendar_preferences','set_calendar_preferences','schedule_task','list_calendar','list_unscheduled'];
begin
  for v_fn in select p.oid::regprocedure as signature,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='tr8_private' and p.proname like 'v3_%')
      or (n.nspname='public' and p.proname=any(array(select 'tr8_v2_'||x from unnest(v_names) x))) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',v_fn.signature);
    if (v_fn.nspname='public' and substring(v_fn.proname from 8)=any(v_names))
      or (v_fn.nspname='tr8_private' and substring(v_fn.proname from 4)=any(v_names)) then
      execute format('grant execute on function %s to authenticated',v_fn.signature);
    end if;
  end loop;
end;
$stage3_grants$;
do $stage3_preservation$
declare s record;
begin
  select * into strict s from tr8_stage3_snapshot;
  if s.projects_oid<>'public.tr8_workspace_projects'::regclass::oid or s.tasks_oid<>'public.tr8_workspace_tasks'::regclass::oid
    or s.sequence_oid<>pg_get_serial_sequence('public.tr8_workspace_tasks','task_number')::regclass::oid
    or s.projects_hash is distinct from (select md5(coalesce(string_agg(to_jsonb(p)::text,E'\n' order by id),'')) from public.tr8_workspace_projects p)
    or s.tasks_hash is distinct from (select md5(coalesce(string_agg((to_jsonb(t)-array['scheduled_start_at','scheduled_end_at','scheduled_time_zone'])::text,E'\n' order by id),'')) from public.tr8_workspace_tasks t)
    or s.users_hash is distinct from (select md5(coalesce(string_agg((to_jsonb(a)-array['calendar_time_zone','calendar_preferences_version'])::text,E'\n' order by user_id),'')) from tr8_private.app_users a)
    or s.sequence_state is distinct from (select jsonb_build_object('last_value',q.last_value,'is_called',q.is_called) from public.tr8_tasks_task_number_seq q)
    or s.app_config is distinct from (select to_jsonb(c) from tr8_private.app_config c where singleton)
    or s.old_api is distinct from (select jsonb_object_agg(p.oid::text,jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','tr8_private')
        and (p.proname like 'tr8_v2_%' or p.proname like 'v2_%' or p.proname='guard_task')
        and not (n.nspname='public' and p.proname in ('tr8_v2_get_calendar_preferences','tr8_v2_set_calendar_preferences','tr8_v2_schedule_task','tr8_v2_list_calendar','tr8_v2_list_unscheduled')))
    or exists(select 1 from public.tr8_workspace_tasks where scheduled_start_at is not null or scheduled_end_at is not null or scheduled_time_zone is not null)
    or exists(select 1 from tr8_private.app_users where calendar_time_zone is not null or calendar_preferences_version<>1) then
    raise exception 'Stage 3 changed historical data, APIs, versions, identities, sequence or onboarding settings';
  end if;
end;
$stage3_preservation$;
comment on column public.tr8_workspace_tasks.scheduled_time_zone is 'IANA zone used to schedule the optional block. All three block fields are complete or null; civil due/start dates remain independent.';
comment on column tr8_private.app_users.calendar_time_zone is 'Own explicit display preference. Null until selected; never inferred from IP or used to shift civil dates.';
notify pgrst,'reload schema';
