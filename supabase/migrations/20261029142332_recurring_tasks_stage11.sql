-- Stage 11: one materialized successor after a task is completed. Recurrence
-- is private metadata: no existing task, project, finance or Auth row changes.
-- The durable occurrence ledger deliberately has no foreign key to task rows.
-- Deleting a generated task must never make a replay recreate that occurrence.
begin;
lock table public.tr8_workspace_projects, public.tr8_workspace_tasks,
  tr8_private.account_finances, tr8_private.app_config in share row exclusive mode;
create temporary table tr8_recurrence_before on commit drop as select
 (select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p) projects,
 (select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t) tasks,
 (select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f) finances,
 (select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c) config;

create table tr8_private.task_recurrence_series (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
 project_id uuid not null,
 author_id uuid not null references tr8_private.app_users(user_id) on delete cascade,
 version integer not null default 1 check(version between 1 and 2147483647),
 frequency text not null check(frequency in ('daily','weekly','monthly')),
 interval_count integer not null check(interval_count between 1 and 365),
 weekdays integer[] not null default '{}',
 time_zone text not null check(tr8_private.v3_valid_time_zone(time_zone)),
 until_date date check(until_date between date '0001-01-01' and date '9999-12-31'),
 anchor_date date not null check(anchor_date between date '0001-01-01' and date '9999-12-31'),
 start_offset integer check(start_offset<=0),
 state text not null default 'active' check(state in ('active','paused','blocked','finished')),
 reason text check(reason in ('paused_by_user','task_archived','project_archived','task_moved','task_deleted',
   'authority_lost','assignee_not_inherited','until_reached','date_limit')),
 current_task_id uuid not null,
 current_task_created_at timestamptz not null check(isfinite(current_task_created_at)),
 current_occurrence_date date not null check(current_occurrence_date between date '0001-01-01' and date '9999-12-31'),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(current_task_id,current_task_created_at),
 foreign key(workspace_id,project_id) references public.tr8_workspace_projects(workspace_id,id) on delete cascade,
 check(until_date is null or until_date>=anchor_date),
 check((frequency='daily' and interval_count<=365 and cardinality(weekdays)=0)
   or (frequency='weekly' and interval_count<=52 and cardinality(weekdays) between 1 and 7
     and weekdays<@array[1,2,3,4,5,6,7] and array_position(weekdays,null) is null)
   or (frequency='monthly' and interval_count<=12 and cardinality(weekdays)=0))
);
create index tr8_recurrence_series_scope on tr8_private.task_recurrence_series(workspace_id,id);
create index tr8_recurrence_series_project on tr8_private.task_recurrence_series(workspace_id,project_id,id);
create index tr8_recurrence_series_author on tr8_private.task_recurrence_series(author_id);

create table tr8_private.task_recurrence_occurrences (
 task_id uuid not null,
 task_created_at timestamptz not null check(isfinite(task_created_at)),
 series_id uuid not null references tr8_private.task_recurrence_series(id) on delete cascade,
 occurrence_date date not null check(occurrence_date between date '0001-01-01' and date '9999-12-31'),
 successor_task_id uuid,
 successor_task_created_at timestamptz,
 processed boolean not null default false,
 created_at timestamptz not null default clock_timestamp(),
 primary key(task_id,task_created_at),
 check((successor_task_id is null)=(successor_task_created_at is null)),
 check(successor_task_id is null or processed)
);
create index tr8_recurrence_occurrences_series on tr8_private.task_recurrence_occurrences(series_id,occurrence_date,task_id);

-- Receipts are bounded and contain only configuration/identities. A save always
-- advances series.version, so deleting an old receipt cannot replay that write.
create table tr8_private.task_recurrence_receipts (
 owner_id uuid not null references tr8_private.app_users(user_id) on delete cascade,
 workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
 request_id uuid not null,
 payload_hash text not null check(payload_hash~'^[0-9a-f]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),
 created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,workspace_id,request_id)
);
create index tr8_recurrence_receipts_workspace on tr8_private.task_recurrence_receipts(workspace_id);
create index tr8_recurrence_receipts_retention on tr8_private.task_recurrence_receipts(owner_id,workspace_id,created_at,request_id);
alter table tr8_private.task_recurrence_series enable row level security;
alter table tr8_private.task_recurrence_occurrences enable row level security;
alter table tr8_private.task_recurrence_receipts enable row level security;
revoke all on tr8_private.task_recurrence_series,tr8_private.task_recurrence_occurrences,tr8_private.task_recurrence_receipts
 from public,anon,authenticated,service_role;

