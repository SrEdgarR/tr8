-- Stage 2: live, additive team roles and explicit project access. All existing
-- v2 signatures remain callable; historical content, versions and the task
-- identity sequence must survive this additive migration unchanged.
lock table public.tr8_workspace_projects, public.tr8_workspace_tasks,
  tr8_private.workspace_authz_state, tr8_private.workspace_members,
  tr8_private.workspace_roles, tr8_private.role_permissions,
  tr8_private.member_roles, tr8_private.project_access,
  tr8_private.workspace_activity in access exclusive mode nowait;

create temporary table tr8_stage2_snapshot on commit drop as
select
  'public.tr8_workspace_projects'::regclass::oid as projects_oid,
  'public.tr8_workspace_tasks'::regclass::oid as tasks_oid,
  pg_get_serial_sequence('public.tr8_workspace_tasks','task_number')::regclass::oid as sequence_oid,
  (select md5(coalesce(string_agg(to_jsonb(p)::text,E'\n' order by id),'')) from public.tr8_workspace_projects p) as projects_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by id),'')) from public.tr8_workspace_tasks t) as tasks_hash,
  (select jsonb_build_object('last_value',s.last_value,'is_called',s.is_called) from public.tr8_tasks_task_number_seq s) as sequence_state,
  (select external_invites_enabled from tr8_private.app_config where singleton) as external_invites_enabled;

alter table public.tr8_workspace_tasks add column assignee_member_id uuid;
alter table public.tr8_workspace_tasks add constraint tr8_tasks_assignee_workspace_fk
  foreign key(workspace_id,assignee_member_id)
  references tr8_private.workspace_members(workspace_id,id) on delete restrict;
create index tr8_tasks_assignee on public.tr8_workspace_tasks(workspace_id,assignee_member_id,project_id,id)
  where assignee_member_id is not null;
alter table tr8_private.workspace_roles
  add column created_at timestamptz not null default statement_timestamp(),
  add column updated_at timestamptz not null default statement_timestamp();
alter table tr8_private.project_access
  add column created_at timestamptz not null default statement_timestamp(),
  add column updated_at timestamptz not null default statement_timestamp();
alter table tr8_private.workspace_activity add column affected_user_id uuid
  references tr8_private.app_users(user_id) on delete restrict;
create index tr8_activity_project_id on tr8_private.workspace_activity(workspace_id,project_id,id desc);

-- Arbitrary-user helpers never receive EXECUTE grants. Public wrappers derive
-- the caller from auth.uid(), use READ COMMITTED and authorize again after the
-- workspace serialization lock. UUIDs never act as authority.
create function tr8_private.v2_is_workspace_owner(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select tr8_private.v2_actor_enabled() and exists(select 1 from tr8_private.workspaces w
    where w.id=p_workspace_id and w.owner_id=(select auth.uid()));
$$;
create function tr8_private.v2_project_readable_for(p_workspace_id uuid,p_project_id uuid,p_user_id uuid,p_tasks boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.tr8_workspace_projects p
    join tr8_private.workspaces w on w.id=p.workspace_id
    join tr8_private.workspace_members m on m.workspace_id=w.id and m.user_id=p_user_id and m.status='active'
    where p.workspace_id=p_workspace_id and p.id=p_project_id
      and tr8_private.v2_user_live(p_user_id)
      and exists(select 1 from tr8_private.app_users a where a.user_id=p_user_id and a.enabled)
      and (w.owner_id=p_user_id or (w.kind='team'
        and 'project.read'=any(tr8_private.v2_permissions_for(w.id,p_user_id))
        and (not p_tasks or 'task.read'=any(tr8_private.v2_permissions_for(w.id,p_user_id)))
        and exists(select 1 from tr8_private.project_access a
          where a.workspace_id=w.id and a.project_id=p.id and a.member_id=m.id))));
$$;
create function tr8_private.v2_assignee_eligible(p_workspace_id uuid,p_project_id uuid,p_member_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_member_id is not null and exists(select 1 from tr8_private.workspace_members m
    where m.workspace_id=p_workspace_id and m.id=p_member_id and m.status='active'
      and tr8_private.v2_project_readable_for(p_workspace_id,p_project_id,m.user_id,true));
$$;
create function tr8_private.v2_require_team_management(p_workspace_id uuid,p_permission text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform tr8_private.v2_require_actor();
  perform tr8_private.v2_lock_workspace(p_workspace_id,true);
  perform tr8_private.v2_require_actor();
  if not exists(select 1 from tr8_private.workspaces w where w.id=p_workspace_id and w.kind='team')
    or not tr8_private.v2_has_permission(p_workspace_id,p_permission) then
    raise exception using errcode='PT404',message='Resource unavailable';
  end if;
end;
$$;
create function tr8_private.v2_validate_permissions(p_permissions text[])
returns text[] language plpgsql stable security definer set search_path = '' as $$
declare v_result text[];
begin
  if p_permissions is null or cardinality(p_permissions)>18
    or array_position(p_permissions,null) is not null
    or exists(select 1 from unnest(p_permissions) v where not exists(
      select 1 from tr8_private.permission_catalog c where c.permission=v)) then
    raise exception using errcode='22023',message='Invalid permission set';
  end if;
  select coalesce(array_agg(distinct v order by v),array[]::text[]) into v_result from unnest(p_permissions) v;
  return v_result;
end;
$$;
create function tr8_private.v2_role_permissions(p_workspace_id uuid,p_role_id uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(r.permission order by r.permission),array[]::text[])
    from tr8_private.role_permissions r where r.workspace_id=p_workspace_id and r.role_id=p_role_id;
$$;
create function tr8_private.v2_role_json(p_workspace_id uuid,p_role_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',r.id,'workspace_id',r.workspace_id,'name',r.name,
    'template_key',r.template_key,'version',r.version,'permissions',tr8_private.v2_role_permissions(r.workspace_id,r.id),
    'created_at',r.created_at,'updated_at',r.updated_at)
    from tr8_private.workspace_roles r where r.workspace_id=p_workspace_id and r.id=p_role_id;
$$;
create function tr8_private.v2_can_manage_member(p_workspace_id uuid,p_member_id uuid,p_permission text)
returns boolean language sql stable security definer set search_path = '' as $$
  select tr8_private.v2_has_permission(p_workspace_id,p_permission) and exists(
    select 1 from tr8_private.workspace_members m join tr8_private.workspaces w on w.id=m.workspace_id
    where m.workspace_id=p_workspace_id and m.id=p_member_id and m.status='active' and w.kind='team'
      and m.user_id<>w.owner_id and (w.owner_id=(select auth.uid())
        or tr8_private.v2_permissions_for(w.id,m.user_id)<@tr8_private.v2_permissions_for(w.id,(select auth.uid()))));
$$;
create function tr8_private.v2_member_json(p_workspace_id uuid,p_member_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',m.id,'user_id',m.user_id,'display_name',a.display_name,
    'status',m.status,'version',m.version,'is_owner',w.owner_id=m.user_id,
    -- member.read exposes a minimal directory. Reading another member's roles
    -- and effective permissions is a separate, live role.read capability.
    'permissions',case when tr8_private.v2_has_permission(w.id,'role.read')
      then tr8_private.v2_permissions_for(w.id,m.user_id) else array[]::text[] end,
    'can_manage_roles',tr8_private.v2_can_manage_member(w.id,m.id,'role.assign'),
    'can_remove',tr8_private.v2_can_manage_member(w.id,m.id,'member.remove'),
    'roles',case when tr8_private.v2_has_permission(w.id,'role.read') then coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'template_key',r.template_key)
      order by r.name,r.id) from tr8_private.member_roles mr join tr8_private.workspace_roles r
      on r.workspace_id=mr.workspace_id and r.id=mr.role_id
      where mr.workspace_id=m.workspace_id and mr.member_id=m.id),'[]'::jsonb) else '[]'::jsonb end)
    from tr8_private.workspace_members m join tr8_private.app_users a on a.user_id=m.user_id
    join tr8_private.workspaces w on w.id=m.workspace_id
    where m.workspace_id=p_workspace_id and m.id=p_member_id;
