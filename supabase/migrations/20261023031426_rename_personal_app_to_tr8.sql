-- TR8 branding: rename existing database objects without copying or resetting data.
-- Apply the whole migration in one transaction. NOWAIT avoids deadlocks with an
-- active task request: if the app is busy, retry after in-flight writes finish.
lock table public.gr8r_projects, public.gr8r_tasks, gr8r_private.app_config
  in access exclusive mode nowait;

-- Snapshot row content, object identities, grants and identity-sequence state.
-- Only temporary metadata is created; the configured real email is never logged.
create temporary table tr8_rename_snapshot on commit drop as
select
  'public.gr8r_projects'::regclass::oid as projects_oid,
  'public.gr8r_tasks'::regclass::oid as tasks_oid,
  'gr8r_private.app_config'::regclass::oid as config_oid,
  'public.gr8r_tasks_task_number_seq'::regclass::oid as sequence_oid,
  (select oid from pg_namespace where nspname = 'gr8r_private') as private_schema_oid,
  (select md5(coalesce(string_agg(to_jsonb(p)::text, E'\n' order by id), '')) from public.gr8r_projects p) as projects_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from public.gr8r_tasks t) as tasks_hash,
  (select md5(to_jsonb(c)::text) from gr8r_private.app_config c where singleton) as config_hash,
  (select jsonb_build_object('last_value', s.last_value, 'is_called', s.is_called) from public.gr8r_tasks_task_number_seq s) as sequence_state,
  (select array_agg(p.oid order by p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'gr8r_private' or (n.nspname = 'public' and starts_with(p.proname, 'gr8r_'))) as function_oids,
  (select jsonb_agg(jsonb_build_array(p.oid, p.proowner, p.proacl, p.prosecdef, p.provolatile, p.proconfig) order by p.oid)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'gr8r_private' or (n.nspname = 'public' and starts_with(p.proname, 'gr8r_'))) as function_security,
  (select jsonb_agg(jsonb_build_array(c.oid, c.relowner, c.relacl, c.relrowsecurity) order by c.oid)
   from pg_class c where c.oid in ('public.gr8r_projects'::regclass, 'public.gr8r_tasks'::regclass,
     'gr8r_private.app_config'::regclass, 'public.gr8r_tasks_task_number_seq'::regclass)) as relation_security,
  (select jsonb_agg(jsonb_build_array(a.attrelid, a.attnum, a.attacl) order by a.attrelid, a.attnum)
   from pg_attribute a where a.attnum > 0 and a.attrelid in ('public.gr8r_projects'::regclass, 'public.gr8r_tasks'::regclass)) as column_security;

alter schema gr8r_private rename to tr8_private;
alter table public.gr8r_projects rename to tr8_projects;
alter table public.gr8r_tasks rename to tr8_tasks;
alter sequence public.gr8r_tasks_task_number_seq rename to tr8_tasks_task_number_seq;

-- Constraint-backed indexes are renamed by RENAME CONSTRAINT itself. Rename
-- those first, then the remaining explicit indexes, policies and user triggers.
do $rename_objects$
declare
  v_object record;
begin
  for v_object in
    select n.nspname, t.relname, c.conname
    from pg_constraint c join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where c.conrelid in ('public.tr8_projects'::regclass, 'public.tr8_tasks'::regclass, 'tr8_private.app_config'::regclass)
      and starts_with(c.conname, 'gr8r_')
  loop
    execute format('alter table %I.%I rename constraint %I to %I',
      v_object.nspname, v_object.relname, v_object.conname, replace(v_object.conname, 'gr8r_', 'tr8_'));
  end loop;
  for v_object in
    select n.nspname, i.relname
    from pg_index x join pg_class i on i.oid = x.indexrelid
    join pg_namespace n on n.oid = i.relnamespace
    where x.indrelid in ('public.tr8_projects'::regclass, 'public.tr8_tasks'::regclass)
      and starts_with(i.relname, 'gr8r_')
  loop
    execute format('alter index %I.%I rename to %I',
      v_object.nspname, v_object.relname, replace(v_object.relname, 'gr8r_', 'tr8_'));
  end loop;
  for v_object in
    select n.nspname, t.relname, p.polname
    from pg_policy p join pg_class t on t.oid = p.polrelid
    join pg_namespace n on n.oid = t.relnamespace
    where p.polrelid in ('public.tr8_projects'::regclass, 'public.tr8_tasks'::regclass)
      and starts_with(p.polname, 'gr8r_')
  loop
    execute format('alter policy %I on %I.%I rename to %I',
      v_object.polname, v_object.nspname, v_object.relname, replace(v_object.polname, 'gr8r_', 'tr8_'));
  end loop;
  for v_object in
    select n.nspname, t.relname, g.tgname
    from pg_trigger g join pg_class t on t.oid = g.tgrelid
    join pg_namespace n on n.oid = t.relnamespace
    where g.tgrelid in ('public.tr8_projects'::regclass, 'public.tr8_tasks'::regclass)
      and not g.tgisinternal and starts_with(g.tgname, 'gr8r_')
  loop
    execute format('alter trigger %I on %I.%I rename to %I',
      v_object.tgname, v_object.nspname, v_object.relname, replace(v_object.tgname, 'gr8r_', 'tr8_'));
  end loop;
end;
$rename_objects$;

-- RENAME preserves function OIDs, owners, ACLs and policy/trigger dependencies.
alter function public.gr8r_check_access() rename to tr8_check_access;
alter function public.gr8r_create_project(uuid, text, text, text, text) rename to tr8_create_project;
alter function public.gr8r_create_task(uuid, uuid, text, text, text, text, date, date) rename to tr8_create_task;
alter function public.gr8r_update_project(uuid, integer, jsonb) rename to tr8_update_project;
alter function public.gr8r_update_task(uuid, integer, jsonb) rename to tr8_update_task;
alter function public.gr8r_delete_task(uuid, integer) rename to tr8_delete_task;

-- PostgreSQL does not rewrite string-literal SQL/PLpgSQL bodies on rename.
-- Replace all nine bodies explicitly; CREATE OR REPLACE preserves their ACLs.
create or replace function tr8_private.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1
    from auth.users as u
    join tr8_private.app_config as c
      on c.singleton and c.owner_email = lower(u.email)
    where u.id = (select auth.uid())
      and u.email_confirmed_at is not null
      and u.deleted_at is null
  );
