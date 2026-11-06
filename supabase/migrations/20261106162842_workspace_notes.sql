-- Notes stay private to their exact workspace or project scope.
create table tr8_private.workspace_notes (
  id uuid not null,
  workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
  project_id uuid,
  created_by uuid not null,
  title text not null check (length(title) between 1 and 120),
  body text not null check (length(body) <= 30000),
  tags text[] not null check (cardinality(tags) <= 8),
  pinned boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  version integer not null default 1 check (version > 0),
  unique nulls not distinct (workspace_id, project_id, id),
  foreign key (workspace_id, project_id) references public.tr8_workspace_projects(workspace_id, id) on delete cascade
);

create index tr8_workspace_notes_list on tr8_private.workspace_notes
  (workspace_id, project_id, (archived_at is not null), pinned desc, updated_at desc, id);

-- Bind create retries to the original author and content. After deletion
-- keep only the scoped identifier to prevent a late retry recreating a note.
create table tr8_private.note_create_requests (
  id uuid not null,
  workspace_id uuid not null references tr8_private.workspaces(id) on delete cascade,
  project_id uuid,
  created_by uuid,
  payload_hash bytea check (octet_length(payload_hash) = 32),
  check ((created_by is null) = (payload_hash is null)),
  unique nulls not distinct (workspace_id, project_id, id),
  foreign key (workspace_id, project_id) references public.tr8_workspace_projects(workspace_id, id) on delete cascade
);

alter table tr8_private.workspace_notes enable row level security;
alter table tr8_private.note_create_requests enable row level security;
revoke all on tr8_private.workspace_notes, tr8_private.note_create_requests from public, anon, authenticated, service_role;

-- Returns owner status for the workspace notebook, or write capability for
-- the project notebook. Session and authorization locks precede row locks.
create function tr8_private.notes_access(p_workspace_id uuid, p_project_id uuid, p_write boolean)
returns boolean language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_owner uuid;
  v_archived timestamptz;
begin
  perform tr8_private.v7_require_browser_session();

  if p_project_id is null then
    perform tr8_private.v2_lock_workspace(p_workspace_id);
    perform tr8_private.v2_require_actor();
    select w.owner_id into v_owner
    from tr8_private.workspaces w
    where w.id = p_workspace_id and (
      w.owner_id = v_actor or (
        w.kind = 'team' and exists (
          select 1 from tr8_private.workspace_members m
          where m.workspace_id = w.id and m.user_id = v_actor and m.status = 'active'
        )
      )
    );
    if not found then
      raise exception using errcode = 'PT404', message = 'Resource unavailable';
    end if;
    return v_owner = v_actor;
  end if;

  perform tr8_private.v2_require_project(
    p_workspace_id, p_project_id, case when p_write then 'project.edit' else 'project.read' end, p_write
  );
  select p.archived_at into v_archived
  from public.tr8_workspace_projects p
  where p.workspace_id = p_workspace_id and p.id = p_project_id
  for share;
  if not found then
    raise exception using errcode = 'PT404', message = 'Resource unavailable';
  end if;
  if p_write and v_archived is not null then
    raise exception using errcode = '55000', message = 'Restore the archived project before changing its notes';
  end if;
  return v_archived is null and (
    p_write or (tr8_private.v2_project_capabilities_json(p_workspace_id, p_project_id) -> 'permissions') ? 'project.edit'
  );
end;
$$;

create function tr8_private.notes_content(p_title text, p_body text, p_tags text[], out title text, out tags text[])
language plpgsql immutable security invoker set search_path = '' as $$
begin
  title := regexp_replace(p_title, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  if title is null or length(title) not between 1 and 120 or p_body is null or length(p_body) > 30000
    or p_tags is null or cardinality(p_tags) > 8 or coalesce(array_ndims(p_tags), 1) <> 1 then
    raise exception using errcode = '22023', message = 'Invalid note content';
  end if;

  select coalesce(array_agg(regexp_replace(t.tag, '^[[:space:]]+|[[:space:]]+$', '', 'g') order by t.position), array[]::text[])
  into tags
  from unnest(p_tags) with ordinality as t(tag, position);
  if exists (select 1 from unnest(tags) tag where tag is null or length(tag) not between 1 and 30) then
    raise exception using errcode = '22023', message = 'Invalid note tags';
  end if;
end;
$$;

create function tr8_private.notes_json(p_note tr8_private.workspace_notes, p_can_edit boolean)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id', p_note.id, 'workspace_id', p_note.workspace_id, 'project_id', p_note.project_id,
    'title', p_note.title, 'body', p_note.body, 'tags', p_note.tags,
    'pinned', p_note.pinned, 'archived_at', p_note.archived_at, 'created_at', p_note.created_at,
    'updated_at', p_note.updated_at, 'version', p_note.version, 'can_edit', p_can_edit
  );
