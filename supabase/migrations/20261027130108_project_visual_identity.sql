-- Visual parity stage 1: preserve all content, authorization and versions.
-- Existing projects keep the same presentation with a folder icon by default.
begin;
lock table public.tr8_workspace_projects in share row exclusive mode;
create temporary table tr8_visual_identity_before on commit drop as
select
  'public.tr8_workspace_projects'::regclass::oid as project_oid,
  (select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p) as projects,
  (select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t) as tasks,
  (select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c) as app_config;

alter table public.tr8_workspace_projects
  add column icon text not null default 'folder',
  add constraint tr8_project_icon_valid check (icon in (
    'globe','smartphone','megaphone','rocket','component','building-2','layout-grid','palette',
    'code','briefcase','target','layers','zap','heart','folder','sparkles'
  ));
comment on column public.tr8_workspace_projects.icon is 'Allowlisted presentation icon inherited from the original Gr8r Studio design; never an SVG, HTML or remote URL.';

-- Keep the original six-argument create unchanged for existing clients and MCP.
-- This atomic variant includes the icon in insert and exact request replay.
create function tr8_private.v2_create_project_with_icon(
  p_workspace_id uuid,p_id uuid,p_name text,p_description text,p_color text,p_status text,p_icon text
) returns public.tr8_workspace_projects language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.tr8_workspace_projects; v_member uuid;
begin
  perform tr8_private.v2_require_workspace(p_workspace_id, 'project.create');
  if not tr8_private.v2_has_permission(p_workspace_id, 'project.read') then
    raise exception using errcode = 'PT404', message = 'Resource unavailable';
  end if;
  if p_id is null or p_name is null or p_description is null or p_color is null or p_status is null
    or p_icon is null or p_icon <> all(array[
      'globe','smartphone','megaphone','rocket','component','building-2','layout-grid','palette',
      'code','briefcase','target','layers','zap','heart','folder','sparkles'
    ]) then
    raise exception using errcode = '22023', message = 'Valid project fields and icon are required';
  end if;
  insert into public.tr8_workspace_projects(id,workspace_id,owner_id,name,description,color,status,icon)
    values(p_id,p_workspace_id,auth.uid(),btrim(p_name),p_description,p_color,p_status,p_icon)
    on conflict(id) do nothing returning * into v_row;
  if found then
    select m.id into v_member from tr8_private.workspace_members m
      where m.workspace_id=p_workspace_id and m.user_id=auth.uid() and m.status='active';
    if v_member is null then raise exception using errcode='PT404',message='Resource unavailable'; end if;
    insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level)
      values(p_workspace_id,p_id,v_member,'write');
    insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
      values(p_workspace_id,p_id,auth.uid(),'project.created',p_id);
    return v_row;
  end if;
  select * into v_row from public.tr8_workspace_projects p where p.id=p_id and p.workspace_id=p_workspace_id;
  if not found or not tr8_private.v2_can_read_project(p_workspace_id,p_id) then
    raise exception using errcode='PT409',message='The request identifier is unavailable';
  end if;
  if v_row.owner_id <> auth.uid() or row(v_row.name,v_row.description,v_row.color,v_row.status,v_row.icon)
    is distinct from row(btrim(p_name),p_description,p_color,p_status,p_icon) then
    raise exception using errcode='PT409',message='The request identifier was already used with different project data';
  end if;
  return v_row;
end;
$$;

create or replace function tr8_private.v2_update_project(p_workspace_id uuid,p_id uuid,p_version integer,p_patch jsonb)
returns public.tr8_workspace_projects language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.tr8_workspace_projects; v_key text; v_type text;
begin
  if p_id is null or p_version is null or p_version < 1 or p_patch is null
    or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception using errcode='22023',message='A version and a nonempty project patch are required';
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key <> all(array['name','description','color','status','archived_at','icon']) then
      raise exception using errcode='22023',message='Unknown or server-managed project field';
    end if;
    v_type:=jsonb_typeof(p_patch->v_key);
    if v_type <> 'string' and not(v_key='archived_at' and v_type='null') then
      raise exception using errcode='22023',message='Invalid project field type';
    end if;
  end loop;
  if p_patch ? 'icon' and (p_patch->>'icon') <> all(array[
    'globe','smartphone','megaphone','rocket','component','building-2','layout-grid','palette',
    'code','briefcase','target','layers','zap','heart','folder','sparkles'
  ]) then
    raise exception using errcode='22023',message='Invalid project icon';
  end if;
  -- Both capabilities remain necessary when archival and content change together.
  perform tr8_private.v2_require_project(p_workspace_id,p_id,'project.read',false);
  if p_patch ? 'archived_at' then
    perform tr8_private.v2_require_project(p_workspace_id,p_id,'project.archive',true);
  end if;
  if (p_patch-'archived_at') <> '{}'::jsonb then
    perform tr8_private.v2_require_project(p_workspace_id,p_id,'project.edit',true);
  end if;
  select * into v_row from public.tr8_workspace_projects p where p.workspace_id=p_workspace_id and p.id=p_id for update;
  if v_row.version <> p_version then
    raise exception using errcode='PT409',message='This project changed. Reload it before saving';
  end if;
  update public.tr8_workspace_projects p set
    name=case when p_patch ? 'name' then btrim(p_patch->>'name') else p.name end,
    description=case when p_patch ? 'description' then p_patch->>'description' else p.description end,
    color=case when p_patch ? 'color' then p_patch->>'color' else p.color end,
    status=case when p_patch ? 'status' then p_patch->>'status' else p.status end,
    icon=case when p_patch ? 'icon' then p_patch->>'icon' else p.icon end,
    archived_at=case when p_patch ? 'archived_at' then (p_patch->>'archived_at')::timestamptz else p.archived_at end
    where p.workspace_id=p_workspace_id and p.id=p_id returning * into v_row;
  insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
    values(p_workspace_id,p_id,auth.uid(),'project.updated',p_id);
  return v_row;
end;
$$;

create function public.tr8_v2_create_project_with_icon(
  p_workspace_id uuid,p_id uuid,p_name text,p_description text,p_color text,p_status text,p_icon text
) returns public.tr8_workspace_projects language sql volatile security invoker set search_path = ''
  as $$ select tr8_private.v2_create_project_with_icon(p_workspace_id,p_id,p_name,p_description,p_color,p_status,p_icon); $$;

revoke all on function tr8_private.v2_create_project_with_icon(uuid,uuid,text,text,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.tr8_v2_create_project_with_icon(uuid,uuid,text,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function tr8_private.v2_create_project_with_icon(uuid,uuid,text,text,text,text,text) to authenticated;
grant execute on function public.tr8_v2_create_project_with_icon(uuid,uuid,text,text,text,text,text) to authenticated;

do $$declare s record;begin
  select * into s from tr8_visual_identity_before;
  if s.project_oid <> 'public.tr8_workspace_projects'::regclass::oid
    or s.projects is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(p)-'icon' order by id)::text,'')) from public.tr8_workspace_projects p)
    or s.tasks is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t)
    or s.app_config is distinct from (select md5(coalesce(jsonb_agg(to_jsonb(c))::text,'')) from tr8_private.app_config c)
    or exists(select 1 from public.tr8_workspace_projects where icon <> 'folder')
    or not (select relrowsecurity from pg_class where oid='public.tr8_workspace_projects'::regclass)
  then raise exception 'Visual identity migration changed existing data, access flags or RLS'; end if;
end;$$;
notify pgrst,'reload schema';
commit;
