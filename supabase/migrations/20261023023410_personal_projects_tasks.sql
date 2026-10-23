-- Personal workspace. The email allowlist starts empty: configure it separately
-- through an administrative connection after the real account is confirmed.
create schema if not exists gr8r_private;
revoke all on schema gr8r_private from public, anon, authenticated;
grant usage on schema gr8r_private to authenticated;
alter default privileges in schema gr8r_private revoke execute on functions from public;

create table gr8r_private.app_config (
  singleton boolean primary key default true check (singleton),
  owner_email text,
  constraint gr8r_owner_email_normalized check (
    owner_email is null or
    (owner_email = lower(btrim(owner_email)) and length(owner_email) between 3 and 320)
  )
);
insert into gr8r_private.app_config (singleton) values (true);
alter table gr8r_private.app_config enable row level security;
revoke all on gr8r_private.app_config from public, anon, authenticated, service_role;

-- This narrow privileged lookup is private because authenticated cannot read
-- auth.users or the administrative allowlist. User-editable metadata is ignored.
create function gr8r_private.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1
    from auth.users as u
    join gr8r_private.app_config as c
      on c.singleton and c.owner_email = lower(u.email)
    where u.id = (select auth.uid())
      and u.email_confirmed_at is not null
      and u.deleted_at is null
  );
$$;
revoke all on function gr8r_private.is_owner() from public, anon, authenticated, service_role;
grant execute on function gr8r_private.is_owner() to authenticated;

-- A safe public invoker endpoint distinguishes an authorized empty workspace
-- from RLS returning no rows for a disallowed account.
create function public.gr8r_check_access()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select gr8r_private.is_owner(); $$;
revoke all on function public.gr8r_check_access() from public, anon, authenticated;
grant execute on function public.gr8r_check_access() to authenticated;

create table public.gr8r_projects (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  code text generated always as ('P-' || upper(substr(replace(id::text, '-', ''), 1, 12))) stored,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text not null default '' check (length(description) <= 20000),
  color text not null default '#5A67D8' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  status text not null default 'planning' check (status in ('planning', 'active', 'hold', 'complete')),
  archived_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (id, owner_id),
  unique (owner_id, code)
);

create table public.gr8r_tasks (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid not null,
  task_number bigint generated always as identity (maxvalue 9007199254740991) unique,
  title text not null check (length(btrim(title)) between 1 and 500),
  description text not null default '' check (length(description) <= 20000),
  status text not null default 'todo' check (status in ('backlog', 'todo', 'progress', 'review', 'done')),
  priority text not null default 'none' check (priority in ('none', 'low', 'medium', 'high', 'urgent')),
  start_date date,
  due_date date,
  position bigint not null default ((extract(epoch from clock_timestamp()) * 1000)::bigint)
    check (position between -9007199254740991 and 9007199254740991),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint gr8r_tasks_dates_valid check (start_date is null or due_date is null or start_date <= due_date),
  constraint gr8r_tasks_project_owner_fk foreign key (project_id, owner_id)
    references public.gr8r_projects (id, owner_id) on delete cascade
);

-- The owner-leading index serves RLS and task loading; the project-leading index
-- also supports the composite FK when a project is removed administratively.
create index gr8r_projects_owner_updated_idx on public.gr8r_projects (owner_id, updated_at desc);
create index gr8r_tasks_owner_position_idx on public.gr8r_tasks (owner_id, position, id);
create index gr8r_tasks_project_owner_idx on public.gr8r_tasks (project_id, owner_id);

create function gr8r_private.guard_project()
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

create function gr8r_private.guard_task()
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
  from public.gr8r_projects as p
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

revoke all on function gr8r_private.guard_project() from public, anon, authenticated, service_role;
revoke all on function gr8r_private.guard_task() from public, anon, authenticated, service_role;
create trigger gr8r_projects_guard before insert or update on public.gr8r_projects
  for each row execute function gr8r_private.guard_project();
create trigger gr8r_tasks_guard before insert or update on public.gr8r_tasks
  for each row execute function gr8r_private.guard_task();

alter table public.gr8r_projects enable row level security;
alter table public.gr8r_tasks enable row level security;

create policy gr8r_projects_select on public.gr8r_projects for select to authenticated
  using (owner_id = (select auth.uid()) and (select gr8r_private.is_owner()));