create function tr8_private.recurrence_rule(r jsonb,anchor date) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare f text;n integer;days integer[];ending date;v jsonb;
begin
 perform tr8_private.productivity_keys(r,array['frequency','interval','weekdays','time_zone','until_date']);
 if jsonb_typeof(r->'frequency') is distinct from 'string' or r->>'frequency'<>all(array['daily','weekly','monthly'])
  or jsonb_typeof(r->'interval') is distinct from 'number' or r->>'interval'!~'^[1-9][0-9]{0,2}$'
  or jsonb_typeof(r->'time_zone') is distinct from 'string' or not tr8_private.v3_valid_time_zone(r->>'time_zone')
  or jsonb_typeof(r->'weekdays') is distinct from 'array' then
  raise exception using errcode='22023',message='Invalid recurrence rule';
 end if;
 f:=r->>'frequency';n:=(r->>'interval')::integer;
 if n>(case f when 'daily' then 365 when 'weekly' then 52 else 12 end) then
  raise exception using errcode='22023',message='Recurrence interval is out of range';
 end if;
 if jsonb_array_length(r->'weekdays')>7 then raise exception using errcode='22023',message='Invalid recurrence weekdays';end if;
 for v in select value from jsonb_array_elements(r->'weekdays') loop
  if jsonb_typeof(v)<>'number' or v::text!~'^[1-7]$' then raise exception using errcode='22023',message='Invalid recurrence weekdays';end if;
 end loop;
 select coalesce(array_agg(value::text::integer order by value::text::integer),'{}'::integer[]) into days from jsonb_array_elements(r->'weekdays');
 if (select count(distinct x) from unnest(days)x)<>cardinality(days)
  or (f='weekly' and cardinality(days)=0) or (f<>'weekly' and cardinality(days)<>0) then
  raise exception using errcode='22023',message='Weekly recurrence requires distinct ISO weekdays; other rules require no weekdays';
 end if;
 if r->'until_date' is distinct from 'null'::jsonb then
  if jsonb_typeof(r->'until_date') is distinct from 'string' or r->>'until_date'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
   raise exception using errcode='22023',message='Invalid recurrence end date';end if;
  begin ending:=(r->>'until_date')::date;exception when datetime_field_overflow or invalid_datetime_format then
   raise exception using errcode='22023',message='Invalid recurrence end date';end;
  if ending not between date '0001-01-01' and date '9999-12-31' or ending<anchor or to_char(ending,'YYYY-MM-DD')<>r->>'until_date' then
   raise exception using errcode='22023',message='The recurrence end date must follow its anchor';end if;
 end if;
 return jsonb_build_object('frequency',f,'interval',n,'weekdays',to_jsonb(days),'time_zone',r->>'time_zone','until_date',ending);
end;$$;

create function tr8_private.recurrence_version(v jsonb) returns integer
language plpgsql immutable security invoker set search_path='' as $$
begin
 if v is null or jsonb_typeof(v)<>'number' or v::text!~'^[1-9][0-9]{0,9}$' then
  raise exception using errcode='22023',message='A positive expected recurrence version is required';end if;
 if v::text::numeric>2147483647 then raise exception using errcode='22023',message='Expected recurrence version is out of range';end if;
 return v::text::integer;
end;$$;

-- Bounded arithmetic, not a daily search or a cron catch-up. Month-end clamps
-- are calculated from the original anchor, so 31 Jan -> 28 Feb -> 31 Mar.
-- p_after already includes the current civil date in the chosen IANA zone.
create function tr8_private.recurrence_next_date(anchor date,f text,n integer,days integer[],ending date,p_after date)
returns date language plpgsql immutable security invoker set search_path='' as $$
declare candidate date;week_start date;month_start date;k integer;day_number integer;
begin
 if anchor is null or p_after is null or anchor not between date '0001-01-01' and date '9999-12-31'
  or p_after not between date '0001-01-01' and date '9999-12-31' or n<1 then return null;end if;
 if f='daily' then
  k:=greatest(0,(p_after-anchor)/n+1);candidate:=anchor+k*n;
 elsif f='weekly' then
  week_start:=anchor-(extract(isodow from anchor)::integer-1);
  k:=greatest(0,(p_after-week_start)/(7*n));week_start:=week_start+k*7*n;
  select min(week_start+d-1) into candidate from unnest(days)d where week_start+d-1>p_after and week_start+d-1>=anchor;
  if candidate is null then select week_start+7*n+min(d)-1 into candidate from unnest(days)d;end if;
 elsif f='monthly' then
  k:=greatest(0,((extract(year from p_after)::integer-extract(year from anchor)::integer)*12
   +extract(month from p_after)::integer-extract(month from anchor)::integer)/n);
  month_start:=(date_trunc('month',anchor::timestamp)+make_interval(months=>k*n))::date;
  day_number:=extract(day from anchor)::integer;
  candidate:=month_start+least(day_number,extract(day from month_start+interval '1 month - 1 day')::integer)-1;
  if candidate<=p_after then
   month_start:=(month_start+make_interval(months=>n))::date;
   candidate:=month_start+least(day_number,extract(day from month_start+interval '1 month - 1 day')::integer)-1;
  end if;
 else return null;end if;
 if candidate is null or candidate<=p_after or candidate not between date '0001-01-01' and date '9999-12-31'
  or (ending is not null and candidate>ending) then return null;end if;
 return candidate;
