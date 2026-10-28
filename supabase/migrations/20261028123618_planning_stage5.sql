-- Demo parity stage 5: informative task dependencies and project milestones.
-- No dates, task states, provider identities, financial documents or auth settings
-- are rewritten. Stage 4 copies remain independent and do not copy this planning.
begin;
lock table public.tr8_workspace_projects, public.tr8_workspace_tasks,
  tr8_private.account_finances, tr8_private.app_config in share row exclusive mode;
create temporary table tr8_planning_before on commit drop as select
 (select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p) projects,
 (select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t) tasks,
 (select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f) finances,
 (select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c) config;

-- Composite references ensure that an edge cannot cross workspace boundaries.
-- This redundant unique key adds no base-table columns or row changes.
alter table public.tr8_workspace_tasks add constraint tr8_tasks_workspace_id_unique unique(workspace_id,id);
create table tr8_private.task_dependencies (
 id uuid primary key,
 workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
 task_id uuid not null,
 blocker_task_id uuid not null,
 version integer not null default 1 check(version=1),
 created_at timestamptz not null default clock_timestamp(),
 check(task_id<>blocker_task_id),
 unique(workspace_id,task_id,blocker_task_id),
 foreign key(workspace_id,task_id) references public.tr8_workspace_tasks(workspace_id,id) on delete cascade,
 foreign key(workspace_id,blocker_task_id) references public.tr8_workspace_tasks(workspace_id,id) on delete cascade
);
create index tr8_dependencies_blocker on tr8_private.task_dependencies(workspace_id,blocker_task_id,task_id);

create table tr8_private.project_milestones (
 id uuid primary key,
 workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
 project_id uuid not null,
 name text not null check(name=btrim(name) and length(name) between 1 and 120),
 date date not null check(date between date '0001-01-01' and date '9999-12-31'),
 completed boolean not null default false,
 version integer not null default 1 check(version between 1 and 999999999),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 foreign key(workspace_id,project_id) references public.tr8_workspace_projects(workspace_id,id) on delete cascade
);
create index tr8_milestones_project_date on tr8_private.project_milestones(workspace_id,project_id,date,id);

