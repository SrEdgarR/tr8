-- Stage 1: workspace identity and a closed, versioned write boundary.
-- Run in one transaction during the coordinated client cutover. The relation
-- locks also keep the historical backfill away from ordinary task triggers.
lock table public.tr8_projects, public.tr8_tasks, tr8_private.app_config
  in access exclusive mode nowait;

create temporary table tr8_stage1_snapshot on commit drop as
select
  'public.tr8_projects'::regclass::oid as projects_oid,
  'public.tr8_tasks'::regclass::oid as tasks_oid,
  pg_get_serial_sequence('public.tr8_tasks', 'task_number')::regclass::oid as sequence_oid,
  (select md5(coalesce(string_agg(to_jsonb(p)::text, E'\n' order by id), '')) from public.tr8_projects p) as projects_hash,
  (select md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' order by id), '')) from public.tr8_tasks t) as tasks_hash,
  (select jsonb_build_object('last_value', s.last_value, 'is_called', s.is_called)
    from public.tr8_tasks_task_number_seq s) as sequence_state,
  (select to_jsonb(s) - 'seqrelid' from pg_catalog.pg_sequence s
    where s.seqrelid = 'public.tr8_tasks_task_number_seq'::regclass) as sequence_config;

alter table tr8_private.app_config
  add column external_invites_enabled boolean not null default false;

create table tr8_private.app_users (
  user_id uuid primary key references auth.users(id) on delete restrict,
  enabled boolean not null default true,
  display_name text not null default 'Usuario' check (length(btrim(display_name)) between 1 and 120),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);

create table tr8_private.workspaces (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  kind text not null check (kind in ('personal', 'team')),
  owner_id uuid not null references tr8_private.app_users(user_id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 120),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);
create unique index tr8_workspaces_one_personal on tr8_private.workspaces(owner_id) where kind = 'personal';
create index tr8_workspaces_owner on tr8_private.workspaces(owner_id, id);

create table tr8_private.workspace_authz_state (
  workspace_id uuid primary key references tr8_private.workspaces(id) on delete restrict,
  version bigint not null default 1 check (version > 0)
);

create table tr8_private.workspace_members (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  workspace_id uuid not null references tr8_private.workspaces(id) on delete restrict,
  user_id uuid not null references tr8_private.app_users(user_id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'removed')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique(workspace_id, user_id), unique(workspace_id, id)
);
create index tr8_members_by_user on tr8_private.workspace_members(user_id, status, workspace_id);

create table tr8_private.permission_catalog (
  permission text primary key
);
insert into tr8_private.permission_catalog(permission) values
  ('team.settings.edit'), ('member.read'), ('member.invite'), ('member.remove'),
  ('role.read'), ('role.manage'), ('role.assign'), ('project.create'),
  ('project.read'), ('project.edit'), ('project.archive'), ('project.access.manage'),
  ('task.read'), ('task.create'), ('task.edit'), ('task.delete'), ('task.assign'), ('audit.read');

create table tr8_private.workspace_roles (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  workspace_id uuid not null references tr8_private.workspaces(id) on delete restrict,
  name text not null check(length(btrim(name)) between 1 and 120),
  template_key text check(template_key in ('read', 'collaborator', 'admin')),
  version integer not null default 1 check(version > 0),
  unique(workspace_id, id), unique(workspace_id, template_key)
);
create table tr8_private.role_permissions (
  workspace_id uuid not null,
  role_id uuid not null,
  permission text not null references tr8_private.permission_catalog(permission) on delete restrict,
  primary key(workspace_id, role_id, permission),
  foreign key(workspace_id, role_id) references tr8_private.workspace_roles(workspace_id, id) on delete restrict
);
create table tr8_private.member_roles (
  workspace_id uuid not null,
  member_id uuid not null,
  role_id uuid not null,
  primary key(workspace_id, member_id, role_id),
  foreign key(workspace_id, member_id) references tr8_private.workspace_members(workspace_id, id) on delete restrict,
  foreign key(workspace_id, role_id) references tr8_private.workspace_roles(workspace_id, id) on delete restrict
);

-- Rename in place: legacy clients fail closed instead of receiving collaborative
-- rows through the old global list endpoints. The identity sequence is retained.
alter table public.tr8_projects rename to tr8_workspace_projects;
alter table public.tr8_tasks rename to tr8_workspace_tasks;
alter table public.tr8_workspace_projects add column workspace_id uuid;
alter table public.tr8_workspace_tasks add column workspace_id uuid;

-- Only the trusted historical allowlist may seed application access. No trigger
-- on Auth, email metadata or successful login can enable an arbitrary account.
do $trusted_identity_guard$
begin
  if (select count(*) from auth.users u join tr8_private.app_config c
    on c.singleton and c.owner_email = lower(u.email)
    where u.email_confirmed_at is not null and u.deleted_at is null
      and not coalesce(u.is_anonymous, false)
      and (u.banned_until is null or u.banned_until <= statement_timestamp())) > 1 then
    raise exception 'Historical allowlist does not identify one trusted account; cutover aborted';
  end if;
end;
$trusted_identity_guard$;
insert into tr8_private.app_users(user_id)
select u.id from auth.users u join tr8_private.app_config c
  on c.singleton and c.owner_email = lower(u.email)
where u.email_confirmed_at is not null and u.deleted_at is null
  and not coalesce(u.is_anonymous, false)
  and (u.banned_until is null or u.banned_until <= statement_timestamp());

do $bootstrap_guard$
begin
  if exists (select 1 from public.tr8_workspace_projects p
    where not exists(select 1 from tr8_private.app_users a where a.user_id = p.owner_id))
    or exists (select 1 from public.tr8_workspace_tasks t
    where not exists(select 1 from tr8_private.app_users a where a.user_id = t.owner_id)) then
    raise exception 'Historical rows have no confirmed trusted application owner; cutover aborted';
  end if;
end;
$bootstrap_guard$;

insert into tr8_private.workspaces(kind, owner_id, name)
select 'personal', a.user_id, 'Mi espacio' from tr8_private.app_users a;
insert into tr8_private.workspace_authz_state(workspace_id)
select id from tr8_private.workspaces;
insert into tr8_private.workspace_members(workspace_id, user_id)
select id, owner_id from tr8_private.workspaces;

-- Disable only the ordinary update triggers while the locked, administrative
-- backfill runs. Re-enable them before any access is granted or lock released.
alter table public.tr8_workspace_projects disable trigger tr8_projects_guard;
alter table public.tr8_workspace_tasks disable trigger tr8_tasks_guard;
update public.tr8_workspace_projects p set workspace_id = w.id
from tr8_private.workspaces w where w.kind = 'personal' and w.owner_id = p.owner_id;
update public.tr8_workspace_tasks t set workspace_id = p.workspace_id
from public.tr8_workspace_projects p where p.id = t.project_id;
alter table public.tr8_workspace_projects enable trigger tr8_projects_guard;
alter table public.tr8_workspace_tasks enable trigger tr8_tasks_guard;

alter table public.tr8_workspace_projects alter column workspace_id set not null;
alter table public.tr8_workspace_tasks alter column workspace_id set not null;
alter table public.tr8_workspace_projects add constraint tr8_projects_workspace_fk
  foreign key(workspace_id) references tr8_private.workspaces(id) on delete restrict;
alter table public.tr8_workspace_projects add constraint tr8_projects_workspace_id_unique unique(workspace_id, id);
alter table public.tr8_workspace_projects add constraint tr8_projects_workspace_code_unique unique(workspace_id, code);
alter table public.tr8_workspace_tasks add constraint tr8_tasks_workspace_project_fk
  foreign key(workspace_id, project_id) references public.tr8_workspace_projects(workspace_id, id) on delete restrict;

-- Auth account removal must never cascade into projects created for a team.
-- Keep owner_id as immutable author provenance; it no longer grants access.
alter table public.tr8_workspace_tasks drop constraint tr8_tasks_project_owner_fk;
alter table public.tr8_workspace_projects drop constraint tr8_projects_owner_id_fkey;
alter table public.tr8_workspace_tasks drop constraint tr8_tasks_owner_id_fkey;
alter table public.tr8_workspace_projects add constraint tr8_projects_author_fk
  foreign key(owner_id) references tr8_private.app_users(user_id) on delete restrict;
alter table public.tr8_workspace_tasks add constraint tr8_tasks_author_fk
  foreign key(owner_id) references tr8_private.app_users(user_id) on delete restrict;
alter table public.tr8_workspace_projects drop constraint tr8_projects_owner_id_code_key;
create index tr8_projects_workspace_updated on public.tr8_workspace_projects(workspace_id, updated_at desc, id);
create index tr8_tasks_workspace_position on public.tr8_workspace_tasks(workspace_id, position, id);
create index tr8_tasks_workspace_project on public.tr8_workspace_tasks(workspace_id, project_id, id);

create table tr8_private.project_access (
  workspace_id uuid not null,
  project_id uuid not null,
  member_id uuid not null,
  access_level text not null check(access_level in ('read', 'write')),
  version integer not null default 1 check(version > 0),
  primary key(workspace_id, project_id, member_id),
  foreign key(workspace_id, project_id) references public.tr8_workspace_projects(workspace_id, id) on delete restrict,
  foreign key(workspace_id, member_id) references tr8_private.workspace_members(workspace_id, id) on delete restrict
);
create index tr8_access_by_member on tr8_private.project_access(workspace_id, member_id, project_id);

create table tr8_private.invitations (
  id uuid primary key,
  workspace_id uuid not null references tr8_private.workspaces(id) on delete restrict,
  email text not null check(email = lower(btrim(email)) and length(email) between 3 and 320),
  token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid not null references tr8_private.app_users(user_id) on delete restrict,
  role_id uuid not null,
  status text not null default 'pending' check(status in ('pending', 'accepted', 'revoked')),
  expires_at timestamptz not null,
  accepted_by uuid references tr8_private.app_users(user_id) on delete restrict,
  accepted_at timestamptz,
  version integer not null default 1 check(version > 0),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  foreign key(workspace_id, role_id) references tr8_private.workspace_roles(workspace_id, id) on delete restrict,
  check((status = 'accepted') = (accepted_by is not null and accepted_at is not null))
);
create index tr8_invitations_workspace on tr8_private.invitations(workspace_id, created_at desc, id);

create table tr8_private.workspace_activity (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references tr8_private.workspaces(id) on delete restrict,
  project_id uuid,
  actor_id uuid not null references tr8_private.app_users(user_id) on delete restrict,
  action text not null,
  resource_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  foreign key(workspace_id, project_id) references public.tr8_workspace_projects(workspace_id, id) on delete restrict
);
create index tr8_activity_workspace_time on tr8_private.workspace_activity(workspace_id, created_at desc, id);

-- No private table is a Data API surface. RLS with no client policies is a
-- second boundary in addition to explicit revocation of table/sequence grants.
do $private_tables$
declare v_table text;
begin
  foreach v_table in array array['app_users','workspaces','workspace_authz_state','workspace_members',
    'permission_catalog','workspace_roles','role_permissions','member_roles','project_access','invitations','workspace_activity'] loop
    execute format('alter table tr8_private.%I enable row level security', v_table);
    execute format('revoke all on table tr8_private.%I from public, anon, authenticated, service_role', v_table);
  end loop;
end;
$private_tables$;
revoke all on sequence tr8_private.workspace_activity_id_seq from public, anon, authenticated, service_role;

-- Helpers accepting an arbitrary user are internal only. Session-facing helpers
-- expose only the actor's own authorization decision, never somebody else's.
create function tr8_private.v2_user_live(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from auth.users u where u.id = p_user_id
    and u.email_confirmed_at is not null and u.deleted_at is null
    and not coalesce(u.is_anonymous, false)
    and (u.banned_until is null or u.banned_until <= statement_timestamp()));
$$;
create function tr8_private.v2_actor_enabled()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null
    and tr8_private.v2_user_live((select auth.uid()))
    and exists(select 1 from tr8_private.app_users a where a.user_id = (select auth.uid()) and a.enabled);
$$;
create function tr8_private.v2_permissions_for(p_workspace_id uuid, p_user_id uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  select case when not tr8_private.v2_user_live(p_user_id)
    or not exists(select 1 from tr8_private.app_users a where a.user_id = p_user_id and a.enabled)
    then array[]::text[]
    when exists(select 1 from tr8_private.workspaces w where w.id = p_workspace_id and w.owner_id = p_user_id)
    then array(select c.permission from tr8_private.permission_catalog c order by c.permission)
    else array(select distinct rp.permission
      from tr8_private.workspace_members m
      join tr8_private.member_roles mr on mr.workspace_id = m.workspace_id and mr.member_id = m.id
      join tr8_private.role_permissions rp on rp.workspace_id = mr.workspace_id and rp.role_id = mr.role_id
      join tr8_private.workspaces w on w.id = m.workspace_id and w.kind = 'team'
      where m.workspace_id = p_workspace_id and m.user_id = p_user_id and m.status = 'active'
      order by rp.permission) end;
$$;
create function tr8_private.v2_has_permission(p_workspace_id uuid, p_permission text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_permission = any(tr8_private.v2_permissions_for(p_workspace_id, (select auth.uid()))), false);
$$;
create function tr8_private.v2_can_read_project(p_workspace_id uuid, p_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select tr8_private.v2_actor_enabled() and exists(
    select 1 from public.tr8_workspace_projects p join tr8_private.workspaces w on w.id = p.workspace_id
    where p.id = p_project_id and p.workspace_id = p_workspace_id
      and (w.owner_id = (select auth.uid()) or (w.kind = 'team'
        and tr8_private.v2_has_permission(w.id, 'project.read')
        and exists(select 1 from tr8_private.workspace_members m
          join tr8_private.project_access a on a.workspace_id = m.workspace_id and a.member_id = m.id
          where m.workspace_id = w.id and m.user_id = (select auth.uid()) and m.status = 'active'
            and a.project_id = p.id))));
$$;

create function tr8_private.v2_require_actor()
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if not tr8_private.v2_actor_enabled() then
    raise exception using errcode = '42501', message = 'This account is not authorized';
  end if;
end;
$$;
create function tr8_private.v2_lock_workspace(p_workspace_id uuid, p_exclusive boolean default false)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '25000', message = 'This operation requires read committed isolation';
  end if;
  if p_exclusive then
    perform 1 from tr8_private.workspace_authz_state s where s.workspace_id = p_workspace_id for update;
  else
    perform 1 from tr8_private.workspace_authz_state s where s.workspace_id = p_workspace_id for share;
  end if;
  if not found then
    raise exception using errcode = 'PT404', message = 'Resource unavailable';
  end if;
end;
$$;
create function tr8_private.v2_require_workspace(p_workspace_id uuid, p_permission text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  -- READ COMMITTED is required: the authorization SELECT after this statement's
  -- lock sees the membership state committed by a preceding revocation.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '25000', message = 'This operation requires read committed isolation';
  end if;
  perform tr8_private.v2_lock_workspace(p_workspace_id);
  perform tr8_private.v2_require_actor();
  if not tr8_private.v2_has_permission(p_workspace_id, p_permission) then
    raise exception using errcode = 'PT404', message = 'Resource unavailable';
  end if;
end;
$$;
create function tr8_private.v2_require_project(p_workspace_id uuid, p_project_id uuid, p_permission text, p_write boolean)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform tr8_private.v2_require_workspace(p_workspace_id, p_permission);
  if not tr8_private.v2_can_read_project(p_workspace_id, p_project_id)
    or (p_permission like 'task.%' and not tr8_private.v2_has_permission(p_workspace_id, 'task.read'))
    or (p_write and not exists(
      select 1 from tr8_private.workspaces w where w.id = p_workspace_id and
      (w.owner_id = auth.uid() or exists(select 1 from tr8_private.workspace_members m
        join tr8_private.project_access a on a.workspace_id = m.workspace_id and a.member_id = m.id
        where m.workspace_id = w.id and m.user_id = auth.uid() and m.status = 'active'
          and a.project_id = p_project_id and a.access_level = 'write')))) then
    raise exception using errcode = 'PT404', message = 'Resource unavailable';
  end if;
end;
$$;

-- Called only from trusted enabled-user bootstrap or valid invitation acceptance.
-- Lock the app-user row to serialize personal creation and team-creation retries.
create function tr8_private.v2_ensure_personal(p_user_id uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform 1 from tr8_private.app_users a where a.user_id = p_user_id and a.enabled for update;
  if not found or not tr8_private.v2_user_live(p_user_id) then
    raise exception using errcode = '42501', message = 'This account is not authorized';
  end if;
  select w.id into v_id from tr8_private.workspaces w where w.kind = 'personal' and w.owner_id = p_user_id;
  if not found then
    insert into tr8_private.workspaces(kind, owner_id, name) values('personal', p_user_id, 'Mi espacio') returning id into v_id;
    insert into tr8_private.workspace_authz_state(workspace_id) values(v_id);
    insert into tr8_private.workspace_members(workspace_id, user_id) values(v_id, p_user_id);
  end if;
  return v_id;
end;
$$;
create function tr8_private.v2_workspace_json(p_workspace_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', w.id, 'kind', w.kind, 'name', w.name,
    'owner_id', w.owner_id, 'version', w.version,
    'permissions', to_jsonb(tr8_private.v2_permissions_for(w.id, (select auth.uid()))))
  from tr8_private.workspaces w where w.id = p_workspace_id
    and tr8_private.v2_actor_enabled()
    and (w.owner_id = (select auth.uid()) or (w.kind = 'team' and exists(
      select 1 from tr8_private.workspace_members m where m.workspace_id = w.id
        and m.user_id = (select auth.uid()) and m.status = 'active')));
$$;
create function tr8_private.v2_get_context()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_personal uuid; v_spaces jsonb;
begin
  perform tr8_private.v2_require_actor();
  v_personal := tr8_private.v2_ensure_personal(auth.uid());
  select coalesce(jsonb_agg(tr8_private.v2_workspace_json(w.id) order by w.kind, w.created_at, w.id), '[]'::jsonb)
    into v_spaces from tr8_private.workspaces w
    where w.owner_id = auth.uid() or (w.kind = 'team' and exists(
      select 1 from tr8_private.workspace_members m where m.workspace_id = w.id
        and m.user_id = auth.uid() and m.status = 'active'));
  return jsonb_build_object('contract_version', 2, 'personal_workspace_id', v_personal,
    'workspaces', v_spaces, 'external_invites_enabled',
    coalesce((select c.external_invites_enabled from tr8_private.app_config c where c.singleton), false));
end;
$$;

create function tr8_private.v2_create_team(p_id uuid, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row tr8_private.workspaces; v_role uuid; v_template text;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '25000', message = 'This operation requires read committed isolation';
  end if;
  perform tr8_private.v2_require_actor();
  if p_id is null or p_name is null or length(btrim(p_name)) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'A valid team identifier and name are required';
  end if;
  perform 1 from tr8_private.app_users a where a.user_id = auth.uid() for update;
  -- Recheck after the serialization lock before returning an idempotent result.
  perform tr8_private.v2_require_actor();
  select * into v_row from tr8_private.workspaces w where w.id = p_id;
  if found then
    if v_row.owner_id <> auth.uid() or v_row.kind <> 'team' or v_row.name <> btrim(p_name) then
      raise exception using errcode = 'PT409', message = 'The request identifier is unavailable';
    end if;
    return tr8_private.v2_workspace_json(p_id);
  end if;
  insert into tr8_private.workspaces(id, kind, owner_id, name) values(p_id, 'team', auth.uid(), btrim(p_name));
  insert into tr8_private.workspace_authz_state(workspace_id) values(p_id);
  insert into tr8_private.workspace_members(workspace_id, user_id) values(p_id, auth.uid());
  foreach v_template in array array['read', 'collaborator', 'admin'] loop
    insert into tr8_private.workspace_roles(workspace_id, name, template_key)
    values(p_id, case v_template when 'read' then 'Lectura' when 'collaborator' then 'Colaborador' else 'Administración' end,
      v_template) returning id into v_role;
    insert into tr8_private.role_permissions(workspace_id, role_id, permission)
    select p_id, v_role, c.permission from tr8_private.permission_catalog c where
      v_template = 'admin' or c.permission = any(case when v_template = 'read'
        then array['member.read','project.read','task.read']
        else array['member.read','project.read','task.read','project.create','project.edit','task.create','task.edit','task.assign'] end);
  end loop;
  insert into tr8_private.workspace_activity(workspace_id, actor_id, action, resource_id)
    values(p_id, auth.uid(), 'team.created', p_id);
  return tr8_private.v2_workspace_json(p_id);
end;
$$;

create function tr8_private.v2_list_members(p_workspace_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform tr8_private.v2_require_workspace(p_workspace_id, 'member.read');
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'user_id', m.user_id,
    'display_name', a.display_name, 'status', m.status, 'version', m.version,
    'is_owner', w.owner_id = m.user_id, 'roles', coalesce((select jsonb_agg(jsonb_build_object(
      'id', r.id, 'name', r.name, 'template_key', r.template_key) order by r.name, r.id)
      from tr8_private.member_roles mr join tr8_private.workspace_roles r
        on r.workspace_id = mr.workspace_id and r.id = mr.role_id
      where mr.workspace_id = m.workspace_id and mr.member_id = m.id), '[]'::jsonb)) order by m.created_at, m.id), '[]'::jsonb)
    into v_result from tr8_private.workspace_members m
    join tr8_private.app_users a on a.user_id = m.user_id
    join tr8_private.workspaces w on w.id = m.workspace_id
    where m.workspace_id = p_workspace_id and m.status = 'active';
  return v_result;
end;
$$;
create function tr8_private.v2_list_invitations(p_workspace_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform tr8_private.v2_require_workspace(p_workspace_id, 'member.invite');
  -- Stage 1 intentionally exposes recipient addresses only to the team owner.
  if not exists(select 1 from tr8_private.workspaces w where w.id = p_workspace_id and w.kind = 'team' and w.owner_id = auth.uid()) then
    raise exception using errcode = 'PT404', message = 'Resource unavailable';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'status', i.status,
    'expires_at', i.expires_at, 'version', i.version, 'created_at', i.created_at) order by i.created_at desc, i.id), '[]'::jsonb)
    into v_result from tr8_private.invitations i where i.workspace_id = p_workspace_id;
  return v_result;
end;
$$;

-- Registration and invite sending stay disabled until a verified mail channel
-- is provisioned. The switch is private/admin-only, never an API patch field.
create function tr8_private.v2_require_invitations_enabled()
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if not coalesce((select c.external_invites_enabled from tr8_private.app_config c where c.singleton), false) then
    raise exception using errcode = '42501', message = 'External invitations are not enabled';
  end if;
end;
$$;
create function tr8_private.v2_create_invitation(p_workspace_id uuid, p_id uuid, p_email text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_email text := lower(btrim(p_email)); v_token text; v_row tr8_private.invitations; v_role uuid;
begin
  perform tr8_private.v2_require_invitations_enabled();
  if p_id is null or p_email is null or length(v_email) not between 3 and 320
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'A valid invitation identifier and email are required';
  end if;
  perform tr8_private.v2_lock_workspace(p_workspace_id, true);
  perform tr8_private.v2_require_invitations_enabled();
  perform tr8_private.v2_require_actor();
  if not exists(select 1 from tr8_private.workspaces w where w.id = p_workspace_id and w.kind = 'team' and w.owner_id = auth.uid()) then
    raise exception using errcode = 'PT404', message = 'Resource unavailable';
  end if;
  select * into v_row from tr8_private.invitations i where i.id = p_id;
  if found then
    if v_row.workspace_id <> p_workspace_id or v_row.invited_by <> auth.uid() or v_row.email <> v_email then
      raise exception using errcode = 'PT409', message = 'The request identifier is unavailable';
    end if;
    return jsonb_build_object('id', v_row.id, 'token', null, 'status', v_row.status,
      'expires_at', v_row.expires_at, 'version', v_row.version);
  end if;
  select r.id into v_role from tr8_private.workspace_roles r
    where r.workspace_id = p_workspace_id and r.template_key = 'read';
  if not found then raise exception using errcode = '55000', message = 'Invitation role unavailable'; end if;
  -- Two independent v4 UUIDs provide 244 random bits. Only SHA-256 is durable.
  -- A lost response requires a newly issued invitation, never token recovery.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into tr8_private.invitations(id, workspace_id, email, token_hash, invited_by, role_id, expires_at)
    values(p_id, p_workspace_id, v_email, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid(), v_role,
      statement_timestamp() + interval '7 days') returning * into v_row;
  insert into tr8_private.workspace_activity(workspace_id, actor_id, action, resource_id)
    values(p_workspace_id, auth.uid(), 'invitation.created', p_id);
  return jsonb_build_object('id', v_row.id, 'token', v_token, 'status', v_row.status,
    'expires_at', v_row.expires_at, 'version', v_row.version);
end;
$$;
create function tr8_private.v2_revoke_invitation(p_workspace_id uuid, p_id uuid, p_version integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row tr8_private.invitations;
begin
  if p_id is null or p_version is null or p_version < 1 then
    raise exception using errcode = '22023', message = 'Invitation identifier and version are required';
  end if;
  perform tr8_private.v2_lock_workspace(p_workspace_id, true);
  perform tr8_private.v2_require_actor();
  if not exists(select 1 from tr8_private.workspaces w where w.id = p_workspace_id and w.kind = 'team' and w.owner_id = auth.uid()) then
    raise exception using errcode = 'PT404', message = 'Resource unavailable';
  end if;
  select * into v_row from tr8_private.invitations i where i.id = p_id and i.workspace_id = p_workspace_id for update;
  if not found then raise exception using errcode = 'PT404', message = 'Resource unavailable'; end if;
  if v_row.version <> p_version or v_row.status <> 'pending' then
    raise exception using errcode = 'PT409', message = 'This invitation changed. Reload it before saving';
  end if;
  update tr8_private.invitations set status = 'revoked', version = version + 1, updated_at = statement_timestamp()
    where id = p_id returning * into v_row;
  insert into tr8_private.workspace_activity(workspace_id, actor_id, action, resource_id)
    values(p_workspace_id, auth.uid(), 'invitation.revoked', p_id);
  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'version', v_row.version);
end;
$$;
create function tr8_private.v2_accept_invitation(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_workspace uuid; v_hash text; v_row tr8_private.invitations; v_email text; v_member uuid; v_permissions text[];
begin
  perform tr8_private.v2_require_invitations_enabled();
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '25000', message = 'This operation requires read committed isolation';
  end if;
  if auth.uid() is null or not tr8_private.v2_user_live(auth.uid()) or p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end if;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  -- Discover scope without a row lock, then obey workspace -> invitation order.
  select i.workspace_id into v_workspace from tr8_private.invitations i where i.token_hash = v_hash;
  if not found then raise exception using errcode = '42501', message = 'Invitation unavailable'; end if;
  perform tr8_private.v2_lock_workspace(v_workspace, true);
  perform tr8_private.v2_require_invitations_enabled();
  if not tr8_private.v2_user_live(auth.uid()) then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end if;
  select * into v_row from tr8_private.invitations i where i.token_hash = v_hash for update;
  select lower(u.email) into v_email from auth.users u where u.id = auth.uid()
    and u.email_confirmed_at is not null and u.deleted_at is null;
  if v_row.email is distinct from v_email then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end if;
  if v_row.status = 'accepted' then
    if v_row.accepted_by <> auth.uid() or not tr8_private.v2_actor_enabled() then
      raise exception using errcode = '42501', message = 'Invitation unavailable';
    end if;
    select m.id into v_member from tr8_private.workspace_members m
      where m.workspace_id = v_workspace and m.user_id = auth.uid() and m.status = 'active';
    if not found then raise exception using errcode = '42501', message = 'Invitation unavailable'; end if;
    return jsonb_build_object('workspace_id', v_workspace, 'member_id', v_member, 'status', 'accepted');
  end if;
  if v_row.status <> 'pending' or v_row.expires_at <= statement_timestamp()
    or not tr8_private.v2_user_live(v_row.invited_by)
    or not exists(select 1 from tr8_private.workspaces w where w.id = v_workspace and w.kind = 'team' and w.owner_id = v_row.invited_by) then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end if;
  v_permissions := tr8_private.v2_permissions_for(v_workspace, v_row.invited_by);
  if not ('member.invite' = any(v_permissions)) or exists(
    select 1 from tr8_private.role_permissions rp where rp.workspace_id = v_workspace and rp.role_id = v_row.role_id
      and not (rp.permission = any(v_permissions))) then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end if;
  -- Existing administratively disabled accounts are never re-enabled by a token.
  if exists(select 1 from tr8_private.app_users a where a.user_id = auth.uid() and not a.enabled) then
    raise exception using errcode = '42501', message = 'Invitation unavailable';
  end if;
  insert into tr8_private.app_users(user_id) values(auth.uid()) on conflict(user_id) do nothing;
  perform tr8_private.v2_ensure_personal(auth.uid());
  select m.id into v_member from tr8_private.workspace_members m
    where m.workspace_id = v_workspace and m.user_id = auth.uid() for update;
  if found then
    if exists(select 1 from tr8_private.workspace_members m where m.id = v_member and m.status <> 'active') then
      -- Stage 2 owns explicit member reinstatement and its previous role/ACL cleanup.
      raise exception using errcode = '42501', message = 'Invitation unavailable';
    end if;
  else
    insert into tr8_private.workspace_members(workspace_id, user_id) values(v_workspace, auth.uid()) returning id into v_member;
  end if;
  insert into tr8_private.member_roles(workspace_id, member_id, role_id)
    values(v_workspace, v_member, v_row.role_id) on conflict do nothing;
  update tr8_private.invitations set status = 'accepted', accepted_by = auth.uid(), accepted_at = statement_timestamp(),
    version = version + 1, updated_at = statement_timestamp() where id = v_row.id;
  update tr8_private.workspace_authz_state set version = version + 1 where workspace_id = v_workspace;
  insert into tr8_private.workspace_activity(workspace_id, actor_id, action, resource_id)
    values(v_workspace, auth.uid(), 'invitation.accepted', v_row.id);
  return jsonb_build_object('workspace_id', v_workspace, 'member_id', v_member, 'status', 'accepted');
end;
$$;

-- Rebind the preserved trigger functions to the new relation names and freeze
-- workspace scope as well as historical author provenance.
create or replace function tr8_private.guard_project()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := statement_timestamp(); new.updated_at := new.created_at; new.version := 1;
  else
    if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
      or new.owner_id is distinct from old.owner_id or new.created_at is distinct from old.created_at
      or new.updated_at is distinct from old.updated_at or new.version is distinct from old.version then
      raise exception using errcode = '22023', message = 'Server-managed project fields are immutable';
    end if;
    new.version := old.version + 1; new.updated_at := statement_timestamp();
  end if;
  new.name := btrim(new.name);
  return new;
end;
$$;
create or replace function tr8_private.guard_task()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_archived timestamptz;
begin
  if tg_op = 'INSERT' then
    new.created_at := statement_timestamp(); new.updated_at := new.created_at; new.version := 1;
  else
    if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
      or new.owner_id is distinct from old.owner_id or new.project_id is distinct from old.project_id
      or new.task_number is distinct from old.task_number or new.created_at is distinct from old.created_at
      or new.updated_at is distinct from old.updated_at or new.version is distinct from old.version then
      raise exception using errcode = '22023', message = 'Server-managed task fields are immutable';
    end if;
    new.version := old.version + 1; new.updated_at := statement_timestamp();
  end if;
  select p.archived_at into v_archived from public.tr8_workspace_projects p
    where p.workspace_id = new.workspace_id and p.id = new.project_id for share;
  if not found then raise exception using errcode = 'PT404', message = 'Resource unavailable'; end if;
  if v_archived is not null then
    raise exception using errcode = 'PT409', message = 'Restore the archived project before editing its tasks';
  end if;
  new.title := btrim(new.title);
  return new;
end;
$$;

create function tr8_private.v2_create_project(p_workspace_id uuid, p_id uuid, p_name text, p_description text, p_color text, p_status text)
returns public.tr8_workspace_projects language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.tr8_workspace_projects; v_member uuid;
begin
  perform tr8_private.v2_require_workspace(p_workspace_id, 'project.create');
  if not tr8_private.v2_has_permission(p_workspace_id, 'project.read') then
    raise exception using errcode = 'PT404', message = 'Resource unavailable';
  end if;
  if p_id is null or p_name is null or p_description is null or p_color is null or p_status is null then
    raise exception using errcode = '22023', message = 'Project fields are required';
  end if;
  insert into public.tr8_workspace_projects(id, workspace_id, owner_id, name, description, color, status)
    values(p_id, p_workspace_id, auth.uid(), btrim(p_name), p_description, p_color, p_status)
    on conflict(id) do nothing returning * into v_row;
  if found then
    select m.id into v_member from tr8_private.workspace_members m
      where m.workspace_id = p_workspace_id and m.user_id = auth.uid() and m.status = 'active';
    if v_member is null then raise exception using errcode = 'PT404', message = 'Resource unavailable'; end if;
    insert into tr8_private.project_access(workspace_id, project_id, member_id, access_level)
      values(p_workspace_id, p_id, v_member, 'write');
    insert into tr8_private.workspace_activity(workspace_id, project_id, actor_id, action, resource_id)
      values(p_workspace_id, p_id, auth.uid(), 'project.created', p_id);
    return v_row;
  end if;
  select * into v_row from public.tr8_workspace_projects p where p.id = p_id and p.workspace_id = p_workspace_id;
  if not found or not tr8_private.v2_can_read_project(p_workspace_id, p_id) then
    raise exception using errcode = 'PT409', message = 'The request identifier is unavailable';
  end if;
  if v_row.owner_id <> auth.uid() or row(v_row.name,v_row.description,v_row.color,v_row.status)
    is distinct from row(btrim(p_name),p_description,p_color,p_status) then
    raise exception using errcode = 'PT409', message = 'The request identifier was already used with different project data';
  end if;
  return v_row;
end;
$$;
create function tr8_private.v2_update_project(p_workspace_id uuid, p_id uuid, p_version integer, p_patch jsonb)
returns public.tr8_workspace_projects language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.tr8_workspace_projects; v_key text; v_type text;
begin
  if p_id is null or p_version is null or p_version < 1 or p_patch is null
    or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'A version and a nonempty project patch are required';
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key <> all(array['name','description','color','status','archived_at']) then
      raise exception using errcode = '22023', message = 'Unknown or server-managed project field';
    end if;
    v_type := jsonb_typeof(p_patch -> v_key);
    if v_type <> 'string' and not(v_key = 'archived_at' and v_type = 'null') then
      raise exception using errcode = '22023', message = 'Invalid project field type';
    end if;
  end loop;
  -- Both capabilities are necessary when archival and content change together.
  perform tr8_private.v2_require_project(p_workspace_id,p_id,'project.read',false);
  if p_patch ? 'archived_at' then
    perform tr8_private.v2_require_project(p_workspace_id,p_id,'project.archive',true);
  end if;
  if (p_patch - 'archived_at') <> '{}'::jsonb then
    perform tr8_private.v2_require_project(p_workspace_id,p_id,'project.edit',true);
  end if;
  select * into v_row from public.tr8_workspace_projects p where p.workspace_id = p_workspace_id and p.id = p_id for update;
  if v_row.version <> p_version then
    raise exception using errcode = 'PT409', message = 'This project changed. Reload it before saving';
  end if;
  update public.tr8_workspace_projects p set
    name = case when p_patch ? 'name' then btrim(p_patch ->> 'name') else p.name end,
    description = case when p_patch ? 'description' then p_patch ->> 'description' else p.description end,
    color = case when p_patch ? 'color' then p_patch ->> 'color' else p.color end,
    status = case when p_patch ? 'status' then p_patch ->> 'status' else p.status end,
    archived_at = case when p_patch ? 'archived_at' then (p_patch ->> 'archived_at')::timestamptz else p.archived_at end
    where p.workspace_id = p_workspace_id and p.id = p_id returning * into v_row;
  insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
    values(p_workspace_id,p_id,auth.uid(),'project.updated',p_id);
  return v_row;
end;
$$;
create function tr8_private.v2_create_task(p_workspace_id uuid, p_id uuid, p_project_id uuid, p_title text,
  p_description text, p_status text, p_priority text, p_start_date date, p_due_date date)
returns public.tr8_workspace_tasks language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.tr8_workspace_tasks;
begin
  perform tr8_private.v2_require_project(p_workspace_id,p_project_id,'task.create',true);
  if p_id is null or p_title is null or p_description is null or p_status is null or p_priority is null then
    raise exception using errcode = '22023', message = 'Task fields are required';
  end if;
  -- An authorized retry returns an earlier successful create even after archive.
  select * into v_row from public.tr8_workspace_tasks t where t.id = p_id;
  if not found then
    insert into public.tr8_workspace_tasks(id,workspace_id,owner_id,project_id,title,description,status,priority,start_date,due_date)
      values(p_id,p_workspace_id,auth.uid(),p_project_id,btrim(p_title),p_description,p_status,p_priority,p_start_date,p_due_date)
      on conflict(id) do nothing returning * into v_row;
    if found then
      insert into tr8_private.workspace_activity(workspace_id,project_id,actor_id,action,resource_id)
        values(p_workspace_id,p_project_id,auth.uid(),'task.created',p_id);
      return v_row;
    end if;
    select * into v_row from public.tr8_workspace_tasks t where t.id = p_id;
  end if;
  if v_row.id is null or v_row.workspace_id <> p_workspace_id or v_row.owner_id <> auth.uid()
    or row(v_row.project_id,v_row.title,v_row.description,v_row.status,v_row.priority,v_row.start_date,v_row.due_date)
    is distinct from row(p_project_id,btrim(p_title),p_description,p_status,p_priority,p_start_date,p_due_date) then
    raise exception using errcode = 'PT409', message = 'The request identifier is unavailable';
  end if;
  return v_row;
end;
$$;
create function tr8_private.v2_update_task(p_workspace_id uuid, p_id uuid, p_version integer, p_patch jsonb)
returns public.tr8_workspace_tasks language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.tr8_workspace_tasks; v_project uuid; v_key text; v_type text;
begin
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
create function tr8_private.v2_delete_task(p_workspace_id uuid, p_id uuid, p_version integer)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_project uuid; v_version integer;
begin
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

-- Remove every old policy instead of OR-ing collaborative rules with legacy
-- owner predicates. Table-level REVOKE alone does not remove column grants.
do $cutover_permissions$
declare v_policy record; v_column record;
begin
  for v_policy in select p.polname, p.polrelid::regclass as relation from pg_catalog.pg_policy p
    where p.polrelid in ('public.tr8_workspace_projects'::regclass,'public.tr8_workspace_tasks'::regclass) loop
    execute format('drop policy %I on %s',v_policy.polname,v_policy.relation);
  end loop;
  for v_column in select a.attname, a.attrelid::regclass as relation from pg_catalog.pg_attribute a
    where a.attrelid in ('public.tr8_workspace_projects'::regclass,'public.tr8_workspace_tasks'::regclass)
      and a.attnum > 0 and not a.attisdropped loop
    execute format('revoke all (%I) on table %s from public, anon, authenticated',v_column.attname,v_column.relation);
  end loop;
end;
$cutover_permissions$;
revoke all on public.tr8_workspace_projects, public.tr8_workspace_tasks from public, anon, authenticated;
revoke all on sequence public.tr8_tasks_task_number_seq from public, anon, authenticated;
grant select on public.tr8_workspace_projects, public.tr8_workspace_tasks to authenticated;
create policy tr8_workspace_projects_read on public.tr8_workspace_projects for select to authenticated
  using(tr8_private.v2_can_read_project(workspace_id,id));
create policy tr8_workspace_tasks_read on public.tr8_workspace_tasks for select to authenticated
  using(tr8_private.v2_can_read_project(workspace_id,project_id)
    and tr8_private.v2_has_permission(workspace_id,'task.read'));

drop function public.tr8_check_access();
drop function public.tr8_create_project(uuid,text,text,text,text);
drop function public.tr8_update_project(uuid,integer,jsonb);
drop function public.tr8_create_task(uuid,uuid,text,text,text,text,date,date);
drop function public.tr8_update_task(uuid,integer,jsonb);
drop function public.tr8_delete_task(uuid,integer);
drop function tr8_private.is_owner();

-- The public wrappers are invokers; each private implementation independently
-- derives and authorizes the actor and never accepts arbitrary SQL or identity.
create function public.tr8_v2_get_context() returns jsonb language sql volatile security invoker set search_path = ''
  as $$ select tr8_private.v2_get_context(); $$;
create function public.tr8_v2_create_team(p_id uuid,p_name text) returns jsonb language sql volatile security invoker set search_path = ''
  as $$ select tr8_private.v2_create_team(p_id,p_name); $$;
create function public.tr8_v2_list_members(p_workspace_id uuid) returns jsonb language sql volatile security invoker set search_path = ''
  as $$ select tr8_private.v2_list_members(p_workspace_id); $$;
create function public.tr8_v2_list_invitations(p_workspace_id uuid) returns jsonb language sql volatile security invoker set search_path = ''
  as $$ select tr8_private.v2_list_invitations(p_workspace_id); $$;
create function public.tr8_v2_create_invitation(p_workspace_id uuid,p_id uuid,p_email text) returns jsonb language sql volatile security invoker set search_path = ''
  as $$ select tr8_private.v2_create_invitation(p_workspace_id,p_id,p_email); $$;
create function public.tr8_v2_revoke_invitation(p_workspace_id uuid,p_id uuid,p_version integer) returns jsonb language sql volatile security invoker set search_path = ''
  as $$ select tr8_private.v2_revoke_invitation(p_workspace_id,p_id,p_version); $$;
create function public.tr8_v2_accept_invitation(p_token text) returns jsonb language sql volatile security invoker set search_path = ''
  as $$ select tr8_private.v2_accept_invitation(p_token); $$;
create function public.tr8_v2_create_project(p_workspace_id uuid,p_id uuid,p_name text,p_description text,p_color text,p_status text)
  returns public.tr8_workspace_projects language sql volatile security invoker set search_path = ''
  as $$ select tr8_private.v2_create_project(p_workspace_id,p_id,p_name,p_description,p_color,p_status); $$;
create function public.tr8_v2_update_project(p_workspace_id uuid,p_id uuid,p_version integer,p_patch jsonb)
  returns public.tr8_workspace_projects language sql volatile security invoker set search_path = ''
  as $$ select tr8_private.v2_update_project(p_workspace_id,p_id,p_version,p_patch); $$;
create function public.tr8_v2_create_task(p_workspace_id uuid,p_id uuid,p_project_id uuid,p_title text,p_description text,p_status text,p_priority text,p_start_date date,p_due_date date)
  returns public.tr8_workspace_tasks language sql volatile security invoker set search_path = ''
  as $$ select tr8_private.v2_create_task(p_workspace_id,p_id,p_project_id,p_title,p_description,p_status,p_priority,p_start_date,p_due_date); $$;
create function public.tr8_v2_update_task(p_workspace_id uuid,p_id uuid,p_version integer,p_patch jsonb)
  returns public.tr8_workspace_tasks language sql volatile security invoker set search_path = ''
  as $$ select tr8_private.v2_update_task(p_workspace_id,p_id,p_version,p_patch); $$;
create function public.tr8_v2_delete_task(p_workspace_id uuid,p_id uuid,p_version integer)
  returns void language sql volatile security invoker set search_path = ''
  as $$ select tr8_private.v2_delete_task(p_workspace_id,p_id,p_version); $$;

-- Deny default EXECUTE for all internal routines, including arbitrary-user
-- authorization and bootstrap helpers. Grant only the narrow actor-facing API.
do $function_grants$
declare v_fn record;
begin
  for v_fn in select p.oid::regprocedure as signature, p.proname, n.nspname
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'tr8_private' and p.proname like 'v2_%')
      or (n.nspname = 'public' and p.proname like 'tr8_v2_%') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',v_fn.signature);
    if v_fn.nspname = 'public' or v_fn.proname = any(array[
      'v2_can_read_project','v2_has_permission','v2_get_context','v2_create_team','v2_list_members','v2_list_invitations',
      'v2_create_invitation','v2_revoke_invitation','v2_accept_invitation','v2_create_project','v2_update_project',
      'v2_create_task','v2_update_task','v2_delete_task']) then
      execute format('grant execute on function %s to authenticated',v_fn.signature);
    end if;
  end loop;
end;
$function_grants$;

-- Fail the complete migration if one historical field, object identity or
-- identity-sequence property changed. This hashes only pre-existing row fields.
do $preservation_guard$
declare s record;
begin
  select * into strict s from tr8_stage1_snapshot;
  if s.projects_oid <> 'public.tr8_workspace_projects'::regclass::oid
    or s.tasks_oid <> 'public.tr8_workspace_tasks'::regclass::oid
    or s.sequence_oid <> pg_get_serial_sequence('public.tr8_workspace_tasks','task_number')::regclass::oid
    or s.projects_hash is distinct from (select md5(coalesce(string_agg((to_jsonb(p) - 'workspace_id')::text,E'\n' order by id),'')) from public.tr8_workspace_projects p)
    or s.tasks_hash is distinct from (select md5(coalesce(string_agg((to_jsonb(t) - 'workspace_id')::text,E'\n' order by id),'')) from public.tr8_workspace_tasks t)
    or s.sequence_state is distinct from (select jsonb_build_object('last_value',q.last_value,'is_called',q.is_called) from public.tr8_tasks_task_number_seq q)
    or s.sequence_config is distinct from (select to_jsonb(q) - 'seqrelid' from pg_catalog.pg_sequence q where q.seqrelid = s.sequence_oid)
    or exists(select 1 from public.tr8_workspace_tasks t join public.tr8_workspace_projects p on p.id = t.project_id where t.workspace_id <> p.workspace_id) then
    raise exception 'Historical data or identity sequence changed during workspace migration; cutover aborted';
  end if;
end;
$preservation_guard$;

comment on column public.tr8_workspace_projects.owner_id is 'Immutable author provenance, not collaborative authorization. Account deletion is restricted.';
comment on column public.tr8_workspace_tasks.owner_id is 'Immutable author provenance, not task responsibility or collaborative authorization.';
comment on column tr8_private.app_config.external_invites_enabled is 'Administrative gate. Remains false until verified delivery and controlled account provisioning are available.';
comment on table tr8_private.workspace_activity is 'Minimal metadata only; no invitation token, email, task text or financial content.';
notify pgrst, 'reload schema';