end;$$;

create function tr8_private.recurrence_series_json(s tr8_private.task_recurrence_series) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',s.id,'workspace_id',s.workspace_id,'project_id',s.project_id,'version',s.version,
  'rule',jsonb_build_object('frequency',s.frequency,'interval',s.interval_count,'weekdays',to_jsonb(s.weekdays),'time_zone',s.time_zone,'until_date',s.until_date),
  'anchor_date',s.anchor_date,'state',s.state,'reason',s.reason,'current_task_id',s.current_task_id,
  'current_task_created_at',s.current_task_created_at,'current_occurrence_date',s.current_occurrence_date);
$$;

create function tr8_private.recurrence_state(w uuid,p uuid,t uuid,c timestamptz) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('task_id',t,'series',case when s.id is not null then tr8_private.recurrence_series_json(s) else null end,
  'occurrence_date',case when s.id is not null then o.occurrence_date else null end,
  'successor_task_id',case when s.id is not null then o.successor_task_id else null end)
 from (select 1) one
 left join tr8_private.task_recurrence_occurrences o on o.task_id=t and o.task_created_at=c
 left join tr8_private.task_recurrence_series s on s.id=o.series_id and s.workspace_id=w and s.project_id=p;
$$;

-- This trusted helper is called only after a locked, authorized task transition
-- or an explicit browser save. It does not impersonate auth.uid or require the
-- completer to create: the live author explicitly authorized this automation.
-- The Google worker, MCP, individual and bulk mutations all reach this hook.
create function tr8_private.recurrence_generate(t public.tr8_workspace_tasks) returns void
language plpgsql volatile security definer set search_path='' as $$
declare s tr8_private.task_recurrence_series;o tr8_private.task_recurrence_occurrences;
 next_date date;next_start date;child public.tr8_workspace_tasks;assignee uuid;why text;today date;