-- Bounded create receipts retain only identifiers and a digest, never user text.
-- They survive result deletion so a retried create cannot resurrect that result.
create table tr8_private.planning_receipts (
 owner_id uuid not null references tr8_private.app_users(user_id) on delete cascade,
 workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
 request_id uuid not null,
 action text not null check(action in ('add_dependency','create_milestone')),
 payload_hash text not null check(payload_hash~'^[0-9a-f]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,workspace_id,request_id)
);
create index tr8_planning_receipts_workspace on tr8_private.planning_receipts(workspace_id);
create index tr8_planning_receipts_retention on tr8_private.planning_receipts(owner_id,workspace_id,created_at desc,request_id desc);
alter table tr8_private.task_dependencies enable row level security;
alter table tr8_private.project_milestones enable row level security;
alter table tr8_private.planning_receipts enable row level security;
revoke all on tr8_private.task_dependencies,tr8_private.project_milestones,tr8_private.planning_receipts
 from public,anon,authenticated,service_role;

create function tr8_private.planning_id(v jsonb) returns uuid
language plpgsql immutable security invoker set search_path='' as $$
begin
 if v is null or jsonb_typeof(v)<>'string' or v#>>'{}'!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 then raise exception using errcode='22023',message='Invalid planning identifier';end if;
 return (v#>>'{}')::uuid;
end;$$;
create function tr8_private.planning_version(v jsonb) returns integer
language plpgsql immutable security invoker set search_path='' as $$
begin
 if v is null or jsonb_typeof(v)<>'number' or v::text!~'^[1-9][0-9]{0,8}$'
 then raise exception using errcode='22023',message='Expected planning version required';end if;
 return v::text::integer;
end;$$;
create function tr8_private.planning_milestone_input(i jsonb) returns void
language plpgsql immutable security invoker set search_path='' as $$
declare d date;
begin
 perform tr8_private.productivity_keys(i,array['name','date','completed']);
 if jsonb_typeof(i->'name')<>'string' or i->>'name'<>btrim(i->>'name') or length(i->>'name') not between 1 and 120
  or jsonb_typeof(i->'date')<>'string' or i->>'date'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  or jsonb_typeof(i->'completed')<>'boolean' then raise exception using errcode='22023',message='Invalid milestone fields';end if;
 begin d:=(i->>'date')::date;exception when datetime_field_overflow or invalid_datetime_format then
  raise exception using errcode='22023',message='Invalid milestone date';end;
 if d<date '0001-01-01' or d>date '9999-12-31' or to_char(d,'YYYY-MM-DD')<>i->>'date'
 then raise exception using errcode='22023',message='Invalid milestone date';end if;
end;$$;

-- Lock ordering agrees with work_management: workspace authorization, planning
-- graph, projects ordered by UUID, then tasks ordered by UUID. A concurrent move
-- cannot substitute an unreadable project after the permission check.
create function tr8_private.planning_lock_tasks(w uuid,s uuid,b uuid,p_write boolean) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare sp uuid;bp uuid;current_sp uuid;current_bp uuid;archived timestamptz;
begin
 select project_id into sp from public.tr8_workspace_tasks where workspace_id=w and id=s;
 select project_id into bp from public.tr8_workspace_tasks where workspace_id=w and id=b;
 if sp is null or bp is null then raise exception using errcode='PT404',message='Resource unavailable';end if;
 perform tr8_private.v2_require_project(w,sp,case when p_write then 'task.edit' else 'task.read' end,p_write);
 perform tr8_private.v2_require_project(w,bp,'task.read',false);
 perform 1 from public.tr8_workspace_projects where workspace_id=w and id in(sp,bp) order by id for share;
 perform 1 from public.tr8_workspace_tasks where workspace_id=w and id in(s,b) order by id for share;
 select project_id,archived_at into current_sp,archived from public.tr8_workspace_tasks where workspace_id=w and id=s;
 select project_id into current_bp from public.tr8_workspace_tasks where workspace_id=w and id=b;
 if current_sp is distinct from sp or current_bp is distinct from bp
 then raise exception using errcode='PT409',message='A task moved. Reload before changing its dependencies';end if;
 if p_write and (archived is not null or exists(select 1 from public.tr8_workspace_projects where workspace_id=w and id=sp and archived_at is not null))
 then raise exception using errcode='55000',message='Restore the archived task or project before editing dependencies';end if;
end;$$;
create function tr8_private.planning_lock_project(w uuid,p uuid,p_write boolean) returns void
language plpgsql volatile security invoker set search_path='' as $$
declare r public.tr8_workspace_projects;
begin
 perform tr8_private.v2_require_project(w,p,case when p_write then 'project.edit' else 'project.read' end,p_write);
 select * into r from public.tr8_workspace_projects where workspace_id=w and id=p for share;
 if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
 if p_write and r.archived_at is not null then raise exception using errcode='55000',message='Restore the archived project before editing milestones';end if;
end;$$;

create function tr8_private.planning(w uuid,a text,i jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_variable
declare
 actor uuid:=auth.uid();rid uuid;s uuid;b uuid;p uuid;v integer;sv integer;bv integer;h text;outcome jsonb;
 d tr8_private.task_dependencies;m tr8_private.project_milestones;r tr8_private.planning_receipts;
begin
 perform tr8_private.v7_require_browser_session();
 perform tr8_private.v2_require_workspace(w,'project.read');
 if a is null or a<>all(array['load','add_dependency','remove_dependency','create_milestone','update_milestone','delete_milestone'])
 then raise exception using errcode='22023',message='Unknown planning action';end if;
 if i is null or jsonb_typeof(i)<>'object' or octet_length(i::text)>8000
 then raise exception using errcode='22023',message='Invalid planning input';end if;
 if a='load' then
  perform tr8_private.productivity_keys(i,array[]::text[]);
  -- Both endpoints must be readable; hidden edges remain in the cycle check.
  -- Archived tasks/projects stay readable here; each view chooses its scope.
  return jsonb_build_object('dependencies',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at,q.id)
   from tr8_private.task_dependencies q
   join public.tr8_workspace_tasks t on t.workspace_id=q.workspace_id and t.id=q.task_id
   join public.tr8_workspace_tasks bt on bt.workspace_id=q.workspace_id and bt.id=q.blocker_task_id
   where q.workspace_id=w and tr8_private.v2_has_permission(w,'task.read')
    and tr8_private.v2_can_read_project(w,t.project_id) and tr8_private.v2_can_read_project(w,bt.project_id)),'[]'::jsonb),
   'milestones',coalesce((select jsonb_agg(to_jsonb(q) order by q.date,q.id) from tr8_private.project_milestones q
    where q.workspace_id=w and tr8_private.v2_can_read_project(w,q.project_id)),'[]'::jsonb));
 end if;
 if a='add_dependency' then
  perform tr8_private.productivity_keys(i,array['id','task_id','task_version','blocker_task_id','blocker_version']);
  s:=tr8_private.planning_id(i->'task_id');b:=tr8_private.planning_id(i->'blocker_task_id');
  sv:=tr8_private.planning_version(i->'task_version');bv:=tr8_private.planning_version(i->'blocker_version');
  if s=b then raise exception using errcode='22023',message='A task cannot depend on itself';end if;
 elsif a='create_milestone' then
  perform tr8_private.productivity_keys(i,array['id','project_id','input']);
  p:=tr8_private.planning_id(i->'project_id');perform tr8_private.planning_milestone_input(i->'input');
 elsif a='update_milestone' then
  perform tr8_private.productivity_keys(i,array['id','version','input']);
  v:=tr8_private.planning_version(i->'version');perform tr8_private.planning_milestone_input(i->'input');
 else
  perform tr8_private.productivity_keys(i,array['id','version']);v:=tr8_private.planning_version(i->'version');
 end if;
 rid:=tr8_private.planning_id(i->'id');
 -- This is workspace-wide (not actor-wide): two actors cannot concurrently
 -- insert individually acyclic edges that together form a cycle or exceed caps.
 perform pg_advisory_xact_lock(hashtextextended('tr8-planning:'||w::text,0));
 if a in('add_dependency','create_milestone') then
  h:=encode(extensions.digest(convert_to(jsonb_build_object('action',a,'input',i)::text,'UTF8'),'sha256'),'hex');
  select * into r from tr8_private.planning_receipts where owner_id=actor and workspace_id=w and request_id=rid;
  if found then
   if r.action<>a or r.payload_hash<>h then raise exception using errcode='PT409',message='Request identifier reused with different planning data';end if;
   if a='add_dependency' then
    select * into d from tr8_private.task_dependencies where workspace_id=w and id=rid;
    if not found then raise exception using errcode='PT409',message='The dependency no longer exists';end if;
    perform tr8_private.planning_lock_tasks(w,d.task_id,d.blocker_task_id,false);return to_jsonb(d);
   else
    select * into m from tr8_private.project_milestones where workspace_id=w and id=rid;
    if not found then raise exception using errcode='PT409',message='The milestone no longer exists';end if;
    perform tr8_private.planning_lock_project(w,m.project_id,false);return to_jsonb(m);
   end if;
  end if;
 end if;
 if a='add_dependency' then
  perform tr8_private.planning_lock_tasks(w,s,b,true);
  if (select version from public.tr8_workspace_tasks where workspace_id=w and id=s)<>sv
   or (select version from public.tr8_workspace_tasks where workspace_id=w and id=b)<>bv
  then raise exception using errcode='PT409',message='A task changed. Reload before adding its dependency';end if;
  if exists(select 1 from tr8_private.task_dependencies where id=rid)
  then raise exception using errcode='PT409',message='The request identifier is unavailable';end if;
  if exists(select 1 from tr8_private.task_dependencies where workspace_id=w and task_id=s and blocker_task_id=b)
  then raise exception using errcode='23505',message='This dependency already exists';end if;
  if exists(with recursive reached(id) as (
    select b union select q.blocker_task_id from tr8_private.task_dependencies q join reached x on q.task_id=x.id where q.workspace_id=w
   ) select 1 from reached where id=s)
  then raise exception using errcode='22023',message='This dependency would create a cycle';end if;
  if (select count(*) from tr8_private.task_dependencies where workspace_id=w)>=1000
  then raise exception using errcode='22023',message='This workspace has reached its dependency limit';end if;
  insert into tr8_private.task_dependencies(id,workspace_id,task_id,blocker_task_id) values(rid,w,s,b) returning * into d;
  outcome:=to_jsonb(d);
 elsif a='remove_dependency' then
  select * into d from tr8_private.task_dependencies where workspace_id=w and id=rid;
  if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
  perform tr8_private.planning_lock_tasks(w,d.task_id,d.blocker_task_id,true);
  delete from tr8_private.task_dependencies where workspace_id=w and id=rid and version=v returning * into d;
  if not found then raise exception using errcode='PT409',message='The dependency changed. Reload before deleting';end if;
  return jsonb_build_object('id',rid,'deleted',true);
 elsif a='create_milestone' then
  perform tr8_private.planning_lock_project(w,p,true);
  if exists(select 1 from tr8_private.project_milestones where id=rid)
  then raise exception using errcode='PT409',message='The request identifier is unavailable';end if;
  if (select count(*) from tr8_private.project_milestones where workspace_id=w)>=200
   or (select count(*) from tr8_private.project_milestones where workspace_id=w and project_id=p)>=50
  then raise exception using errcode='22023',message='The milestone limit has been reached';end if;
  insert into tr8_private.project_milestones(id,workspace_id,project_id,name,date,completed)
  values(rid,w,p,i->'input'->>'name',(i->'input'->>'date')::date,(i->'input'->>'completed')::boolean) returning * into m;
  outcome:=to_jsonb(m);
 else
  select * into m from tr8_private.project_milestones where workspace_id=w and id=rid;
  if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
  perform tr8_private.planning_lock_project(w,m.project_id,true);
  if a='update_milestone' then
   update tr8_private.project_milestones set name=i->'input'->>'name',date=(i->'input'->>'date')::date,
    completed=(i->'input'->>'completed')::boolean,version=version+1,updated_at=clock_timestamp()
   where workspace_id=w and id=rid and version=v and version<999999999 returning * into m;
   if not found then raise exception using errcode='PT409',message='The milestone changed. Reload before saving';end if;
   return to_jsonb(m);
  else
   delete from tr8_private.project_milestones where workspace_id=w and id=rid and version=v returning * into m;
   if not found then raise exception using errcode='PT409',message='The milestone changed. Reload before deleting';end if;
   return jsonb_build_object('id',rid,'deleted',true);
  end if;
 end if;
 insert into tr8_private.planning_receipts(owner_id,workspace_id,request_id,action,payload_hash) values(actor,w,rid,a,h);
 delete from tr8_private.planning_receipts q where q.owner_id=actor and q.workspace_id=w and q.request_id in(
  select x.request_id from tr8_private.planning_receipts x where x.owner_id=actor and x.workspace_id=w order by x.created_at desc,x.request_id desc offset 1000);
 return outcome;
