-- A deleted Google Tasks destination must not strand future imports. Repair the
-- stale binding only when a new import needs a project, under the existing sync
-- row lock. Project deletion never acquires sync locks in the reverse order.
create or replace function tr8_private.v6_ensure_import_project(p_connection uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c tr8_private.google_connections; s tr8_private.google_tasks_sync; v_workspace uuid; v_project uuid; v_member uuid;
begin
  select * into strict c from tr8_private.google_connections where id=p_connection;
  select * into strict s from tr8_private.google_tasks_sync where connection_id=c.id for update;
  if s.project_id is not null and exists(select 1 from public.tr8_workspace_projects p
    where p.workspace_id=s.workspace_id and p.id=s.project_id) then
    return jsonb_build_object('workspace_id',s.workspace_id,'project_id',s.project_id);
  end if;
  select w.id,m.id into v_workspace,v_member from tr8_private.workspaces w
    join tr8_private.workspace_members m on m.workspace_id=w.id and m.user_id=c.user_id and m.status='active'
    where w.kind='personal' and w.owner_id=c.user_id;
  if v_workspace is null then raise exception using errcode='PT404',message='Personal workspace unavailable';end if;
  perform tr8_private.v2_lock_workspace(v_workspace);
  v_project:=gen_random_uuid();
  insert into public.tr8_workspace_projects(id,workspace_id,owner_id,name,description,color,status)
    values(v_project,v_workspace,c.user_id,'Google Tasks','Tareas sincronizadas con Google Tasks.','#5A67D8','active');
  insert into tr8_private.project_access(workspace_id,project_id,member_id,access_level) values(v_workspace,v_project,v_member,'write');
  insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
    values(v_workspace,v_project,c.user_id,'google.tasks.project_created',v_project);
  update tr8_private.google_tasks_sync set workspace_id=v_workspace,project_id=v_project where connection_id=c.id;
  return jsonb_build_object('workspace_id',v_workspace,'project_id',v_project);
end; $$;