$$;

create or replace function public.tr8_check_access()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select tr8_private.is_owner(); $$;

create or replace function tr8_private.guard_project()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := statement_timestamp();
    new.updated_at := new.created_at;
    new.version := 1;
  else
    if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id
      or new.created_at is distinct from old.created_at
      or new.updated_at is distinct from old.updated_at or new.version is distinct from old.version then
      raise exception using errcode = '22023', message = 'Server-managed project fields are immutable';
    end if;
    new.version := old.version + 1;
    new.updated_at := statement_timestamp();
  end if;
  new.name := btrim(new.name);
  return new;
end;
$$;

create or replace function tr8_private.guard_task()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_archived_at timestamptz;
begin
  if tg_op = 'INSERT' then
    new.created_at := statement_timestamp();
    new.updated_at := new.created_at;
    new.version := 1;
  else
    if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id
      or new.project_id is distinct from old.project_id or new.task_number is distinct from old.task_number
      or new.created_at is distinct from old.created_at
      or new.updated_at is distinct from old.updated_at or new.version is distinct from old.version then
      raise exception using errcode = '22023', message = 'Server-managed task fields are immutable';
    end if;
    new.version := old.version + 1;
    new.updated_at := statement_timestamp();
  end if;
  -- FOR SHARE serializes task writes with project archival without locking out
  -- concurrent inserts into the same active project.
  select p.archived_at into v_archived_at
  from public.tr8_projects as p
  where p.id = new.project_id and p.owner_id = new.owner_id
  for share;
  if not found then
    raise exception using errcode = '23503', message = 'The project is unavailable';
  end if;
  if v_archived_at is not null then
    raise exception using errcode = '55000', message = 'Restore the archived project before editing its tasks';
  end if;
  new.title := btrim(new.title);
  return new;