begin
 select q.* into s from tr8_private.task_recurrence_series q
  where q.current_task_id=t.id and q.current_task_created_at=t.created_at for update;
 if not found or s.state<>'active' or s.workspace_id<>t.workspace_id or s.project_id<>t.project_id or t.archived_at is not null or t.status<>'done' then return;end if;
 select * into o from tr8_private.task_recurrence_occurrences q where q.task_id=t.id and q.task_created_at=t.created_at for update;
 if not found or o.series_id<>s.id or o.processed then return;end if;
 if not tr8_private.v7_domain_permission(s.workspace_id,s.project_id,s.author_id,'task.edit')
  or not tr8_private.v7_domain_permission(s.workspace_id,s.project_id,s.author_id,'task.create') then
  update tr8_private.task_recurrence_series set state='blocked',reason='authority_lost',version=version+1,updated_at=clock_timestamp() where id=s.id;
  return;
 end if;
 today:=(clock_timestamp() at time zone s.time_zone)::date;
 next_date:=tr8_private.recurrence_next_date(s.anchor_date,s.frequency,s.interval_count,s.weekdays,s.until_date,greatest(o.occurrence_date,today));
 if next_date is null then
  update tr8_private.task_recurrence_occurrences set processed=true where task_id=t.id and task_created_at=t.created_at;
  update tr8_private.task_recurrence_series set state='finished',reason=case when s.until_date is not null then 'until_reached' else 'date_limit' end,
   version=version+1,updated_at=clock_timestamp() where id=s.id;
  return;
 end if;
 if t.assignee_member_id is not null then
  if tr8_private.v7_domain_permission(s.workspace_id,s.project_id,s.author_id,'task.assign')
   and tr8_private.v2_assignee_eligible(s.workspace_id,s.project_id,t.assignee_member_id) then assignee:=t.assignee_member_id;
  else why:='assignee_not_inherited';end if;
 end if;
 if s.start_offset is not null and next_date+s.start_offset between date '0001-01-01' and date '9999-12-31' then next_start:=next_date+s.start_offset;end if;
 -- Assignee is present in the original INSERT: Google capture must not see an
 -- intermediate unassigned task. Blocks are intentionally not copied in v1.
 insert into public.tr8_workspace_tasks(id,workspace_id,owner_id,project_id,title,description,status,priority,start_date,due_date,
  assignee_member_id,labels,estimate_minutes,subtasks)
 values(gen_random_uuid(),s.workspace_id,s.author_id,s.project_id,t.title,t.description,'todo',t.priority,next_start,next_date,assignee,
  t.labels,t.estimate_minutes,coalesce((select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'title',x.value->>'title','done',false) order by x.ordinality)
   from jsonb_array_elements(t.subtasks) with ordinality x(value,ordinality)),'[]'::jsonb)) returning * into child;
 insert into tr8_private.task_recurrence_occurrences(task_id,task_created_at,series_id,occurrence_date) values(child.id,child.created_at,s.id,next_date);
 update tr8_private.task_recurrence_occurrences set processed=true,successor_task_id=child.id,successor_task_created_at=child.created_at
  where task_id=t.id and task_created_at=t.created_at;
 update tr8_private.task_recurrence_series set current_task_id=child.id,current_task_created_at=child.created_at,
  current_occurrence_date=next_date,reason=why,version=version+1,updated_at=clock_timestamp() where id=s.id;
 insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
  values(s.workspace_id,s.project_id,s.author_id,'task.created',child.id);
end;$$;

create function tr8_private.recurrence_task_change() returns trigger
language plpgsql volatile security definer set search_path='' as $$
declare why text;
begin
 if tg_op='DELETE' then why:='task_deleted';
 elsif new.project_id is distinct from old.project_id then why:='task_moved';
 elsif new.archived_at is not null and old.archived_at is null then why:='task_archived';end if;
 if why is not null then
  update tr8_private.task_recurrence_series set state='paused',reason=why,version=version+1,updated_at=clock_timestamp()
   where current_task_id=old.id and current_task_created_at=old.created_at;
 elsif old.status<>'done' and new.status='done' then perform tr8_private.recurrence_generate(new);end if;
 if tg_op='DELETE' then return old;end if;return new;
end;$$;
create trigger tr8_recurrence_task_change after update or delete on public.tr8_workspace_tasks
 for each row execute function tr8_private.recurrence_task_change();

create function tr8_private.recurrence_project_change() returns trigger
language plpgsql volatile security definer set search_path='' as $$
begin
 if old.archived_at is null and new.archived_at is not null then
  update tr8_private.task_recurrence_series set state='paused',reason='project_archived',version=version+1,updated_at=clock_timestamp()
   where workspace_id=new.workspace_id and project_id=new.id;
 end if;return new;
end;$$;
create trigger tr8_recurrence_project_change after update of archived_at on public.tr8_workspace_projects
 for each row execute function tr8_private.recurrence_project_change();

