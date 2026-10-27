-- Demo parity stage 3: private personal preferences and atomic manual ordering.
-- Existing rows, permissions, API v2 and provider identity remain unchanged.
begin;
lock table public.tr8_workspace_projects,public.tr8_workspace_tasks,tr8_private.account_finances,tr8_private.app_config in share mode;
create temporary table tr8_productivity_before on commit drop as select
  (select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p) projects,
  (select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t) tasks,
  (select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f) finances,
  (select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c) config;

create table tr8_private.productivity_favorites (
  owner_id uuid not null references tr8_private.app_users(user_id) on delete cascade,
  workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
  kind text not null check(kind in ('project','task')),
  id uuid not null,
  project_id uuid not null,
  task_id uuid references public.tr8_workspace_tasks(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key(owner_id,workspace_id,kind,id),
  foreign key(workspace_id,project_id) references public.tr8_workspace_projects(workspace_id,id) on delete cascade,
  check((kind='project' and id=project_id and task_id is null) or (kind='task' and task_id is not null and task_id=id))
);
create index tr8_productivity_favorites_project on tr8_private.productivity_favorites(workspace_id,project_id);
create index tr8_productivity_favorites_task on tr8_private.productivity_favorites(task_id) where task_id is not null;

create table tr8_private.productivity_views (
  id uuid primary key,
  owner_id uuid not null references tr8_private.app_users(user_id) on delete cascade,
  workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
  context text not null check(context in ('tasks','mine','project')),
  project_id uuid,
  name text not null check(length(btrim(name)) between 1 and 80),
  config jsonb not null,
  version integer not null default 1 check(version>0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_id,project_id) references public.tr8_workspace_projects(workspace_id,id) on delete cascade,
  check((context='project')=(project_id is not null))
);
create index tr8_productivity_views_owner on tr8_private.productivity_views(owner_id,workspace_id,created_at,id);
create index tr8_productivity_views_project on tr8_private.productivity_views(workspace_id,project_id) where project_id is not null;

create table tr8_private.productivity_reorders (
  owner_id uuid not null references tr8_private.app_users(user_id) on delete cascade,
  workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
  project_id uuid not null,
  request_id uuid not null,
  payload_hash text not null check(payload_hash~'^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(owner_id,workspace_id,project_id,request_id),
  foreign key(workspace_id,project_id) references public.tr8_workspace_projects(workspace_id,id) on delete cascade
);
create index tr8_productivity_reorder_retention on tr8_private.productivity_reorders(owner_id,workspace_id,created_at desc);
create index tr8_productivity_reorder_project on tr8_private.productivity_reorders(workspace_id,project_id);

alter table tr8_private.productivity_favorites enable row level security;
alter table tr8_private.productivity_views enable row level security;
alter table tr8_private.productivity_reorders enable row level security;
revoke all on tr8_private.productivity_favorites,tr8_private.productivity_views,tr8_private.productivity_reorders from public,anon,authenticated,service_role;

create function tr8_private.productivity_keys(p_value jsonb,p_keys text[]) returns void
language plpgsql immutable security invoker set search_path='' as $$
begin
  if p_value is null or jsonb_typeof(p_value)<>'object' then raise exception using errcode='22023',message='Invalid productivity input';end if;
  if (select count(*) from jsonb_object_keys(p_value))<>cardinality(p_keys)
    or exists(select 1 from jsonb_object_keys(p_value) k where k<>all(p_keys)) then
    raise exception using errcode='22023',message='Unknown or missing productivity fields';end if;
end;$$;

create function tr8_private.productivity_array(p_value jsonb,p_choices text[],p_limit integer,p_uuid boolean default false,p_none boolean default false)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare v jsonb;t text;
begin
  if p_value is null or jsonb_typeof(p_value)<>'array' then return false;end if;
  if jsonb_array_length(p_value)>p_limit or (select count(distinct value) from jsonb_array_elements(p_value))<>jsonb_array_length(p_value) then return false;end if;
  for v in select value from jsonb_array_elements(p_value) loop
    if jsonb_typeof(v)<>'string' then return false;end if;t:=v#>>'{}';
    if p_uuid then
      if not(p_none and t='none') and t!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false;end if;
    elsif not(t=any(p_choices)) then return false;end if;
  end loop;return true;
end;$$;

create function tr8_private.productivity_validate_config(c jsonb) returns void
language plpgsql immutable security invoker set search_path='' as $$
begin
  perform tr8_private.productivity_keys(c,array['schemaVersion','view','query','statuses','priorities','projectIds','assigneeIds','due','sort','direction','group','columns','favoritesOnly']);
  if octet_length(c::text)>20000 or c->'schemaVersion'<>'1'::jsonb
    or jsonb_typeof(c->'schemaVersion')<>'number' or c->>'view'<>all(array['list','table','board'])
    or jsonb_typeof(c->'query')<>'string' or length(c->>'query')>500
    or not tr8_private.productivity_array(c->'statuses',array['backlog','todo','progress','review','done'],5)
    or not tr8_private.productivity_array(c->'priorities',array['none','low','medium','high','urgent'],5)
    or not tr8_private.productivity_array(c->'projectIds',null,100,true)
    or not tr8_private.productivity_array(c->'assigneeIds',null,100,true,true)
    or c->>'due'<>all(array['all','overdue','today','next7','undated'])
    or c->>'sort'<>all(array['manual','title','status','priority','due_date','created_at','updated_at'])
    or c->>'direction'<>all(array['asc','desc']) or c->>'group'<>all(array['none','status','project','priority','assignee'])
    or not tr8_private.productivity_array(c->'columns',array['project','status','priority','assignee','start_date','due_date'],6)
    or jsonb_typeof(c->'favoritesOnly')<>'boolean'
    or jsonb_typeof(c->'view')<>'string' or jsonb_typeof(c->'due')<>'string'
    or jsonb_typeof(c->'sort')<>'string' or jsonb_typeof(c->'direction')<>'string' or jsonb_typeof(c->'group')<>'string'
  then raise exception using errcode='22023',message='Invalid saved task view';end if;
end;$$;
alter table tr8_private.productivity_views add constraint tr8_productivity_config_object check(jsonb_typeof(config)='object' and octet_length(config::text)<=20000);

create function tr8_private.productivity_view_json(v tr8_private.productivity_views) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select to_jsonb(v)-'owner_id';
$$;

create function tr8_private.productivity(p_workspace_id uuid,p_action text,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  a uuid:=auth.uid(); target uuid; parent uuid; p public.tr8_workspace_projects; v tr8_private.productivity_views;
  item jsonb; old_hash text; new_hash text; response jsonb; target_version integer; n integer; row_data public.tr8_workspace_tasks;
begin
  perform tr8_private.v7_require_browser_session();
  perform tr8_private.v2_require_workspace(p_workspace_id,'project.read');
  -- Serialize a user's preference quota and idempotent creation without locking anyone else's account.
  perform pg_advisory_xact_lock(hashtextextended('tr8-productivity:'||a::text||':'||p_workspace_id::text,0));
  if p_action='load' then
    perform tr8_private.productivity_keys(p_input,array[]::text[]);
    return jsonb_build_object(
      'favorites',coalesce((select jsonb_agg(jsonb_build_object('kind',f.kind,'id',f.id,'project_id',f.project_id) order by f.created_at,f.id)
        from tr8_private.productivity_favorites f where f.owner_id=a and f.workspace_id=p_workspace_id
          and tr8_private.v2_can_read_project(p_workspace_id,f.project_id)
          and (f.kind='project' or (tr8_private.v2_has_permission(p_workspace_id,'task.read') and exists(
            select 1 from public.tr8_workspace_tasks t where t.id=f.task_id and t.workspace_id=f.workspace_id and t.project_id=f.project_id)))),'[]'::jsonb),
      'views',coalesce((select jsonb_agg(tr8_private.productivity_view_json(vw) order by vw.created_at,vw.id)
        from tr8_private.productivity_views vw where vw.owner_id=a and vw.workspace_id=p_workspace_id
          and (vw.project_id is null or tr8_private.v2_can_read_project(p_workspace_id,vw.project_id))),'[]'::jsonb));
  elsif p_action='set_favorite' then
    perform tr8_private.productivity_keys(p_input,array['kind','id','favorite']);
    if jsonb_typeof(p_input->'kind')<>'string' or p_input->>'kind'<>all(array['project','task'])
      or jsonb_typeof(p_input->'id')<>'string' or jsonb_typeof(p_input->'favorite')<>'boolean' then
      raise exception using errcode='22023',message='Invalid favorite';end if;
    target:=(p_input->>'id')::uuid;
    if p_input->>'kind'='project' then parent:=target;
    else select t.project_id into parent from public.tr8_workspace_tasks t where t.id=target and t.workspace_id=p_workspace_id;end if;
    perform tr8_private.v2_require_project(p_workspace_id,parent,case when p_input->>'kind'='task' then 'task.read' else 'project.read' end,false);
    perform 1 from public.tr8_workspace_projects where id=parent and workspace_id=p_workspace_id for share;
    if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
    if p_input->>'kind'='task' then
      perform 1 from public.tr8_workspace_tasks where id=target and workspace_id=p_workspace_id and project_id=parent for share;
      if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
    end if;
    if (p_input->>'favorite')::boolean then
      if not exists(select 1 from tr8_private.productivity_favorites where owner_id=a and workspace_id=p_workspace_id and kind=p_input->>'kind' and id=target)
        and (select count(*) from tr8_private.productivity_favorites where owner_id=a and workspace_id=p_workspace_id)>=1000 then
        raise exception using errcode='PT429',message='Favorite limit reached';end if;
      insert into tr8_private.productivity_favorites(owner_id,workspace_id,kind,id,project_id,task_id)
        values(a,p_workspace_id,p_input->>'kind',target,parent,case when p_input->>'kind'='task' then target end) on conflict do nothing;
    else delete from tr8_private.productivity_favorites where owner_id=a and workspace_id=p_workspace_id and kind=p_input->>'kind' and id=target;end if;
    return jsonb_build_object('kind',p_input->>'kind','id',target,'project_id',parent,'favorite',p_input->'favorite');
  elsif p_action='create_view' then
    perform tr8_private.productivity_keys(p_input,array['id','name','context','project_id','config']);
    if jsonb_typeof(p_input->'id')<>'string' or jsonb_typeof(p_input->'name')<>'string' or length(btrim(p_input->>'name')) not between 1 and 80
      or jsonb_typeof(p_input->'context')<>'string' or p_input->>'context'<>all(array['tasks','mine','project'])
      or not ((p_input->>'context'='project' and jsonb_typeof(p_input->'project_id')='string') or (p_input->>'context'<>'project' and p_input->'project_id'='null'::jsonb))
      then raise exception using errcode='22023',message='Invalid saved view context';end if;
    target:=(p_input->>'id')::uuid;parent:=(p_input->>'project_id')::uuid;
    perform tr8_private.productivity_validate_config(p_input->'config');
    if parent is not null then perform tr8_private.v2_require_project(p_workspace_id,parent,'project.read',false);
      perform 1 from public.tr8_workspace_projects where id=parent and workspace_id=p_workspace_id for share;
      if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;end if;
    select * into v from tr8_private.productivity_views where id=target;
    if found then
      if v.owner_id<>a or v.workspace_id<>p_workspace_id or row(v.name,v.context,v.project_id,v.config) is distinct from row(btrim(p_input->>'name'),p_input->>'context',parent,p_input->'config') then
        raise exception using errcode='PT409',message='The request identifier is unavailable';end if;
      return tr8_private.productivity_view_json(v);
    end if;
    if (select count(*) from tr8_private.productivity_views where owner_id=a and workspace_id=p_workspace_id)>=50 then
      raise exception using errcode='PT429',message='Saved view limit reached';end if;
    insert into tr8_private.productivity_views(id,owner_id,workspace_id,context,project_id,name,config)
      values(target,a,p_workspace_id,p_input->>'context',parent,btrim(p_input->>'name'),p_input->'config') returning * into v;
    return tr8_private.productivity_view_json(v);
  elsif p_action in ('update_view','delete_view') then
    perform tr8_private.productivity_keys(p_input,case when p_action='update_view' then array['id','version','name','config'] else array['id','version'] end);
    if jsonb_typeof(p_input->'id')<>'string' or jsonb_typeof(p_input->'version')<>'number' or (p_input->>'version')!~'^[1-9][0-9]{0,8}$' then
      raise exception using errcode='22023',message='A saved view version is required';end if;
    target:=(p_input->>'id')::uuid;target_version:=(p_input->>'version')::integer;
    select * into v from tr8_private.productivity_views where id=target and owner_id=a and workspace_id=p_workspace_id for update;
    if not found then raise exception using errcode='PT404',message='Saved view unavailable';end if;
    if v.project_id is not null then perform tr8_private.v2_require_project(p_workspace_id,v.project_id,'project.read',false);end if;
    if v.version<>target_version then raise exception using errcode='PT409',message='Saved view changed. Reload it';end if;
    if p_action='delete_view' then
      delete from tr8_private.productivity_views where id=target;
      return jsonb_build_object('id',target,'deleted',true);
    end if;
    if jsonb_typeof(p_input->'name')<>'string' or length(btrim(p_input->>'name')) not between 1 and 80 then raise exception using errcode='22023',message='Invalid saved view name';end if;
    perform tr8_private.productivity_validate_config(p_input->'config');
    update tr8_private.productivity_views set name=btrim(p_input->>'name'),config=p_input->'config',version=version+1,updated_at=clock_timestamp() where id=target returning * into v;
    return tr8_private.productivity_view_json(v);
  elsif p_action='reorder_tasks' then
    perform tr8_private.productivity_keys(p_input,array['project_id','request_id','items']);
    if jsonb_typeof(p_input->'items')<>'array' or jsonb_array_length(p_input->'items') not between 1 and 200
      or jsonb_typeof(p_input->'project_id')<>'string' or jsonb_typeof(p_input->'request_id')<>'string' then
      raise exception using errcode='22023',message='Reorder requires a complete project list of at most 200 tasks';end if;
    parent:=(p_input->>'project_id')::uuid;target:=(p_input->>'request_id')::uuid;
    perform tr8_private.v2_require_project(p_workspace_id,parent,'task.edit',true);
    select * into p from public.tr8_workspace_projects where id=parent and workspace_id=p_workspace_id for update;
    if p.archived_at is not null then raise exception using errcode='55000',message='Restore the project before reordering';end if;
    for item in select value from jsonb_array_elements(p_input->'items') loop
      perform tr8_private.productivity_keys(item,array['id','version','position']);
      if jsonb_typeof(item->'id')<>'string' or (item->>'id')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(item->'version')<>'number' or (item->>'version')!~'^[1-9][0-9]{0,8}$'
        or jsonb_typeof(item->'position')<>'number' or (item->>'position')!~'^[0-9]{1,16}$'
        or (item->>'position')::numeric>9007199254740991 then raise exception using errcode='22023',message='Invalid reorder item';end if;
    end loop;
    n:=jsonb_array_length(p_input->'items');
    if (select count(distinct value->>'id') from jsonb_array_elements(p_input->'items'))<>n
      or (select count(distinct (value->>'position')::bigint) from jsonb_array_elements(p_input->'items'))<>n then
      raise exception using errcode='22023',message='Reorder items must be distinct';end if;
    if (select count(*) from public.tr8_workspace_tasks where workspace_id=p_workspace_id and project_id=parent)<>n
      or exists(select 1 from jsonb_array_elements(p_input->'items') x where not exists(select 1 from public.tr8_workspace_tasks t where t.id=(x.value->>'id')::uuid and t.workspace_id=p_workspace_id and t.project_id=parent)) then
      raise exception using errcode='PT409',message='The project task list changed. Reload it';end if;
    perform 1 from public.tr8_workspace_tasks where workspace_id=p_workspace_id and project_id=parent order by id for update;
    new_hash:=encode(extensions.digest(convert_to((p_input->'items')::text,'UTF8'),'sha256'),'hex');
    select payload_hash into old_hash from tr8_private.productivity_reorders where owner_id=a and workspace_id=p_workspace_id and project_id=parent and request_id=target;
    if found then
      if old_hash<>new_hash then raise exception using errcode='PT409',message='The reorder request identifier was already used';end if;
    else
      if exists(select 1 from jsonb_array_elements(p_input->'items') x join public.tr8_workspace_tasks t on t.id=(x.value->>'id')::uuid where t.version<>(x.value->>'version')::integer) then
        raise exception using errcode='PT409',message='A task changed. Reload the project before reordering';end if;
      for item in select value from jsonb_array_elements(p_input->'items') order by value->>'id' loop
        select * into row_data from public.tr8_workspace_tasks where id=(item->>'id')::uuid;
        if row_data.position<>(item->>'position')::bigint then perform tr8_private.v2_update_task(p_workspace_id,row_data.id,row_data.version,jsonb_build_object('position',(item->>'position')::bigint));end if;
      end loop;
      insert into tr8_private.productivity_reorders(owner_id,workspace_id,project_id,request_id,payload_hash) values(a,p_workspace_id,parent,target,new_hash);
      delete from tr8_private.productivity_reorders where owner_id=a and workspace_id=p_workspace_id and (project_id,request_id) in
        (select project_id,request_id from tr8_private.productivity_reorders where owner_id=a and workspace_id=p_workspace_id order by created_at desc,request_id desc offset 1000);
    end if;
    select coalesce(jsonb_agg(to_jsonb(t) order by t.position,t.id),'[]'::jsonb) into response from public.tr8_workspace_tasks t where t.workspace_id=p_workspace_id and t.project_id=parent;
    return response;
  end if;
  raise exception using errcode='22023',message='Unknown productivity action';
end;$$;

create function public.tr8_v2_productivity(p_workspace_id uuid,p_action text,p_input jsonb default '{}'::jsonb)
returns jsonb language sql volatile security invoker set search_path='' as $$select tr8_private.productivity(p_workspace_id,p_action,p_input);$$;
revoke all on function tr8_private.productivity_keys(jsonb,text[]),tr8_private.productivity_array(jsonb,text[],integer,boolean,boolean),
  tr8_private.productivity_validate_config(jsonb),tr8_private.productivity_view_json(tr8_private.productivity_views),
  tr8_private.productivity(uuid,text,jsonb),public.tr8_v2_productivity(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function tr8_private.productivity(uuid,text,jsonb),public.tr8_v2_productivity(uuid,text,jsonb) to authenticated;

do $$declare b record;begin
  select * into b from tr8_productivity_before;
  if b.projects is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p)
    or b.tasks is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t)
    or b.finances is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(f) order by owner_id)::text,'')) from tr8_private.account_finances f)
    or b.config is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c)
  then raise exception 'Productivity migration changed existing content or configuration';end if;
end;$$;
notify pgrst,'reload schema';
commit;