$$;

-- Cursors contain only list scope and the last UUID, never titles, counts or
-- authority. A cursor from another list/workspace/project is invalid input.
create function tr8_private.v2_list_cursor(p_kind text,p_workspace_id uuid,p_project_id uuid,p_id uuid)
returns text language sql immutable security invoker set search_path = '' as $$
  select replace(encode(convert_to(jsonb_build_object('kind',p_kind,'workspace',p_workspace_id,
    'project',p_project_id,'id',p_id)::text,'UTF8'),'base64'),E'\n','');
$$;
create function tr8_private.v2_parse_list_cursor(p_cursor text,p_kind text,p_workspace_id uuid,p_project_id uuid,p_limit integer)
returns uuid language plpgsql immutable security invoker set search_path = '' as $$
declare v_data jsonb; v_id uuid;
begin
  if p_limit is null or p_limit<1 or p_limit>250 then
    raise exception using errcode='22023',message='List limit must be between 1 and 250';
  end if;
  if p_cursor is null then return null; end if;
  if length(p_cursor)>1024 then raise exception using errcode='22023',message='Invalid list cursor'; end if;
  begin
    v_data:=convert_from(decode(p_cursor,'base64'),'UTF8')::jsonb;
    v_id:=(v_data->>'id')::uuid;
    if jsonb_typeof(v_data)<>'object' or v_id is null
      or v_data->>'kind' is distinct from p_kind
      or (v_data->>'workspace')::uuid is distinct from p_workspace_id
      or (v_data->>'project')::uuid is distinct from p_project_id
      or (select count(*) from jsonb_object_keys(v_data))<>4 then
      raise exception 'Invalid list cursor';
    end if;
  exception when others then
    raise exception using errcode='22023',message='Invalid list cursor';
  end;
  return v_id;
end;
$$;

-- The existing trigger still owns versions/timestamps. Its only archived-task
-- exception is removing an already ineligible assignee while every content and
-- historical field remains identical; no client-controlled GUC bypass exists.
create or replace function tr8_private.guard_task()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_archived timestamptz; v_cleanup boolean:=false;
begin
  if tg_op='INSERT' then
    new.created_at:=statement_timestamp(); new.updated_at:=new.created_at; new.version:=1;
  else
    if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
      or new.owner_id is distinct from old.owner_id or new.project_id is distinct from old.project_id
      or new.task_number is distinct from old.task_number or new.created_at is distinct from old.created_at
      or new.updated_at is distinct from old.updated_at or new.version is distinct from old.version then
      raise exception using errcode='22023',message='Server-managed task fields are immutable';
    end if;
    v_cleanup:=old.assignee_member_id is not null and new.assignee_member_id is null
      and (to_jsonb(new)-'assignee_member_id')=(to_jsonb(old)-'assignee_member_id')
      and not tr8_private.v2_assignee_eligible(old.workspace_id,old.project_id,old.assignee_member_id);
    new.version:=old.version+1; new.updated_at:=statement_timestamp();
  end if;
  select p.archived_at into v_archived from public.tr8_workspace_projects p
    where p.workspace_id=new.workspace_id and p.id=new.project_id for share;
  if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  if v_archived is not null and not v_cleanup then
    raise exception using errcode='PT409',message='Restore the archived project before editing its tasks';
  end if;
  if new.assignee_member_id is not null and not tr8_private.v2_assignee_eligible(new.workspace_id,new.project_id,new.assignee_member_id) then
    raise exception using errcode='22023',message='The assignee must be an active member able to read this project and its tasks';
  end if;
  new.title:=btrim(new.title);
  return new;
end;
$$;
create function tr8_private.v2_cleanup_assignments(p_workspace_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_task record;
begin
  -- Caller already holds the exclusive workspace lock. Follow project -> task
  -- order for every affected row, including archived projects, before writing.
  perform 1 from public.tr8_workspace_projects p where p.workspace_id=p_workspace_id
    and exists(select 1 from public.tr8_workspace_tasks t where t.workspace_id=p.workspace_id and t.project_id=p.id
      and t.assignee_member_id is not null and not tr8_private.v2_assignee_eligible(t.workspace_id,t.project_id,t.assignee_member_id))
    order by p.id for update;
  for v_task in select t.id,t.project_id,m.user_id from public.tr8_workspace_tasks t
    join tr8_private.workspace_members m on m.workspace_id=t.workspace_id and m.id=t.assignee_member_id
    where t.workspace_id=p_workspace_id and t.assignee_member_id is not null
      and not tr8_private.v2_assignee_eligible(t.workspace_id,t.project_id,t.assignee_member_id)
    order by t.id for update of t loop
    update public.tr8_workspace_tasks set assignee_member_id=null where id=v_task.id and workspace_id=p_workspace_id;
    insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id,affected_user_id)
      values(p_workspace_id,v_task.project_id,auth.uid(),'task.unassigned',v_task.id,v_task.user_id);
  end loop;
