-- Close a resource-existence distinction for accounts that cannot use TR8.
-- Preserve both function identities, signatures and grants; the actor gate now
-- precedes input validation and the parent lookup in each task mutation.


create or replace function tr8_private.v2_update_task(p_workspace_id uuid, p_id uuid, p_version integer, p_patch jsonb)
returns public.tr8_workspace_tasks language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.tr8_workspace_tasks; v_project uuid; v_key text; v_type text;
begin
  -- Deny application access before probing task existence or its workspace.
  perform tr8_private.v2_require_actor();
  if p_id is null or p_version is null or p_version < 1 or p_patch is null
    or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'A version and a nonempty task patch are required';
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key <> all(array['title','description','status','priority','start_date','due_date','position']) then
      raise exception using errcode = '22023', message = 'Unknown or server-managed task field';
    end if;
    v_type := jsonb_typeof(p_patch -> v_key);
    if v_key = 'position' then
      if v_type <> 'number' or (p_patch ->> v_key) !~ '^-?[0-9]+$' then
        raise exception using errcode = '22023', message = 'Task position must be an integer';
      end if;
    elsif v_type <> 'string' and not(v_key in ('start_date','due_date') and v_type = 'null') then
      raise exception using errcode = '22023', message = 'Invalid task field type';
    end if;
    if v_key in ('start_date','due_date') and v_type = 'string' and (p_patch ->> v_key) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception using errcode = '22023', message = 'Task dates must use YYYY-MM-DD';
    end if;
  end loop;
  -- Discover the parent without a row lock, then use workspace -> project -> task.
  select t.project_id into v_project from public.tr8_workspace_tasks t where t.workspace_id = p_workspace_id and t.id = p_id;
  if not found then raise exception using errcode = 'PT404', message = 'Resource unavailable'; end if;
  perform tr8_private.v2_require_project(p_workspace_id,v_project,'task.edit',true);
  perform 1 from public.tr8_workspace_projects p where p.workspace_id = p_workspace_id and p.id = v_project for share;
  select * into v_row from public.tr8_workspace_tasks t where t.workspace_id = p_workspace_id and t.id = p_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'Resource unavailable'; end if;
  if v_row.version <> p_version then
    raise exception using errcode = 'PT409', message = 'This task changed. Reload it before saving';
  end if;
  update public.tr8_workspace_tasks t set
    title = case when p_patch ? 'title' then btrim(p_patch ->> 'title') else t.title end,
    description = case when p_patch ? 'description' then p_patch ->> 'description' else t.description end,
    status = case when p_patch ? 'status' then p_patch ->> 'status' else t.status end,
    priority = case when p_patch ? 'priority' then p_patch ->> 'priority' else t.priority end,
    start_date = case when p_patch ? 'start_date' then (p_patch ->> 'start_date')::date else t.start_date end,
    due_date = case when p_patch ? 'due_date' then (p_patch ->> 'due_date')::date else t.due_date end,
    position = case when p_patch ? 'position' then (p_patch ->> 'position')::bigint else t.position end
    where t.workspace_id = p_workspace_id and t.id = p_id returning * into v_row;
  insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
    values(p_workspace_id,v_project,auth.uid(),'task.updated',p_id);
  return v_row;
end;
$$;

create or replace function tr8_private.v2_delete_task(p_workspace_id uuid, p_id uuid, p_version integer)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_project uuid; v_version integer;
begin
  -- Deny application access before probing task existence or its workspace.
  perform tr8_private.v2_require_actor();
  if p_id is null or p_version is null or p_version < 1 then
    raise exception using errcode = '22023', message = 'Task identifier and version are required';
  end if;
  select t.project_id into v_project from public.tr8_workspace_tasks t where t.workspace_id = p_workspace_id and t.id = p_id;
  if not found then raise exception using errcode = 'PT404', message = 'Resource unavailable'; end if;
  perform tr8_private.v2_require_project(p_workspace_id,v_project,'task.delete',true);
  perform 1 from public.tr8_workspace_projects p where p.workspace_id = p_workspace_id and p.id = v_project for share;
  select t.version into v_version from public.tr8_workspace_tasks t where t.workspace_id = p_workspace_id and t.id = p_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'Resource unavailable'; end if;
  if v_version <> p_version then
    raise exception using errcode = 'PT409', message = 'This task changed. Reload it before deleting';
  end if;
  delete from public.tr8_workspace_tasks t where t.workspace_id = p_workspace_id and t.id = p_id;
  insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
    values(p_workspace_id,v_project,auth.uid(),'task.deleted',p_id);
end;
$$;