create policy gr8r_projects_insert on public.gr8r_projects for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select gr8r_private.is_owner()));
create policy gr8r_projects_update on public.gr8r_projects for update to authenticated
  using (owner_id = (select auth.uid()) and (select gr8r_private.is_owner()))
  with check (owner_id = (select auth.uid()) and (select gr8r_private.is_owner()));
create policy gr8r_tasks_select on public.gr8r_tasks for select to authenticated
  using (owner_id = (select auth.uid()) and (select gr8r_private.is_owner()));
create policy gr8r_tasks_insert on public.gr8r_tasks for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select gr8r_private.is_owner()));
create policy gr8r_tasks_update on public.gr8r_tasks for update to authenticated
  using (owner_id = (select auth.uid()) and (select gr8r_private.is_owner()))
  with check (owner_id = (select auth.uid()) and (select gr8r_private.is_owner()));
create policy gr8r_tasks_delete on public.gr8r_tasks for delete to authenticated
  using (owner_id = (select auth.uid()) and (select gr8r_private.is_owner()));

revoke all on public.gr8r_projects, public.gr8r_tasks from public, anon, authenticated;
revoke all on sequence public.gr8r_tasks_task_number_seq from public, anon, authenticated;
grant select on public.gr8r_projects, public.gr8r_tasks to authenticated;
grant insert (id, owner_id, name, description, color, status, archived_at)
  on public.gr8r_projects to authenticated;
grant update (name, description, color, status, archived_at)
  on public.gr8r_projects to authenticated;
grant insert (id, owner_id, project_id, title, description, status, priority, start_date, due_date, position)
  on public.gr8r_tasks to authenticated;
grant update (title, description, status, priority, start_date, due_date, position)
  on public.gr8r_tasks to authenticated;
grant delete on public.gr8r_tasks to authenticated;
grant usage on sequence public.gr8r_tasks_task_number_seq to authenticated;

create function public.gr8r_create_project(
  p_id uuid, p_name text, p_description text, p_color text, p_status text
)
returns public.gr8r_projects
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.gr8r_projects;
begin
  if not gr8r_private.is_owner() then
    raise exception using errcode = '42501', message = 'This account is not authorized';
  end if;
  if p_id is null or p_name is null or p_description is null or p_color is null or p_status is null then
    raise exception using errcode = '22023', message = 'Project fields are required';
  end if;
  insert into public.gr8r_projects (id, owner_id, name, description, color, status)
  values (p_id, auth.uid(), btrim(p_name), p_description, p_color, p_status)
  on conflict (id) do nothing
  returning * into v_row;
  if found then return v_row; end if;
  select * into v_row from public.gr8r_projects where id = p_id;
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

create function public.gr8r_create_task(
  p_id uuid, p_project_id uuid, p_title text, p_description text, p_status text,
  p_priority text, p_start_date date, p_due_date date
)
returns public.gr8r_tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.gr8r_tasks;
begin
  if not gr8r_private.is_owner() then
    raise exception using errcode = '42501', message = 'This account is not authorized';
  end if;
  if p_id is null or p_project_id is null or p_title is null or p_description is null
    or p_status is null or p_priority is null then
    raise exception using errcode = '22023', message = 'Task fields are required';
  end if;
  -- Return an existing compatible request before checking archival: a successful
  -- create can be retried after its project has subsequently been archived.
  select * into v_row from public.gr8r_tasks where id = p_id;
  if not found then
    insert into public.gr8r_tasks (
      id, owner_id, project_id, title, description, status, priority, start_date, due_date
    ) values (
      p_id, auth.uid(), p_project_id, btrim(p_title), p_description, p_status, p_priority, p_start_date, p_due_date
    ) on conflict (id) do nothing returning * into v_row;
    if found then return v_row; end if;
    select * into v_row from public.gr8r_tasks where id = p_id;
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

create function public.gr8r_update_project(p_id uuid, p_version integer, p_patch jsonb)
returns public.gr8r_projects
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.gr8r_projects;
  v_key text;
  v_type text;