end;$$;

create function public.tr8_v2_planning(p_workspace_id uuid,p_action text,p_input jsonb default '{}') returns jsonb
language sql volatile security invoker set search_path='' as $$select tr8_private.planning(p_workspace_id,p_action,p_input);$$;
revoke all on function tr8_private.planning_id(jsonb),tr8_private.planning_version(jsonb),tr8_private.planning_milestone_input(jsonb),
 tr8_private.planning_lock_tasks(uuid,uuid,uuid,boolean),tr8_private.planning_lock_project(uuid,uuid,boolean),
 tr8_private.planning(uuid,text,jsonb),public.tr8_v2_planning(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function tr8_private.planning(uuid,text,jsonb),public.tr8_v2_planning(uuid,text,jsonb) to authenticated;

do $$declare before_row record;begin
 select * into strict before_row from tr8_planning_before;
 if before_row.projects is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p)
  or before_row.tasks is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t)
  or before_row.finances is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f)
  or before_row.config is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c)
  or exists(select 1 from tr8_private.task_dependencies) or exists(select 1 from tr8_private.project_milestones)
  or exists(select 1 from tr8_private.planning_receipts)
 then raise exception 'Planning stage 5 unexpectedly changed existing data';end if;
end;$$;
notify pgrst,'reload schema';
commit;