create function tr8_private.recurrence(w uuid,a text,i jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_variable
declare actor uuid:=auth.uid();tid uuid;pid uuid;created timestamptz;rid uuid;after_id uuid;lim integer;task_version integer;sv integer;
 t public.tr8_workspace_tasks;s tr8_private.task_recurrence_series;o tr8_private.task_recurrence_occurrences;
 r tr8_private.task_recurrence_receipts;h text;result jsonb;rule jsonb;ids uuid[];stamp text;
begin
 perform tr8_private.v7_require_browser_session();
 perform tr8_private.v2_require_workspace(w,'project.read');
 if a is null or a<>all(array['state','list','save']) then raise exception using errcode='22023',message='Unknown recurrence action';end if;
 if a='list' then
  perform tr8_private.productivity_keys(i,array['after_id','limit']);
  if i->'after_id' is distinct from 'null'::jsonb then after_id:=tr8_private.planning_id(i->'after_id');end if;
  if jsonb_typeof(i->'limit') is distinct from 'number' or i->>'limit'!~'^[1-9][0-9]{0,2}$' or (i->>'limit')::integer>100 then
   raise exception using errcode='22023',message='Recurrence page limit must be between one and one hundred';end if;lim:=(i->>'limit')::integer;
  if not tr8_private.v2_has_permission(w,'task.read') then raise exception using errcode='PT404',message='Resource unavailable';end if;
  select array_agg(q.id order by q.id) into ids from (
   select z.id from tr8_private.task_recurrence_series z join public.tr8_workspace_tasks head
    on head.id=z.current_task_id and head.created_at=z.current_task_created_at and head.workspace_id=z.workspace_id and head.project_id=z.project_id
   where z.workspace_id=w and (after_id is null or z.id>after_id) and tr8_private.v2_can_read_project(w,z.project_id)
   order by z.id limit lim+1)q;
  return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('series_id',z.id,'task_id',z.current_task_id,
    'frequency',z.frequency,'interval',z.interval_count,'state',z.state) order by z.id) from tr8_private.task_recurrence_series z where z.id=any(ids[1:lim])),'[]'::jsonb),
   'next_cursor',case when cardinality(ids)>lim then ids[lim] else null end);
 end if;
 perform tr8_private.productivity_keys(i,case a when 'state' then array['id','project_id','created_at']
  else array['id','project_id','created_at','task_version','series_version','request_id','rule'] end);
 tid:=tr8_private.planning_id(i->'id');pid:=tr8_private.planning_id(i->'project_id');
 stamp:=i->>'created_at';
 if jsonb_typeof(i->'created_at') is distinct from 'string' or stamp!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
  raise exception using errcode='22023',message='A precise task creation identity is required';end if;
 begin created:=stamp::timestamptz;exception when datetime_field_overflow or invalid_datetime_format or invalid_time_zone_displacement_value then
  raise exception using errcode='22023',message='Invalid task creation identity';end;
 if not isfinite(created) then raise exception using errcode='22023',message='Invalid task creation identity';end if;
 perform tr8_private.v2_require_project(w,pid,'task.read',false);
 if a='state' then
  select * into t from public.tr8_workspace_tasks q where q.workspace_id=w and q.project_id=pid and q.id=tid and q.created_at=created;
  if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
  return tr8_private.recurrence_state(w,pid,tid,created);
 end if;
 task_version:=tr8_private.recurrence_version(i->'task_version');rid:=tr8_private.planning_id(i->'request_id');
 if i->'series_version' is distinct from 'null'::jsonb then sv:=tr8_private.recurrence_version(i->'series_version');end if;
 -- Actor/workspace command lock precedes project and task locks, matching bulk
 -- and work_management. Every path takes task BEFORE series/occurrence locks.
 perform pg_advisory_xact_lock(hashtextextended('tr8-wm:'||actor::text||':'||w::text,0));
 perform 1 from public.tr8_workspace_projects q where q.workspace_id=w and q.id=pid for share;
 select * into t from public.tr8_workspace_tasks q where q.workspace_id=w and q.project_id=pid and q.id=tid and q.created_at=created for update;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 h:=encode(extensions.digest(convert_to(i::text,'UTF8'),'sha256'),'hex');
 select * into r from tr8_private.task_recurrence_receipts q where q.owner_id=actor and q.workspace_id=w and q.request_id=rid;
 if found then
  if r.payload_hash<>h then raise exception using errcode='PT409',message='Recurrence request identifier reused with different data';end if;
  -- Read authorization above is still mandatory after a successful write.
  return r.result;
 end if;
 perform tr8_private.v2_require_project(w,pid,'task.edit',true);
 if t.version<>task_version then raise exception using errcode='PT409',message='This task changed. Reload it before changing repetition';end if;
 if t.archived_at is not null or exists(select 1 from public.tr8_workspace_projects p where p.workspace_id=w and p.id=pid and p.archived_at is not null) then
  raise exception using errcode='PT409',message='Restore archived resources before changing repetition';end if;
 select * into o from tr8_private.task_recurrence_occurrences q where q.task_id=tid and q.task_created_at=created;
 if found then
  select * into s from tr8_private.task_recurrence_series q where q.id=o.series_id for update;
  if s.workspace_id<>w or s.project_id<>pid or s.current_task_id<>tid or s.current_task_created_at<>created then
   raise exception using errcode='PT409',message='Only the current occurrence can change repetition';end if;
  if sv is null or sv<>s.version then raise exception using errcode='PT409',message='This repetition changed. Reload it before editing';end if;
 elsif sv is not null then raise exception using errcode='PT409',message='This repetition is no longer available';end if;
 if i->'rule' is distinct from 'null'::jsonb then
  if t.due_date is null or not isfinite(t.due_date) or t.due_date not between date '0001-01-01' and date '9999-12-31' then
   raise exception using errcode='22023',message='Set a valid task due date before configuring repetition';end if;
  perform tr8_private.v2_require_project(w,pid,'task.create',true);
  rule:=tr8_private.recurrence_rule(i->'rule',coalesce(s.anchor_date,t.due_date));
  if o.processed then raise exception using errcode='PT409',message='Start a new recurrence on another task after this series has finished';end if;
  if t.status='done' and (s.id is null or s.state not in ('blocked','paused') or o.processed) then
   raise exception using errcode='PT409',message='Start repetition on an open task, or explicitly resume a blocked current occurrence';end if;
 end if;
 delete from tr8_private.task_recurrence_receipts q where q.owner_id=actor and q.workspace_id=w and q.request_id in (
  select z.request_id from tr8_private.task_recurrence_receipts z where z.owner_id=actor and z.workspace_id=w
   and z.created_at<clock_timestamp()-interval '7 days' order by z.created_at,z.request_id limit 1000);
 if (select count(*) from tr8_private.task_recurrence_receipts q where q.owner_id=actor and q.workspace_id=w and q.created_at>=clock_timestamp()-interval '24 hours')>=1000 then
  raise exception using errcode='PT429',message='Recurrence configuration request budget reached';end if;
 if i->'rule'='null'::jsonb then
  if s.id is not null then update tr8_private.task_recurrence_series set state='paused',reason='paused_by_user',version=version+1,updated_at=clock_timestamp() where id=s.id;end if;
 elsif s.id is null then
  insert into tr8_private.task_recurrence_series(workspace_id,project_id,author_id,frequency,interval_count,weekdays,time_zone,until_date,
   anchor_date,start_offset,current_task_id,current_task_created_at,current_occurrence_date)
  values(w,pid,actor,rule->>'frequency',(rule->>'interval')::integer,array(select value::text::integer from jsonb_array_elements(rule->'weekdays')),
   rule->>'time_zone',(rule->>'until_date')::date,t.due_date,case when t.start_date is not null and t.start_date<=t.due_date then t.start_date-t.due_date else null end,
   tid,created,t.due_date) returning * into s;
  insert into tr8_private.task_recurrence_occurrences(task_id,task_created_at,series_id,occurrence_date) values(tid,created,s.id,t.due_date);
 else
  update tr8_private.task_recurrence_series set author_id=actor,frequency=rule->>'frequency',interval_count=(rule->>'interval')::integer,
   weekdays=array(select value::text::integer from jsonb_array_elements(rule->'weekdays')),time_zone=rule->>'time_zone',until_date=(rule->>'until_date')::date,
   state='active',reason=null,version=version+1,updated_at=clock_timestamp() where id=s.id;
  if t.status='done' then perform tr8_private.recurrence_generate(t);end if;
 end if;
 perform tr8_private.v7_require_browser_session();perform tr8_private.v2_require_actor();
 result:=tr8_private.recurrence_state(w,pid,tid,created);
 insert into tr8_private.task_recurrence_receipts(owner_id,workspace_id,request_id,payload_hash,result) values(actor,w,rid,h,result);
 return result;