end;
$$;

create or replace function public.tr8_create_project(
  p_id uuid, p_name text, p_description text, p_color text, p_status text
)
returns public.tr8_projects
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.tr8_projects;
begin
  if not tr8_private.is_owner() then
    raise exception using errcode = '42501', message = 'This account is not authorized';
  end if;
  if p_id is null or p_name is null or p_description is null or p_color is null or p_status is null then
    raise exception using errcode = '22023', message = 'Project fields are required';
  end if;
  insert into public.tr8_projects (id, owner_id, name, description, color, status)
  values (p_id, auth.uid(), btrim(p_name), p_description, p_color, p_status)
  on conflict (id) do nothing
  returning * into v_row;
  if found then return v_row; end if;
  select * into v_row from public.tr8_projects where id = p_id;
  if not found then
    raise exception using errcode = 'PT409', message = 'The request identifier is unavailable';
  end if;
  if row(v_row.name, v_row.description, v_row.color, v_row.status)
    is distinct from row(btrim(p_name), p_description, p_color, p_status) then
    raise exception using errcode = 'PT409', message = 'The request identifier was already used with different project data';
  end if;
  return v_row;
end;
$$;

create or replace function public.tr8_create_task(
  p_id uuid, p_project_id uuid, p_title text, p_description text, p_status text,
  p_priority text, p_start_date date, p_due_date date
)
returns public.tr8_tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.tr8_tasks;
begin
  if not tr8_private.is_owner() then
    raise exception using errcode = '42501', message = 'This account is not authorized';
  end if;
  if p_id is null or p_project_id is null or p_title is null or p_description is null
    or p_status is null or p_priority is null then
    raise exception using errcode = '22023', message = 'Task fields are required';
  end if;
  -- Return an existing compatible request before checking archival: a successful
  -- create can be retried after its project has subsequently been archived.
  select * into v_row from public.tr8_tasks where id = p_id;
  if not found then
    insert into public.tr8_tasks (
      id, owner_id, project_id, title, description, status, priority, start_date, due_date
    ) values (
      p_id, auth.uid(), p_project_id, btrim(p_title), p_description, p_status, p_priority, p_start_date, p_due_date
    ) on conflict (id) do nothing returning * into v_row;
    if found then return v_row; end if;
    select * into v_row from public.tr8_tasks where id = p_id;
    if not found then
      raise exception using errcode = 'PT409', message = 'The request identifier is unavailable';
    end if;
  end if;
  if row(v_row.project_id, v_row.title, v_row.description, v_row.status, v_row.priority, v_row.start_date, v_row.due_date)
    is distinct from row(p_project_id, btrim(p_title), p_description, p_status, p_priority, p_start_date, p_due_date) then
    raise exception using errcode = 'PT409', message = 'The request identifier was already used with different task data';
  end if;
  return v_row;
end;
$$;

create or replace function public.tr8_update_project(p_id uuid, p_version integer, p_patch jsonb)
returns public.tr8_projects
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.tr8_projects;
  v_key text;
  v_type text;
begin
  if not tr8_private.is_owner() then
    raise exception using errcode = '42501', message = 'This account is not authorized';
  end if;
  if p_id is null or p_version is null or p_version < 1
    or p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'A version and a nonempty project patch are required';
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key <> all(array['name', 'description', 'color', 'status', 'archived_at']) then
      raise exception using errcode = '22023', message = 'Unknown or server-managed project field';
    end if;
    v_type := jsonb_typeof(p_patch -> v_key);
    if v_type <> 'string' and not (v_key = 'archived_at' and v_type = 'null') then
      raise exception using errcode = '22023', message = 'Invalid project field type';
    end if;
  end loop;
  update public.tr8_projects as p set
    name = case when p_patch ? 'name' then btrim(p_patch ->> 'name') else p.name end,
    description = case when p_patch ? 'description' then p_patch ->> 'description' else p.description end,
    color = case when p_patch ? 'color' then p_patch ->> 'color' else p.color end,
    status = case when p_patch ? 'status' then p_patch ->> 'status' else p.status end,
    archived_at = case when p_patch ? 'archived_at' then (p_patch ->> 'archived_at')::timestamptz else p.archived_at end
  where p.id = p_id and p.version = p_version returning p.* into v_row;
  if not found then
    if exists (select 1 from public.tr8_projects where id = p_id) then
      raise exception using errcode = 'PT409', message = 'This project changed. Reload it before saving';
    end if;
    raise exception using errcode = 'PT404', message = 'Project not found';
  end if;
  return v_row;