begin
  if not gr8r_private.is_owner() then
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
  update public.gr8r_projects as p set
    name = case when p_patch ? 'name' then btrim(p_patch ->> 'name') else p.name end,
    description = case when p_patch ? 'description' then p_patch ->> 'description' else p.description end,
    color = case when p_patch ? 'color' then p_patch ->> 'color' else p.color end,
    status = case when p_patch ? 'status' then p_patch ->> 'status' else p.status end,
    archived_at = case when p_patch ? 'archived_at' then (p_patch ->> 'archived_at')::timestamptz else p.archived_at end
  where p.id = p_id and p.version = p_version returning p.* into v_row;
  if not found then
    if exists (select 1 from public.gr8r_projects where id = p_id) then
      raise exception using errcode = 'PT409', message = 'This project changed. Reload it before saving';
    end if;
    raise exception using errcode = 'PT404', message = 'Project not found';
  end if;
  return v_row;
end;
$$;

create function public.gr8r_update_task(p_id uuid, p_version integer, p_patch jsonb)
returns public.gr8r_tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.gr8r_tasks;
  v_key text;
  v_type text;
begin
  if not gr8r_private.is_owner() then
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
  update public.gr8r_tasks as t set
    title = case when p_patch ? 'title' then btrim(p_patch ->> 'title') else t.title end,
    description = case when p_patch ? 'description' then p_patch ->> 'description' else t.description end,
    status = case when p_patch ? 'status' then p_patch ->> 'status' else t.status end,
    priority = case when p_patch ? 'priority' then p_patch ->> 'priority' else t.priority end,
    start_date = case when p_patch ? 'start_date' then (p_patch ->> 'start_date')::date else t.start_date end,
    due_date = case when p_patch ? 'due_date' then (p_patch ->> 'due_date')::date else t.due_date end,
    position = case when p_patch ? 'position' then (p_patch ->> 'position')::bigint else t.position end
  where t.id = p_id and t.version = p_version returning t.* into v_row;
  if not found then
    if exists (select 1 from public.gr8r_tasks where id = p_id) then
      raise exception using errcode = 'PT409', message = 'This task changed. Reload it before saving';
    end if;
    raise exception using errcode = 'PT404', message = 'Task not found';
  end if;
  return v_row;
end;
$$;

create function public.gr8r_delete_task(p_id uuid, p_version integer)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not gr8r_private.is_owner() then
    raise exception using errcode = '42501', message = 'This account is not authorized';
  end if;
  if p_id is null or p_version is null or p_version < 1 then
    raise exception using errcode = '22023', message = 'Task identifier and version are required';
  end if;
  delete from public.gr8r_tasks where id = p_id and version = p_version;
  if not found then
    if exists (select 1 from public.gr8r_tasks where id = p_id) then
      raise exception using errcode = 'PT409', message = 'This task changed. Reload it before deleting';
    end if;
    raise exception using errcode = 'PT404', message = 'Task not found';
  end if;
end;
$$;

revoke all on function public.gr8r_create_project(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.gr8r_create_task(uuid, uuid, text, text, text, text, date, date) from public, anon, authenticated;
revoke all on function public.gr8r_update_project(uuid, integer, jsonb) from public, anon, authenticated;
revoke all on function public.gr8r_update_task(uuid, integer, jsonb) from public, anon, authenticated;
revoke all on function public.gr8r_delete_task(uuid, integer) from public, anon, authenticated;
grant execute on function public.gr8r_create_project(uuid, text, text, text, text) to authenticated;
grant execute on function public.gr8r_create_task(uuid, uuid, text, text, text, text, date, date) to authenticated;
grant execute on function public.gr8r_update_project(uuid, integer, jsonb) to authenticated;
grant execute on function public.gr8r_update_task(uuid, integer, jsonb) to authenticated;
grant execute on function public.gr8r_delete_task(uuid, integer) to authenticated;

comment on function gr8r_private.is_owner() is 'Private confirmed-email allowlist lookup; never trusts client metadata.';
comment on table gr8r_private.app_config is 'Administrative singleton. Null owner_email denies all application accounts.';
comment on column public.gr8r_tasks.task_number is 'Global server sequence, unique and JavaScript-safe; gaps are expected.';
comment on column public.gr8r_projects.version is 'Server incremented; use gr8r_update_project with the last read version.';
comment on column public.gr8r_tasks.version is 'Server incremented; use gr8r_update_task/delete_task with the last read version.';
