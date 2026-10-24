-- Permanent project deletion is distinct from reversible archival. Existing
-- custom/template roles receive no new permission; workspace owners already
-- receive the current catalog through v2_permissions_for.
insert into tr8_private.permission_catalog(permission) values('project.delete');

create or replace function tr8_private.v2_project_capabilities_json(p_workspace_id uuid,p_project_id uuid)
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
        or (x.permission in ('project.edit','project.archive','project.delete','project.access.manage') and a.level='write')
        or (x.permission in ('task.create','task.edit','task.assign') and a.level='write' and p.archived_at is null
          and tr8_private.v2_has_permission(p_workspace_id,'task.read'))
        or (x.permission='task.delete' and a.level='write' and tr8_private.v2_has_permission(p_workspace_id,'task.read'))
        or (x.permission='audit.read')),'[]'::jsonb))
  from access a cross join project p where tr8_private.v2_can_read_project(p_workspace_id,p_project_id);
$$;

create function tr8_private.v2_delete_project(p_project_id uuid,p_expected_version bigint,p_confirmation_name text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare v_workspace uuid; v_project public.tr8_workspace_projects;
begin
  -- Deny disabled identities before input validation or resource discovery.
  perform tr8_private.v2_require_actor();
  if p_project_id is null or p_expected_version is null or p_expected_version<1
    or p_confirmation_name is null or length(p_confirmation_name) not between 1 and 120 then
    raise exception using errcode='22023',message='Project, version and exact confirmation name are required';
  end if;
  select p.workspace_id into v_workspace from public.tr8_workspace_projects p where p.id=p_project_id;
  if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
  -- All ordinary mutations use workspace -> project -> task. A project UPDATE
  -- lock blocks concurrent task writes (their parent FOR SHARE lock) and waits
  -- for any task write already in progress before collecting the children.
  perform tr8_private.v2_require_project(v_workspace,p_project_id,'project.delete',true);
  select * into v_project from public.tr8_workspace_projects p
    where p.workspace_id=v_workspace and p.id=p_project_id for update;
  if not found then raise exception using errcode='PT404',message='Resource unavailable';end if;
  if v_project.version<>p_expected_version then
    raise exception using errcode='PT409',message='This project changed. Reload it before deleting';
  end if;
  if p_confirmation_name is distinct from v_project.name then
    raise exception using errcode='22023',message='The confirmation name must exactly match the current project name';
  end if;
  -- Keep ordinary task DELETE triggers: durable outbox/Google cleanup must
  -- commit with deletion. Never directly erase provider links or jobs.
  delete from public.tr8_workspace_tasks t where t.workspace_id=v_workspace and t.project_id=p_project_id;
  delete from tr8_private.project_access a where a.workspace_id=v_workspace and a.project_id=p_project_id;
  -- Do not turn private-project activity into unscoped team activity. Remove
  -- only this project's history, then emit a minimal workspace deletion entry.
  delete from tr8_private.workspace_activity a where a.workspace_id=v_workspace and a.project_id=p_project_id;
  delete from public.tr8_workspace_projects p where p.workspace_id=v_workspace and p.id=p_project_id;
  insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
    values(v_workspace,null,auth.uid(),'project.deleted',p_project_id);
end;
$$;
create function public.tr8_v2_delete_project(p_project_id uuid,p_expected_version bigint,p_confirmation_name text)
returns void language sql volatile security invoker set search_path='' as $$
  select tr8_private.v2_delete_project(p_project_id,p_expected_version,p_confirmation_name);
$$;
revoke all on function tr8_private.v2_delete_project(uuid,bigint,text) from public,anon,authenticated,service_role;
revoke all on function public.tr8_v2_delete_project(uuid,bigint,text) from public,anon,authenticated,service_role;
grant execute on function tr8_private.v2_delete_project(uuid,bigint,text) to authenticated;
grant execute on function public.tr8_v2_delete_project(uuid,bigint,text) to authenticated;
comment on function public.tr8_v2_delete_project(uuid,bigint,text) is
  'Deletes exactly one authorized project and its tasks after exact-name/version confirmation; project.delete is separate from archival.';