end;
$$;

create or replace function public.tr8_update_task(p_id uuid, p_version integer, p_patch jsonb)
returns public.tr8_tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.tr8_tasks;
  v_key text;
  v_type text;
begin
  if not tr8_private.is_owner() then
    raise exception using errcode = '42501', message = 'This account is not authorized';
  end if;
  if p_id is null or p_version is null or p_version < 1
    or p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'A version and a nonempty task patch are required';
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key <> all(array['title', 'description', 'status', 'priority', 'start_date', 'due_date', 'position']) then
      raise exception using errcode = '22023', message = 'Unknown or server-managed task field';
    end if;
    v_type := jsonb_typeof(p_patch -> v_key);
    if v_key = 'position' then
      if v_type <> 'number' or (p_patch ->> v_key) !~ '^-?[0-9]+$' then
        raise exception using errcode = '22023', message = 'Task position must be an integer';
      end if;
    elsif v_type <> 'string' and not (v_key in ('start_date', 'due_date') and v_type = 'null') then
      raise exception using errcode = '22023', message = 'Invalid task field type';
    end if;
    if v_key in ('start_date', 'due_date') and v_type = 'string'
      and (p_patch ->> v_key) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception using errcode = '22023', message = 'Task dates must use YYYY-MM-DD';
    end if;
  end loop;
  update public.tr8_tasks as t set
    title = case when p_patch ? 'title' then btrim(p_patch ->> 'title') else t.title end,
    description = case when p_patch ? 'description' then p_patch ->> 'description' else t.description end,
    status = case when p_patch ? 'status' then p_patch ->> 'status' else t.status end,
    priority = case when p_patch ? 'priority' then p_patch ->> 'priority' else t.priority end,
    start_date = case when p_patch ? 'start_date' then (p_patch ->> 'start_date')::date else t.start_date end,
    due_date = case when p_patch ? 'due_date' then (p_patch ->> 'due_date')::date else t.due_date end,
    position = case when p_patch ? 'position' then (p_patch ->> 'position')::bigint else t.position end
  where t.id = p_id and t.version = p_version returning t.* into v_row;
  if not found then
    if exists (select 1 from public.tr8_tasks where id = p_id) then
      raise exception using errcode = 'PT409', message = 'This task changed. Reload it before saving';
    end if;
    raise exception using errcode = 'PT404', message = 'Task not found';
  end if;
  return v_row;
end;
$$;

create or replace function public.tr8_delete_task(p_id uuid, p_version integer)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not tr8_private.is_owner() then
    raise exception using errcode = '42501', message = 'This account is not authorized';
  end if;
  if p_id is null or p_version is null or p_version < 1 then
    raise exception using errcode = '22023', message = 'Task identifier and version are required';
  end if;
  delete from public.tr8_tasks where id = p_id and version = p_version;
  if not found then
    if exists (select 1 from public.tr8_tasks where id = p_id) then
      raise exception using errcode = 'PT409', message = 'This task changed. Reload it before deleting';
    end if;
    raise exception using errcode = 'PT404', message = 'Task not found';
  end if;
end;
$$;

-- Keep comments/API identifiers consistent without changing any stored row.
comment on column public.tr8_projects.version is 'Server incremented; use tr8_update_project with the last read version.';
comment on column public.tr8_tasks.version is 'Server incremented; use tr8_update_task/delete_task with the last read version.';