end;$$;

create function public.tr8_v2_recurrence(p_workspace_id uuid,p_action text,p_input jsonb) returns jsonb
language sql volatile security invoker set search_path='' as $$select tr8_private.recurrence(p_workspace_id,p_action,p_input);$$;
revoke all on function tr8_private.recurrence_rule(jsonb,date),tr8_private.recurrence_version(jsonb),tr8_private.recurrence_next_date(date,text,integer,integer[],date,date),
 tr8_private.recurrence_series_json(tr8_private.task_recurrence_series),tr8_private.recurrence_state(uuid,uuid,uuid,timestamptz),
 tr8_private.recurrence_generate(public.tr8_workspace_tasks),tr8_private.recurrence_task_change(),tr8_private.recurrence_project_change(),
 tr8_private.recurrence(uuid,text,jsonb),public.tr8_v2_recurrence(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function tr8_private.recurrence(uuid,text,jsonb),public.tr8_v2_recurrence(uuid,text,jsonb) to authenticated;

do $$declare before_row record;begin
 select * into strict before_row from tr8_recurrence_before;
 if before_row.projects is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p)
  or before_row.tasks is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t)
  or before_row.finances is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f)
  or before_row.config is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c)
 then raise exception 'Stage 11 unexpectedly changed existing data';end if;
end;$$;
notify pgrst,'reload schema';
commit;