end;
$$;

create function tr8_private.v2_list_roles(p_workspace_id uuid,p_cursor text default null,p_limit integer default 100)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_after uuid; v_ids uuid[]; v_items jsonb; v_next text;
begin
  perform tr8_private.v2_require_workspace(p_workspace_id,'role.read');
  v_after:=tr8_private.v2_parse_list_cursor(p_cursor,'roles',p_workspace_id,null,p_limit);
  select array_agg(q.id order by q.id) into v_ids from(select r.id from tr8_private.workspace_roles r
    where r.workspace_id=p_workspace_id and (v_after is null or r.id>v_after) order by r.id limit p_limit+1) q;
  if cardinality(v_ids)>p_limit then v_next:=tr8_private.v2_list_cursor('roles',p_workspace_id,null,v_ids[p_limit]); end if;
  select coalesce(jsonb_agg(tr8_private.v2_role_json(p_workspace_id,x.id) order by x.id),'[]'::jsonb)
    into v_items from unnest(v_ids[1:p_limit]) x(id);
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;
create function tr8_private.v2_create_role(p_workspace_id uuid,p_id uuid,p_name text,p_permissions text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_permissions text[]; v_row tr8_private.workspace_roles;
begin
  perform tr8_private.v2_require_team_management(p_workspace_id,'role.manage');
  v_permissions:=tr8_private.v2_validate_permissions(p_permissions);
  if p_id is null or p_name is null or length(btrim(p_name)) not between 1 and 120 then
    raise exception using errcode='22023',message='A valid role identifier and name are required';
  end if;
  if not tr8_private.v2_is_workspace_owner(p_workspace_id)
    and not v_permissions<@tr8_private.v2_permissions_for(p_workspace_id,auth.uid()) then
    raise exception using errcode='PT404',message='Resource unavailable';
  end if;
  select * into v_row from tr8_private.workspace_roles r where r.id=p_id;
  if found then
    if v_row.workspace_id<>p_workspace_id or v_row.name<>btrim(p_name)
      or tr8_private.v2_role_permissions(p_workspace_id,p_id) is distinct from v_permissions then
      raise exception using errcode='PT409',message='The request identifier is unavailable';
    end if;
    return tr8_private.v2_role_json(p_workspace_id,p_id);
  end if;
  insert into tr8_private.workspace_roles(id,workspace_id,name) values(p_id,p_workspace_id,btrim(p_name));
  insert into tr8_private.role_permissions(workspace_id,role_id,permission)
    select p_workspace_id,p_id,v from unnest(v_permissions) v;
  update tr8_private.workspace_authz_state set version=version+1 where workspace_id=p_workspace_id;
  insert into tr8_private.workspace_activity(workspace_id,actor_id,action,resource_id)
    values(p_workspace_id,auth.uid(),'role.created',p_id);
  return tr8_private.v2_role_json(p_workspace_id,p_id);
end;
$$;
create function tr8_private.v2_update_role(p_workspace_id uuid,p_id uuid,p_version integer,p_name text,p_permissions text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_permissions text[]; v_actor_permissions text[]; v_old_permissions text[]; v_row tr8_private.workspace_roles;
begin
  perform tr8_private.v2_require_team_management(p_workspace_id,'role.manage');
  v_permissions:=tr8_private.v2_validate_permissions(p_permissions);
  if p_id is null or p_version is null or p_version<1 or p_name is null or length(btrim(p_name)) not between 1 and 120 then
    raise exception using errcode='22023',message='A valid role name and version are required';
  end if;
  select * into v_row from tr8_private.workspace_roles r where r.workspace_id=p_workspace_id and r.id=p_id for update;
  if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  v_actor_permissions:=tr8_private.v2_permissions_for(p_workspace_id,auth.uid());
  v_old_permissions:=tr8_private.v2_role_permissions(p_workspace_id,p_id);
  if not tr8_private.v2_is_workspace_owner(p_workspace_id) and (
    not v_old_permissions<@v_actor_permissions or not v_permissions<@v_actor_permissions
    or exists(select 1 from tr8_private.member_roles mr join tr8_private.workspace_members m
      on m.workspace_id=mr.workspace_id and m.id=mr.member_id
      where mr.workspace_id=p_workspace_id and mr.role_id=p_id and m.status='active'
        and not tr8_private.v2_permissions_for(p_workspace_id,m.user_id)<@v_actor_permissions)) then
    raise exception using errcode='PT404',message='Resource unavailable';
  end if;
  if v_row.version<>p_version then raise exception using errcode='PT409',message='This role changed. Reload it before saving'; end if;
  perform 1 from tr8_private.workspace_members m where m.workspace_id=p_workspace_id and exists(
    select 1 from tr8_private.member_roles mr where mr.workspace_id=m.workspace_id and mr.member_id=m.id and mr.role_id=p_id)
    order by m.id for update;
  update tr8_private.workspace_roles set name=btrim(p_name),version=version+1,updated_at=statement_timestamp() where id=p_id;
  delete from tr8_private.role_permissions where workspace_id=p_workspace_id and role_id=p_id;
  insert into tr8_private.role_permissions(workspace_id,role_id,permission) select p_workspace_id,p_id,v from unnest(v_permissions) v;
  -- A delegated edit of a role already held by the actor cannot increase its
  -- complete effective set, even through a second role or a future assignment.
  if not tr8_private.v2_is_workspace_owner(p_workspace_id)
    and not tr8_private.v2_permissions_for(p_workspace_id,auth.uid())<@v_actor_permissions then
    raise exception using errcode='PT404',message='Resource unavailable';
  end if;
  update tr8_private.workspace_members m set version=m.version+1,updated_at=statement_timestamp()
    where m.workspace_id=p_workspace_id and exists(select 1 from tr8_private.member_roles mr
      where mr.workspace_id=m.workspace_id and mr.member_id=m.id and mr.role_id=p_id);
  perform tr8_private.v2_cleanup_assignments(p_workspace_id);
  update tr8_private.workspace_authz_state set version=version+1 where workspace_id=p_workspace_id;
  insert into tr8_private.workspace_activity(workspace_id,actor_id,action,resource_id)
    values(p_workspace_id,auth.uid(),'role.updated',p_id);
  return tr8_private.v2_role_json(p_workspace_id,p_id);
end;
$$;
create function tr8_private.v2_delete_role(p_workspace_id uuid,p_id uuid,p_version integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_actor_permissions text[]; v_row tr8_private.workspace_roles;
begin
  perform tr8_private.v2_require_team_management(p_workspace_id,'role.manage');
  if p_id is null or p_version is null or p_version<1 then raise exception using errcode='22023',message='A role identifier and version are required'; end if;
  select * into v_row from tr8_private.workspace_roles r where r.workspace_id=p_workspace_id and r.id=p_id for update;
  if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  v_actor_permissions:=tr8_private.v2_permissions_for(p_workspace_id,auth.uid());
  if not tr8_private.v2_is_workspace_owner(p_workspace_id) and (
    not tr8_private.v2_role_permissions(p_workspace_id,p_id)<@v_actor_permissions
    or exists(select 1 from tr8_private.member_roles mr join tr8_private.workspace_members m
      on m.workspace_id=mr.workspace_id and m.id=mr.member_id
      where mr.workspace_id=p_workspace_id and mr.role_id=p_id and m.status='active'
        and not tr8_private.v2_permissions_for(p_workspace_id,m.user_id)<@v_actor_permissions)) then
    raise exception using errcode='PT404',message='Resource unavailable';
  end if;
  if v_row.version<>p_version then raise exception using errcode='PT409',message='This role changed. Reload it before deleting'; end if;
  -- Preserve all invitation history and its target role; do not cascade it away.
  if exists(select 1 from tr8_private.invitations i where i.workspace_id=p_workspace_id and i.role_id=p_id) then
    raise exception using errcode='PT409',message='A role referenced by an invitation cannot be deleted';
  end if;
  perform 1 from tr8_private.workspace_members m where m.workspace_id=p_workspace_id and exists(
    select 1 from tr8_private.member_roles mr where mr.workspace_id=m.workspace_id and mr.member_id=m.id and mr.role_id=p_id)
    order by m.id for update;
  update tr8_private.workspace_members m set version=m.version+1,updated_at=statement_timestamp()
    where m.workspace_id=p_workspace_id and exists(select 1 from tr8_private.member_roles mr
      where mr.workspace_id=m.workspace_id and mr.member_id=m.id and mr.role_id=p_id);
  delete from tr8_private.member_roles where workspace_id=p_workspace_id and role_id=p_id;
  delete from tr8_private.role_permissions where workspace_id=p_workspace_id and role_id=p_id;
  delete from tr8_private.workspace_roles where workspace_id=p_workspace_id and id=p_id;
  perform tr8_private.v2_cleanup_assignments(p_workspace_id);
  update tr8_private.workspace_authz_state set version=version+1 where workspace_id=p_workspace_id;
  insert into tr8_private.workspace_activity(workspace_id,actor_id,action,resource_id)
    values(p_workspace_id,auth.uid(),'role.deleted',p_id);
  return jsonb_build_object('id',p_id,'deleted',true);
end;
$$;

create or replace function tr8_private.v2_list_members(p_workspace_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform tr8_private.v2_require_workspace(p_workspace_id,'member.read');
  select coalesce(jsonb_agg(tr8_private.v2_member_json(p_workspace_id,m.id) order by m.created_at,m.id),'[]'::jsonb)
    into v_result from tr8_private.workspace_members m where m.workspace_id=p_workspace_id and m.status='active';
  return v_result;
end;
$$;
create function tr8_private.v2_list_members_page(p_workspace_id uuid,p_cursor text default null,p_limit integer default 100)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_after uuid; v_ids uuid[]; v_items jsonb; v_next text;
begin
  perform tr8_private.v2_require_workspace(p_workspace_id,'member.read');
  v_after:=tr8_private.v2_parse_list_cursor(p_cursor,'members',p_workspace_id,null,p_limit);
  select array_agg(q.id order by q.id) into v_ids from(select m.id from tr8_private.workspace_members m
    where m.workspace_id=p_workspace_id and m.status='active' and (v_after is null or m.id>v_after)
    order by m.id limit p_limit+1) q;
  if cardinality(v_ids)>p_limit then v_next:=tr8_private.v2_list_cursor('members',p_workspace_id,null,v_ids[p_limit]); end if;
  select coalesce(jsonb_agg(tr8_private.v2_member_json(p_workspace_id,x.id) order by x.id),'[]'::jsonb)
    into v_items from unnest(v_ids[1:p_limit]) x(id);
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;
create function tr8_private.v2_set_member_roles(p_workspace_id uuid,p_member_id uuid,p_version integer,p_role_ids uuid[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_roles uuid[]; v_row tr8_private.workspace_members; v_actor_permissions text[]; v_target_permissions text[];
begin
  perform tr8_private.v2_require_team_management(p_workspace_id,'role.assign');
  if p_member_id is null or p_version is null or p_version<1 or p_role_ids is null
    or cardinality(p_role_ids)>100 or array_position(p_role_ids,null) is not null then
    raise exception using errcode='22023',message='A member version and a valid role set are required';
  end if;
  select coalesce(array_agg(distinct v order by v),array[]::uuid[]) into v_roles from unnest(p_role_ids) v;
  -- Role rows precede memberships in the lock order, after workspace authz.
  perform 1 from tr8_private.workspace_roles r where r.workspace_id=p_workspace_id and r.id=any(v_roles) order by r.id for share;
  if (select count(*) from tr8_private.workspace_roles r where r.workspace_id=p_workspace_id and r.id=any(v_roles))<>cardinality(v_roles) then
    raise exception using errcode='PT404',message='Resource unavailable';
  end if;
  select * into v_row from tr8_private.workspace_members m where m.workspace_id=p_workspace_id and m.id=p_member_id for update;
  if not found or not tr8_private.v2_can_manage_member(p_workspace_id,p_member_id,'role.assign') then
    raise exception using errcode='PT404',message='Resource unavailable';
  end if;
  v_actor_permissions:=tr8_private.v2_permissions_for(p_workspace_id,auth.uid());
  select coalesce(array_agg(distinct r.permission order by r.permission),array[]::text[]) into v_target_permissions
    from tr8_private.role_permissions r where r.workspace_id=p_workspace_id and r.role_id=any(v_roles);
  if not tr8_private.v2_is_workspace_owner(p_workspace_id) and not v_target_permissions<@v_actor_permissions then
    raise exception using errcode='PT404',message='Resource unavailable';
  end if;
  if v_row.version<>p_version then raise exception using errcode='PT409',message='This member changed. Reload it before saving'; end if;
  delete from tr8_private.member_roles where workspace_id=p_workspace_id and member_id=p_member_id;
  insert into tr8_private.member_roles(workspace_id,member_id,role_id) select p_workspace_id,p_member_id,v from unnest(v_roles) v;
  if not tr8_private.v2_is_workspace_owner(p_workspace_id)
    and not tr8_private.v2_permissions_for(p_workspace_id,auth.uid())<@v_actor_permissions then
    raise exception using errcode='PT404',message='Resource unavailable';
  end if;
  update tr8_private.workspace_members set version=version+1,updated_at=statement_timestamp() where id=p_member_id;
  perform tr8_private.v2_cleanup_assignments(p_workspace_id);
  update tr8_private.workspace_authz_state set version=version+1 where workspace_id=p_workspace_id;
  insert into tr8_private.workspace_activity(workspace_id,actor_id,action,resource_id)
    values(p_workspace_id,auth.uid(),'member.roles_changed',p_member_id);
  return tr8_private.v2_member_json(p_workspace_id,p_member_id);
end;
$$;
create function tr8_private.v2_remove_member(p_workspace_id uuid,p_member_id uuid,p_version integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row tr8_private.workspace_members;
begin
  perform tr8_private.v2_require_team_management(p_workspace_id,'member.remove');
  if p_member_id is null or p_version is null or p_version<1 then
    raise exception using errcode='22023',message='A member identifier and version are required';
  end if;
  select * into v_row from tr8_private.workspace_members m where m.workspace_id=p_workspace_id and m.id=p_member_id for update;
  if not found or not tr8_private.v2_can_manage_member(p_workspace_id,p_member_id,'member.remove') then
    raise exception using errcode='PT404',message='Resource unavailable';
  end if;
  if v_row.version<>p_version then raise exception using errcode='PT409',message='This member changed. Reload it before removing'; end if;
  -- Retain stable membership identity and creator provenance. Clear assignments
  -- only after status/role/ACL revocation, so effective access is recalculated.
  update tr8_private.workspace_members set status='removed',version=version+1,updated_at=statement_timestamp() where id=p_member_id;
  delete from tr8_private.member_roles where workspace_id=p_workspace_id and member_id=p_member_id;
  delete from tr8_private.project_access where workspace_id=p_workspace_id and member_id=p_member_id;
  perform tr8_private.v2_cleanup_assignments(p_workspace_id);
  update tr8_private.workspace_authz_state set version=version+1 where workspace_id=p_workspace_id;
  insert into tr8_private.workspace_activity(workspace_id,actor_id,action,resource_id)
    values(p_workspace_id,auth.uid(),'member.removed',p_member_id);
  return tr8_private.v2_member_json(p_workspace_id,p_member_id);
end;
$$;

create function tr8_private.v2_access_json(p_workspace_id uuid,p_project_id uuid,p_member_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('workspace_id',a.workspace_id,'project_id',a.project_id,'member_id',a.member_id,
    'display_name',u.display_name,'access_level',a.access_level,'version',a.version)
  from tr8_private.project_access a join tr8_private.workspace_members m
    on m.workspace_id=a.workspace_id and m.id=a.member_id
  join tr8_private.app_users u on u.user_id=m.user_id
  where a.workspace_id=p_workspace_id and a.project_id=p_project_id and a.member_id=p_member_id;
$$;
create function tr8_private.v2_list_project_access(p_workspace_id uuid,p_project_id uuid,p_cursor text default null,p_limit integer default 100)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_after uuid; v_ids uuid[]; v_items jsonb; v_next text;
begin
  perform tr8_private.v2_require_project(p_workspace_id,p_project_id,'project.access.manage',true);
  v_after:=tr8_private.v2_parse_list_cursor(p_cursor,'access',p_workspace_id,p_project_id,p_limit);
  select array_agg(q.id order by q.id) into v_ids from(select a.member_id as id from tr8_private.project_access a
    join tr8_private.workspace_members m on m.workspace_id=a.workspace_id and m.id=a.member_id and m.status='active'
    where a.workspace_id=p_workspace_id and a.project_id=p_project_id and (v_after is null or a.member_id>v_after)
    order by a.member_id limit p_limit+1) q;
  if cardinality(v_ids)>p_limit then v_next:=tr8_private.v2_list_cursor('access',p_workspace_id,p_project_id,v_ids[p_limit]); end if;
  select coalesce(jsonb_agg(tr8_private.v2_access_json(p_workspace_id,p_project_id,x.id) order by x.id),'[]'::jsonb)
    into v_items from unnest(v_ids[1:p_limit]) x(id);
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;
create function tr8_private.v2_set_project_access(p_workspace_id uuid,p_project_id uuid,p_member_id uuid,p_version integer,p_access_level text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_member tr8_private.workspace_members; v_row tr8_private.project_access; v_exists boolean;
begin
  perform tr8_private.v2_require_actor();
  perform tr8_private.v2_lock_workspace(p_workspace_id,true);
  perform tr8_private.v2_require_project(p_workspace_id,p_project_id,'project.access.manage',true);
  if p_member_id is null or p_version is null or p_version<0 or p_access_level is null or p_access_level not in ('read','write') then
    raise exception using errcode='22023',message='A valid project access level and version are required';
  end if;
  select * into v_member from tr8_private.workspace_members m where m.workspace_id=p_workspace_id and m.id=p_member_id for update;
  if not found or v_member.status<>'active' or not tr8_private.v2_user_live(v_member.user_id)
    or not exists(select 1 from tr8_private.app_users a where a.user_id=v_member.user_id and a.enabled)
    or not exists(select 1 from tr8_private.workspaces w where w.id=p_workspace_id and w.kind='team' and w.owner_id<>v_member.user_id) then
    raise exception using errcode='PT404',message='Resource unavailable';
  end if;
  perform 1 from public.tr8_workspace_projects p where p.workspace_id=p_workspace_id and p.id=p_project_id for update;
  select * into v_row from tr8_private.project_access a where a.workspace_id=p_workspace_id and a.project_id=p_project_id and a.member_id=p_member_id for update;
  v_exists:=found;
  -- Even a role administrator cannot obtain its first project ACL or upgrade
  -- itself. The owner needs no ACL and is deliberately absent from this API.
  if v_member.user_id=auth.uid() and (not v_exists or (v_row.access_level='read' and p_access_level='write')) then
    raise exception using errcode='PT404',message='Resource unavailable';
  end if;
  if (v_exists and v_row.version<>p_version) or (not v_exists and p_version<>0) then
    raise exception using errcode='PT409',message='This project access changed. Reload it before saving';
  end if;
  if v_exists then
    update tr8_private.project_access set access_level=p_access_level,version=version+1,updated_at=statement_timestamp()
      where workspace_id=p_workspace_id and project_id=p_project_id and member_id=p_member_id;
  else
    insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level)
      values(p_workspace_id,p_project_id,p_member_id,p_access_level);
  end if;
  perform tr8_private.v2_cleanup_assignments(p_workspace_id);
  update tr8_private.workspace_authz_state set version=version+1 where workspace_id=p_workspace_id;
  insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
    values(p_workspace_id,p_project_id,auth.uid(),'project.access_changed',p_member_id);
  return tr8_private.v2_access_json(p_workspace_id,p_project_id,p_member_id);
end;
$$;
create function tr8_private.v2_remove_project_access(p_workspace_id uuid,p_project_id uuid,p_member_id uuid,p_version integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row tr8_private.project_access;
begin
  perform tr8_private.v2_require_actor();
  perform tr8_private.v2_lock_workspace(p_workspace_id,true);
  perform tr8_private.v2_require_project(p_workspace_id,p_project_id,'project.access.manage',true);
  if p_member_id is null or p_version is null or p_version<1 then
    raise exception using errcode='22023',message='A project access identifier and version are required';
  end if;
  perform 1 from tr8_private.workspace_members m join tr8_private.workspaces w on w.id=m.workspace_id
    where m.workspace_id=p_workspace_id and m.id=p_member_id and m.status='active' and w.kind='team' and w.owner_id<>m.user_id for update of m;
  if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  perform 1 from public.tr8_workspace_projects p where p.workspace_id=p_workspace_id and p.id=p_project_id for update;
  select * into v_row from tr8_private.project_access a where a.workspace_id=p_workspace_id and a.project_id=p_project_id and a.member_id=p_member_id for update;
  if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  if v_row.version<>p_version then raise exception using errcode='PT409',message='This project access changed. Reload it before removing'; end if;
  delete from tr8_private.project_access where workspace_id=p_workspace_id and project_id=p_project_id and member_id=p_member_id;
  perform tr8_private.v2_cleanup_assignments(p_workspace_id);
  update tr8_private.workspace_authz_state set version=version+1 where workspace_id=p_workspace_id;
  insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
    values(p_workspace_id,p_project_id,auth.uid(),'project.access_removed',p_member_id);
  return jsonb_build_object('member_id',p_member_id,'deleted',true);
end;
$$;

create function tr8_private.v2_project_capabilities_json(p_workspace_id uuid,p_project_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with access as (select case when tr8_private.v2_is_workspace_owner(p_workspace_id) then 'write'
    else (select a.access_level from tr8_private.workspace_members m join tr8_private.project_access a
      on a.workspace_id=m.workspace_id and a.member_id=m.id where m.workspace_id=p_workspace_id
      and m.user_id=(select auth.uid()) and m.status='active' and a.project_id=p_project_id) end as level),
  project as (select p.archived_at from public.tr8_workspace_projects p where p.workspace_id=p_workspace_id and p.id=p_project_id)
  select jsonb_build_object('project_id',p_project_id,'access_level',a.level,'permissions',
    coalesce((select jsonb_agg(x.permission order by x.permission) from unnest(tr8_private.v2_permissions_for(p_workspace_id,(select auth.uid()))) x(permission)
      where (x.permission='project.read')
        or (x.permission='task.read')
        or (x.permission in ('project.edit','project.archive','project.access.manage') and a.level='write')
        or (x.permission in ('task.create','task.edit','task.assign') and a.level='write' and p.archived_at is null
          and tr8_private.v2_has_permission(p_workspace_id,'task.read'))
        or (x.permission='task.delete' and a.level='write' and tr8_private.v2_has_permission(p_workspace_id,'task.read'))
        or (x.permission='audit.read')),'[]'::jsonb))
  from access a cross join project p where tr8_private.v2_can_read_project(p_workspace_id,p_project_id);
$$;
create function tr8_private.v2_get_project_capabilities(p_workspace_id uuid,p_project_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform tr8_private.v2_require_project(p_workspace_id,p_project_id,'project.read',false);
  return tr8_private.v2_project_capabilities_json(p_workspace_id,p_project_id);
end;
$$;
create function tr8_private.v2_list_project_capabilities(p_workspace_id uuid,p_cursor text default null,p_limit integer default 100)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_after uuid; v_ids uuid[]; v_items jsonb; v_next text;
begin
  perform tr8_private.v2_require_workspace(p_workspace_id,'project.read');
  v_after:=tr8_private.v2_parse_list_cursor(p_cursor,'capabilities',p_workspace_id,null,p_limit);
  select array_agg(q.id order by q.id) into v_ids from(select p.id from public.tr8_workspace_projects p
    where p.workspace_id=p_workspace_id and (v_after is null or p.id>v_after)
      and tr8_private.v2_can_read_project(p_workspace_id,p.id) order by p.id limit p_limit+1) q;
  if cardinality(v_ids)>p_limit then v_next:=tr8_private.v2_list_cursor('capabilities',p_workspace_id,null,v_ids[p_limit]); end if;
  select coalesce(jsonb_agg(tr8_private.v2_project_capabilities_json(p_workspace_id,x.id) order by x.id),'[]'::jsonb)
    into v_items from unnest(v_ids[1:p_limit]) x(id);
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;

create function tr8_private.v2_list_assignable_members(p_workspace_id uuid,p_project_id uuid,p_cursor text default null,p_limit integer default 100)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_after uuid; v_ids uuid[]; v_items jsonb; v_next text;
begin
  -- Project task readers need the minimal names used to display responsibility.
  -- Listing eligible project participants is not permission to assign a task.
  perform tr8_private.v2_require_project(p_workspace_id,p_project_id,'task.read',false);
  v_after:=tr8_private.v2_parse_list_cursor(p_cursor,'assignees',p_workspace_id,p_project_id,p_limit);
  select array_agg(q.id order by q.id) into v_ids from(select m.id from tr8_private.workspace_members m
    where m.workspace_id=p_workspace_id and m.status='active' and (v_after is null or m.id>v_after)
      and tr8_private.v2_assignee_eligible(p_workspace_id,p_project_id,m.id) order by m.id limit p_limit+1) q;
  if cardinality(v_ids)>p_limit then v_next:=tr8_private.v2_list_cursor('assignees',p_workspace_id,p_project_id,v_ids[p_limit]); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'user_id',m.user_id,'display_name',a.display_name,
    'is_owner',w.owner_id=m.user_id) order by m.id),'[]'::jsonb) into v_items
    from tr8_private.workspace_members m join tr8_private.app_users a on a.user_id=m.user_id
    join tr8_private.workspaces w on w.id=m.workspace_id where m.workspace_id=p_workspace_id and m.id=any(v_ids[1:p_limit]);
  return jsonb_build_object('items',v_items,'next_cursor',v_next);
end;
$$;
create function tr8_private.v2_assign_task(p_workspace_id uuid,p_id uuid,p_version integer,p_assignee_member_id uuid)
returns public.tr8_workspace_tasks language plpgsql volatile security definer set search_path = '' as $$
declare v_project uuid; v_row public.tr8_workspace_tasks; v_old_user uuid;
begin
  perform tr8_private.v2_require_actor();
  if p_id is null or p_version is null or p_version<1 then raise exception using errcode='22023',message='A task identifier and version are required'; end if;
  -- Workspace lock before reading authorization-sensitive parent/assignee state.
  perform tr8_private.v2_lock_workspace(p_workspace_id);
  perform tr8_private.v2_require_actor();
  select t.project_id into v_project from public.tr8_workspace_tasks t where t.workspace_id=p_workspace_id and t.id=p_id;
  if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  perform tr8_private.v2_require_project(p_workspace_id,v_project,'task.assign',true);
  if p_assignee_member_id is not null then
    perform 1 from tr8_private.workspace_members m where m.workspace_id=p_workspace_id and m.id=p_assignee_member_id for share;
    if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
    if not tr8_private.v2_assignee_eligible(p_workspace_id,v_project,p_assignee_member_id) then
      raise exception using errcode='22023',message='The assignee must be an active member able to read this project and its tasks';
    end if;
  end if;
  perform 1 from public.tr8_workspace_projects p where p.workspace_id=p_workspace_id and p.id=v_project for share;
  select * into v_row from public.tr8_workspace_tasks t where t.workspace_id=p_workspace_id and t.id=p_id for update;
  if not found then raise exception using errcode='PT404',message='Resource unavailable'; end if;
  if v_row.version<>p_version then raise exception using errcode='PT409',message='This task changed. Reload it before assigning'; end if;
  if exists(select 1 from public.tr8_workspace_projects p where p.workspace_id=p_workspace_id and p.id=v_project and p.archived_at is not null) then
    raise exception using errcode='PT409',message='Restore the archived project before editing its tasks';
  end if;
  select m.user_id into v_old_user from tr8_private.workspace_members m where m.workspace_id=p_workspace_id and m.id=v_row.assignee_member_id;
  update public.tr8_workspace_tasks set assignee_member_id=p_assignee_member_id where workspace_id=p_workspace_id and id=p_id returning * into v_row;
  insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id,affected_user_id)
    values(p_workspace_id,v_project,auth.uid(),case when p_assignee_member_id is null then 'task.unassigned' else 'task.assigned' end,p_id,
      case when p_assignee_member_id is null then v_old_user else (select m.user_id from tr8_private.workspace_members m
        where m.workspace_id=p_workspace_id and m.id=p_assignee_member_id) end);
  return v_row;
end;
$$;

create function tr8_private.v2_list_activity(p_workspace_id uuid,p_project_id uuid default null,p_before_id bigint default null,p_limit integer default 50)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_ids bigint[]; v_items jsonb; v_next bigint;
begin
  perform tr8_private.v2_require_workspace(p_workspace_id,'audit.read');
  if p_project_id is not null then perform tr8_private.v2_require_project(p_workspace_id,p_project_id,'audit.read',false); end if;
  if p_limit is null or p_limit<1 or p_limit>250 or (p_before_id is not null and p_before_id<1) then
    raise exception using errcode='22023',message='Invalid activity cursor or limit';
  end if;
  select array_agg(q.id order by q.id desc) into v_ids from(select a.id from tr8_private.workspace_activity a
    where a.workspace_id=p_workspace_id and (p_before_id is null or a.id<p_before_id)
      and (p_project_id is null or a.project_id=p_project_id)
      and (a.project_id is null or tr8_private.v2_can_read_project(p_workspace_id,a.project_id))
    order by a.id desc limit p_limit+1) q;
  if cardinality(v_ids)>p_limit then v_next:=v_ids[p_limit]; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'project_id',a.project_id,
    'actor_id',a.actor_id,'actor_name',u.display_name,'action',a.action,'resource_id',a.resource_id,'created_at',a.created_at)
    order by a.id desc),'[]'::jsonb) into v_items from tr8_private.workspace_activity a
    join tr8_private.app_users u on u.user_id=a.actor_id where a.workspace_id=p_workspace_id and a.id=any(v_ids[1:p_limit]);
  return jsonb_build_object('items',v_items,'next_before_id',v_next);
end;
$$;

-- Public invoker wrappers preserve the Stage 1 privilege boundary. No domain
-- mutation table, sequence or arbitrary-user helper becomes client-writable.
create function public.tr8_v2_list_roles(p_workspace_id uuid,p_cursor text default null,p_limit integer default 100)
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_list_roles(p_workspace_id,p_cursor,p_limit); $$;
create function public.tr8_v2_create_role(p_workspace_id uuid,p_id uuid,p_name text,p_permissions text[])
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_create_role(p_workspace_id,p_id,p_name,p_permissions); $$;
create function public.tr8_v2_update_role(p_workspace_id uuid,p_id uuid,p_version integer,p_name text,p_permissions text[])
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_update_role(p_workspace_id,p_id,p_version,p_name,p_permissions); $$;
create function public.tr8_v2_delete_role(p_workspace_id uuid,p_id uuid,p_version integer)
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_delete_role(p_workspace_id,p_id,p_version); $$;
create function public.tr8_v2_list_members_page(p_workspace_id uuid,p_cursor text default null,p_limit integer default 100)
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_list_members_page(p_workspace_id,p_cursor,p_limit); $$;
create function public.tr8_v2_set_member_roles(p_workspace_id uuid,p_member_id uuid,p_version integer,p_role_ids uuid[])
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_set_member_roles(p_workspace_id,p_member_id,p_version,p_role_ids); $$;
create function public.tr8_v2_remove_member(p_workspace_id uuid,p_member_id uuid,p_version integer)
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_remove_member(p_workspace_id,p_member_id,p_version); $$;
create function public.tr8_v2_list_project_access(p_workspace_id uuid,p_project_id uuid,p_cursor text default null,p_limit integer default 100)
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_list_project_access(p_workspace_id,p_project_id,p_cursor,p_limit); $$;
create function public.tr8_v2_set_project_access(p_workspace_id uuid,p_project_id uuid,p_member_id uuid,p_version integer,p_access_level text)
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_set_project_access(p_workspace_id,p_project_id,p_member_id,p_version,p_access_level); $$;
create function public.tr8_v2_remove_project_access(p_workspace_id uuid,p_project_id uuid,p_member_id uuid,p_version integer)
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_remove_project_access(p_workspace_id,p_project_id,p_member_id,p_version); $$;
create function public.tr8_v2_get_project_capabilities(p_workspace_id uuid,p_project_id uuid)
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_get_project_capabilities(p_workspace_id,p_project_id); $$;
create function public.tr8_v2_list_project_capabilities(p_workspace_id uuid,p_cursor text default null,p_limit integer default 100)
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_list_project_capabilities(p_workspace_id,p_cursor,p_limit); $$;
create function public.tr8_v2_list_assignable_members(p_workspace_id uuid,p_project_id uuid,p_cursor text default null,p_limit integer default 100)
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_list_assignable_members(p_workspace_id,p_project_id,p_cursor,p_limit); $$;
create function public.tr8_v2_assign_task(p_workspace_id uuid,p_id uuid,p_version integer,p_assignee_member_id uuid)
returns public.tr8_workspace_tasks language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_assign_task(p_workspace_id,p_id,p_version,p_assignee_member_id); $$;
create function public.tr8_v2_list_activity(p_workspace_id uuid,p_project_id uuid default null,p_before_id bigint default null,p_limit integer default 50)
returns jsonb language sql volatile security invoker set search_path = '' as $$ select tr8_private.v2_list_activity(p_workspace_id,p_project_id,p_before_id,p_limit); $$;

do $stage2_grants$
declare v_fn record; v_names text[]:=array['list_roles','create_role','update_role','delete_role','list_members_page',
  'set_member_roles','remove_member','list_project_access','set_project_access','remove_project_access',
  'get_project_capabilities','list_project_capabilities','list_assignable_members','assign_task','list_activity'];
begin
  for v_fn in select p.oid::regprocedure as signature,n.nspname,p.proname from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='tr8_private' and p.proname like 'v2_%')
      or (n.nspname='public' and p.proname like 'tr8_v2_%') loop
    -- Only new routines are changed here; preserve all grants of applied APIs.
    if (v_fn.nspname='public' and substring(v_fn.proname from 8)=any(v_names))
      or (v_fn.nspname='tr8_private' and substring(v_fn.proname from 4)=any(v_names)) then
      execute format('revoke all on function %s from public,anon,authenticated,service_role',v_fn.signature);
      execute format('grant execute on function %s to authenticated',v_fn.signature);
    elsif v_fn.nspname='tr8_private' and v_fn.proname=any(array['v2_is_workspace_owner',
      'v2_project_readable_for','v2_assignee_eligible','v2_require_team_management',
      'v2_validate_permissions','v2_role_permissions','v2_role_json','v2_can_manage_member',
      'v2_member_json','v2_list_cursor','v2_parse_list_cursor','v2_cleanup_assignments',
      'v2_access_json','v2_project_capabilities_json']) then
      execute format('revoke all on function %s from public,anon,authenticated,service_role',v_fn.signature);
    end if;
  end loop;
end;
$stage2_grants$;

do $stage2_preservation$
declare s record;
begin
  select * into strict s from tr8_stage2_snapshot;
  if s.projects_oid<>'public.tr8_workspace_projects'::regclass::oid
    or s.tasks_oid<>'public.tr8_workspace_tasks'::regclass::oid
    or s.sequence_oid<>pg_get_serial_sequence('public.tr8_workspace_tasks','task_number')::regclass::oid
    or s.projects_hash is distinct from (select md5(coalesce(string_agg(to_jsonb(p)::text,E'\n' order by id),'')) from public.tr8_workspace_projects p)
    or s.tasks_hash is distinct from (select md5(coalesce(string_agg((to_jsonb(t)-'assignee_member_id')::text,E'\n' order by id),'')) from public.tr8_workspace_tasks t)
    or s.sequence_state is distinct from (select jsonb_build_object('last_value',q.last_value,'is_called',q.is_called) from public.tr8_tasks_task_number_seq q)
    or s.external_invites_enabled is distinct from (select external_invites_enabled from tr8_private.app_config where singleton)
    or exists(select 1 from public.tr8_workspace_tasks where assignee_member_id is not null) then
    raise exception 'Historical content, versions, identity sequence or invitation gate changed during Stage 2 migration';
  end if;
end;
$stage2_preservation$;
comment on column public.tr8_workspace_tasks.assignee_member_id is 'One optional live member able to read the project and tasks; assignment is not creator provenance or an access grant.';
comment on column tr8_private.workspace_activity.affected_user_id is 'Private durable recipient identity for assignment cleanup; never returned by activity RPC. No external worker is enabled.';
notify pgrst,'reload schema';