do $verify_preservation$
declare
  v_before record;
  v_after jsonb;
begin
  select * into strict v_before from pg_temp.tr8_rename_snapshot;
  if 'public.tr8_projects'::regclass::oid <> v_before.projects_oid
    or 'public.tr8_tasks'::regclass::oid <> v_before.tasks_oid
    or 'tr8_private.app_config'::regclass::oid <> v_before.config_oid
    or 'public.tr8_tasks_task_number_seq'::regclass::oid <> v_before.sequence_oid
    or (select oid from pg_namespace where nspname = 'tr8_private') <> v_before.private_schema_oid then
    raise exception 'TR8 rename must preserve existing object identities';
  end if;
  if (select md5(coalesce(string_agg(to_jsonb(p)::text, E'\n' order by id), '')) from public.tr8_projects p)
      is distinct from v_before.projects_hash
    or (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from public.tr8_tasks t)
      is distinct from v_before.tasks_hash
    or (select md5(to_jsonb(c)::text) from tr8_private.app_config c where singleton)
      is distinct from v_before.config_hash then
    raise exception 'TR8 rename must preserve every project, task, ID, version and configured owner';
  end if;
  if (select jsonb_build_object('last_value', s.last_value, 'is_called', s.is_called) from public.tr8_tasks_task_number_seq s)
    is distinct from v_before.sequence_state
    or pg_get_serial_sequence('public.tr8_tasks', 'task_number') <> 'public.tr8_tasks_task_number_seq' then
    raise exception 'TR8 rename must preserve task-number allocation and its existing sequence';
  end if;
  select jsonb_agg(jsonb_build_array(p.oid, p.proowner, p.proacl, p.prosecdef, p.provolatile, p.proconfig) order by p.oid)
    into v_after from pg_proc p where p.oid = any(v_before.function_oids);
  if v_after is distinct from v_before.function_security then
    raise exception 'TR8 rename must preserve function ownership, grants and security settings';
  end if;
  select jsonb_agg(jsonb_build_array(c.oid, c.relowner, c.relacl, c.relrowsecurity) order by c.oid)
    into v_after from pg_class c where c.oid in (v_before.projects_oid, v_before.tasks_oid, v_before.config_oid, v_before.sequence_oid);
  if v_after is distinct from v_before.relation_security then
    raise exception 'TR8 rename must preserve table/sequence ownership, grants and RLS';
  end if;
  select jsonb_agg(jsonb_build_array(a.attrelid, a.attnum, a.attacl) order by a.attrelid, a.attnum)
    into v_after from pg_attribute a where a.attnum > 0 and a.attrelid in (v_before.projects_oid, v_before.tasks_oid);
  if v_after is distinct from v_before.column_security then
    raise exception 'TR8 rename must preserve column-level grants';
  end if;
  if exists (select 1 from pg_proc p where p.oid = any(v_before.function_oids) and strpos(p.prosrc, 'gr8r_') > 0)
    or exists (select 1 from pg_namespace where nspname = 'gr8r_private')
    or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and starts_with(p.proname, 'gr8r_'))
    or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and starts_with(c.relname, 'gr8r_'))
    or exists (select 1 from pg_constraint c where c.conrelid in (v_before.projects_oid, v_before.tasks_oid, v_before.config_oid) and starts_with(c.conname, 'gr8r_'))
    or exists (select 1 from pg_policy p where p.polrelid in (v_before.projects_oid, v_before.tasks_oid) and starts_with(p.polname, 'gr8r_'))
    or exists (select 1 from pg_trigger g where g.tgrelid in (v_before.projects_oid, v_before.tasks_oid) and starts_with(g.tgname, 'gr8r_')) then
    raise exception 'TR8 rename left an old database identifier or function-body reference';
  end if;
end;
$verify_preservation$;

-- PostgREST must refresh table/RPC names after the transaction commits.
notify pgrst, 'reload schema';