$$;

create function tr8_private.notes_list(
  p_workspace_id uuid, p_project_id uuid, p_archived boolean, p_query text, p_offset integer
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_privileged boolean;
  v_query text := lower(regexp_replace(p_query, '^[[:space:]]+|[[:space:]]+$', '', 'g'));
  v_notes jsonb;
  v_has_more boolean;
begin
  v_privileged := tr8_private.notes_access(p_workspace_id, p_project_id, false);
  if p_archived is null or p_offset is null or p_offset < 0 or v_query is null or length(v_query) > 120 then
    raise exception using errcode = '22023', message = 'Invalid note list filters';
  end if;

  select coalesce(jsonb_agg(
    tr8_private.notes_json(q.note, v_privileged or (p_project_id is null and q.created_by = v_actor))
    order by q.pinned desc, q.updated_at desc, q.id
  ), '[]'::jsonb), count(*) > 30
  into v_notes, v_has_more
  from (
    select n as note, n.created_by, n.pinned, n.updated_at, n.id
    from tr8_private.workspace_notes n
    where n.workspace_id = p_workspace_id
      and (n.project_id = p_project_id or (n.project_id is null and p_project_id is null))
      and (n.archived_at is not null) = p_archived
      and (v_query = '' or strpos(lower(n.title), v_query) > 0 or strpos(lower(n.body), v_query) > 0
        or exists (select 1 from unnest(n.tags) tag where strpos(lower(tag), v_query) > 0))
    order by n.pinned desc, n.updated_at desc, n.id
    limit 31 offset p_offset
  ) q;
  return jsonb_build_object('notes', case when v_has_more then v_notes - 30 else v_notes end, 'has_more', v_has_more);
end;
$$;

create function tr8_private.notes_create(
  p_workspace_id uuid, p_project_id uuid, p_id uuid, p_title text, p_body text, p_tags text[]
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_title text;
  v_tags text[];
  v_hash bytea;
  v_request tr8_private.note_create_requests;
  v_note tr8_private.workspace_notes;
begin
  perform tr8_private.notes_access(p_workspace_id, p_project_id, true);
  if p_id is null then
    raise exception using errcode = '22023', message = 'A note ID is required';
  end if;
  select c.title, c.tags into v_title, v_tags from tr8_private.notes_content(p_title, p_body, p_tags) c;
  v_hash := extensions.digest(convert_to(jsonb_build_array(v_title, p_body, v_tags)::text, 'UTF8'), 'sha256');

  insert into tr8_private.note_create_requests (workspace_id, project_id, id, created_by, payload_hash)
  values (p_workspace_id, p_project_id, p_id, v_actor, v_hash)
  on conflict (workspace_id, project_id, id) do nothing;
  if found then
    insert into tr8_private.workspace_notes (workspace_id, project_id, id, created_by, title, body, tags)
    values (p_workspace_id, p_project_id, p_id, v_actor, v_title, p_body, v_tags)
    returning * into v_note;
  else
    select r.* into strict v_request
    from tr8_private.note_create_requests r
    where r.workspace_id = p_workspace_id and r.project_id is not distinct from p_project_id and r.id = p_id;
    if v_request.created_by is distinct from v_actor or v_request.payload_hash is distinct from v_hash then
      raise exception using errcode = 'PT409', message = 'This note ID is already in use';
    end if;
    select n.* into v_note
    from tr8_private.workspace_notes n
    where n.workspace_id = p_workspace_id and n.project_id is not distinct from p_project_id and n.id = p_id;
    if not found then
      raise exception using errcode = 'PT409', message = 'This note was already removed';
    end if;
  end if;
  return tr8_private.notes_json(v_note, true);
end;
$$;

create function tr8_private.notes_lock_for_edit(
  p_workspace_id uuid, p_project_id uuid, p_id uuid, p_version integer
)
returns tr8_private.workspace_notes language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_privileged boolean;
  v_note tr8_private.workspace_notes;
begin
  v_privileged := tr8_private.notes_access(p_workspace_id, p_project_id, true);
  if p_id is null or p_version is null or p_version < 1 then
    raise exception using errcode = '22023', message = 'A note ID and version are required';
  end if;

  select n.* into v_note
  from tr8_private.workspace_notes n
  where n.workspace_id = p_workspace_id and n.project_id is not distinct from p_project_id and n.id = p_id
    and (v_privileged or n.created_by = auth.uid())
  for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'Resource unavailable';
  end if;
  if v_note.version <> p_version then
    raise exception using errcode = 'PT409', message = 'This note changed. Reload it before editing';
  end if;
  return v_note;
end;
$$;

create function tr8_private.notes_update(
  p_workspace_id uuid, p_project_id uuid, p_id uuid, p_version integer, p_title text, p_body text, p_tags text[],
  p_pinned boolean, p_archived boolean
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_note tr8_private.workspace_notes;
  v_title text;
  v_tags text[];
begin
  v_note := tr8_private.notes_lock_for_edit(p_workspace_id, p_project_id, p_id, p_version);
  if p_pinned is null or p_archived is null then
    raise exception using errcode = '22023', message = 'Invalid note state';
  end if;
  select c.title, c.tags into v_title, v_tags from tr8_private.notes_content(p_title, p_body, p_tags) c;
  update tr8_private.workspace_notes n
  set title = v_title, body = p_body, tags = v_tags, pinned = p_pinned,
    archived_at = case when p_archived then coalesce(v_note.archived_at, clock_timestamp()) end,
    updated_at = clock_timestamp(), version = v_note.version + 1
  where n.workspace_id = p_workspace_id and n.project_id is not distinct from p_project_id and n.id = p_id
  returning n.* into v_note;
  return tr8_private.notes_json(v_note, true);
end;
$$;

create function tr8_private.notes_delete(p_workspace_id uuid, p_project_id uuid, p_id uuid, p_version integer)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_note tr8_private.workspace_notes;
begin
  v_note := tr8_private.notes_lock_for_edit(p_workspace_id, p_project_id, p_id, p_version);
  if v_note.archived_at is null then
    raise exception using errcode = '55000', message = 'Archive this note before permanently deleting it';
  end if;
  delete from tr8_private.workspace_notes n
  where n.workspace_id = p_workspace_id and n.project_id is not distinct from p_project_id and n.id = p_id;
  update tr8_private.note_create_requests r
  set created_by = null, payload_hash = null
  where r.workspace_id = p_workspace_id and r.project_id is not distinct from p_project_id and r.id = p_id;
end;
$$;

create function public.tr8_notes_list(
  p_workspace_id uuid, p_project_id uuid, p_archived boolean, p_query text, p_offset integer
)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select tr8_private.notes_list(p_workspace_id, p_project_id, p_archived, p_query, p_offset);
$$;

create function public.tr8_notes_create(
  p_workspace_id uuid, p_project_id uuid, p_id uuid, p_title text, p_body text, p_tags text[]
)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select tr8_private.notes_create(p_workspace_id, p_project_id, p_id, p_title, p_body, p_tags);
$$;

create function public.tr8_notes_update(
  p_workspace_id uuid, p_project_id uuid, p_id uuid, p_version integer, p_title text, p_body text, p_tags text[],
  p_pinned boolean, p_archived boolean
)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select tr8_private.notes_update(p_workspace_id, p_project_id, p_id, p_version, p_title, p_body, p_tags, p_pinned, p_archived);
$$;

create function public.tr8_notes_delete(p_workspace_id uuid, p_project_id uuid, p_id uuid, p_version integer)
returns void language sql volatile security invoker set search_path = '' as $$
  select tr8_private.notes_delete(p_workspace_id, p_project_id, p_id, p_version);
$$;

revoke all on function
  tr8_private.notes_access(uuid, uuid, boolean),
  tr8_private.notes_content(text, text, text[]),
  tr8_private.notes_json(tr8_private.workspace_notes, boolean),
  tr8_private.notes_list(uuid, uuid, boolean, text, integer),
  tr8_private.notes_create(uuid, uuid, uuid, text, text, text[]),
  tr8_private.notes_lock_for_edit(uuid, uuid, uuid, integer),
  tr8_private.notes_update(uuid, uuid, uuid, integer, text, text, text[], boolean, boolean),
  tr8_private.notes_delete(uuid, uuid, uuid, integer),
  public.tr8_notes_list(uuid, uuid, boolean, text, integer),
  public.tr8_notes_create(uuid, uuid, uuid, text, text, text[]),
  public.tr8_notes_update(uuid, uuid, uuid, integer, text, text, text[], boolean, boolean),
  public.tr8_notes_delete(uuid, uuid, uuid, integer)
from public, anon, authenticated, service_role;

grant execute on function
  tr8_private.notes_list(uuid, uuid, boolean, text, integer),
  tr8_private.notes_create(uuid, uuid, uuid, text, text, text[]),
  tr8_private.notes_update(uuid, uuid, uuid, integer, text, text, text[], boolean, boolean),
  tr8_private.notes_delete(uuid, uuid, uuid, integer),
  public.tr8_notes_list(uuid, uuid, boolean, text, integer),
  public.tr8_notes_create(uuid, uuid, uuid, text, text, text[]),
  public.tr8_notes_update(uuid, uuid, uuid, integer, text, text, text[], boolean, boolean),
  public.tr8_notes_delete(uuid, uuid, uuid, integer)
to authenticated;

notify pgrst, 'reload schema';
