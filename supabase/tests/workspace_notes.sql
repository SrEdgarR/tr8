-- TEST ONLY: synthetic accounts and notes. All fixtures roll back.
begin;
select set_config('tr8.notes_checks', '0', true);

create function pg_temp.n_id(n integer) returns uuid language sql immutable as $$
  select ('f9770000-' || lpad(n::text, 4, '0') || '-4000-8000-000000000000')::uuid;
$$;
create function pg_temp.n_actor(n integer) returns void language plpgsql as $$
declare
  actor uuid := pg_temp.n_id(n);
begin
  perform set_config('request.jwt.claim.sub', actor::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated', 'session_id', actor)::text, true);
end;
$$;
create function pg_temp.n_assert(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Notes assertion: %', label; end if;
  perform set_config('tr8.notes_checks', (current_setting('tr8.notes_checks')::integer + 1)::text, true);
end;
$$;
create function pg_temp.n_error(command text, expected text, label text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if sqlstate = expected then
      perform pg_temp.n_assert(true, label);
      return;
    end if;
    raise exception 'Notes expected % got % (%) for %', expected, sqlstate, sqlerrm, label;
  end;
  raise exception 'Notes unexpectedly allowed: %', label;
end;
$$;
create function pg_temp.n_list(
  project integer default null, archived boolean default false, query text default '', page_offset integer default 0
)
returns jsonb language sql as $$
  select public.tr8_notes_list(pg_temp.n_id(10), pg_temp.n_id(project), archived, query, page_offset);
$$;
create function pg_temp.n_create(project integer, note integer, title text default 'Note')
returns jsonb language sql as $$
  select public.tr8_notes_create(pg_temp.n_id(10), pg_temp.n_id(project), pg_temp.n_id(note), title, 'Example BODY', array['Example tag']);
$$;
create function pg_temp.n_edit(project integer, note integer, revision integer, pinned boolean, archived boolean)
returns jsonb language sql as $$
  select public.tr8_notes_update(pg_temp.n_id(10), pg_temp.n_id(project), pg_temp.n_id(note), revision,
    'Edited note', 'Edited body', array['Edited tag'], pinned, archived);
$$;
create function pg_temp.n_remove(project integer, note integer, revision integer)
returns void language sql as $$
  select public.tr8_notes_delete(pg_temp.n_id(10), pg_temp.n_id(project), pg_temp.n_id(note), revision);
$$;
do $$begin
  execute format('grant usage on schema %I to authenticated', pg_my_temp_schema()::regnamespace);
end;$$;

select pg_temp.n_assert(
  (select count(*) = 4 and bool_and(
    not prosecdef and proconfig = array['search_path=""'] and
    not has_function_privilege('anon', oid, 'execute') and not has_function_privilege('service_role', oid, 'execute') and
    has_function_privilege('authenticated', oid, 'execute'))
   from pg_proc where pronamespace = 'public'::regnamespace and proname like 'tr8_notes_%'),
  'four public wrappers are invoker functions callable only by authenticated'
);
select pg_temp.n_assert(
  (select count(*) = 2 and bool_and(
    relrowsecurity and not has_table_privilege('authenticated', oid, 'select,insert,update,delete') and
    not has_table_privilege('service_role', oid, 'select,insert,update,delete'))
   from pg_class where oid in ('tr8_private.workspace_notes'::regclass, 'tr8_private.note_create_requests'::regclass)),
  'notes and receipts use RLS and deny direct table access'
);
select pg_temp.n_assert(
  not has_function_privilege('authenticated', 'tr8_private.notes_lock_for_edit(uuid,uuid,uuid,integer)', 'execute'),
  'raw note-row helper is private'
);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select pg_temp.n_id(n), 'authenticated', 'authenticated', 'notes-synthetic-' || n || '@example.test',
  now(), '{}', '{}', now(), now()
from generate_series(1, 5) n;
insert into auth.sessions (id, user_id, created_at, updated_at)
select pg_temp.n_id(n), pg_temp.n_id(n), now(), now() from generate_series(1, 5) n;
insert into tr8_private.app_users (user_id, enabled, display_name)
select pg_temp.n_id(n), true, 'Synthetic notes user' from generate_series(1, 5) n;

set local role authenticated;
select pg_temp.n_actor(1);
select public.tr8_v2_get_context();
select public.tr8_v2_create_team(pg_temp.n_id(10), 'Synthetic notes team');
select public.tr8_v2_create_team(pg_temp.n_id(11), 'Other notes team');
select public.tr8_v2_create_project(pg_temp.n_id(10), pg_temp.n_id(20), 'Shared project', '', '#5A67D8', 'active');
select public.tr8_v2_create_project(pg_temp.n_id(10), pg_temp.n_id(21), 'Private project', '', '#5A67D8', 'active');

reset role;
select set_config('tr8.notes_test_personal', id::text, true)
from tr8_private.workspaces where kind = 'personal' and owner_id = pg_temp.n_id(1);
insert into tr8_private.workspace_members (id, workspace_id, user_id)
select pg_temp.n_id(100 + n), pg_temp.n_id(10), pg_temp.n_id(n) from generate_series(2, 4) n;
insert into tr8_private.member_roles (workspace_id, member_id, role_id)
select workspace_id, case when template_key = 'admin' then pg_temp.n_id(102) else pg_temp.n_id(103) end, id
from tr8_private.workspace_roles
where workspace_id = pg_temp.n_id(10) and template_key in ('admin', 'read');
insert into tr8_private.project_access (workspace_id, project_id, member_id, access_level) values
  (pg_temp.n_id(10), pg_temp.n_id(20), pg_temp.n_id(102), 'write'),
  (pg_temp.n_id(10), pg_temp.n_id(20), pg_temp.n_id(103), 'read');

set local role authenticated;
select pg_temp.n_assert(
  public.tr8_notes_create(current_setting('tr8.notes_test_personal')::uuid, null, pg_temp.n_id(30),
    'Personal note', 'Personal content', array[]::text[])->>'can_edit' = 'true', 'owner can write personal note'
);
select pg_temp.n_assert(
  pg_temp.n_create(null, 30, ' Team note ')->>'title' = 'Team note', 'canonical title is trimmed'
);
select pg_temp.n_assert(
  pg_temp.n_create(20, 30, 'Project note')->>'version' = '1', 'same UUID stays isolated between notebooks'
);
select pg_temp.n_create(21, 31, 'Hidden project note');
select pg_temp.n_assert(
  jsonb_array_length(pg_temp.n_list()->'notes') = 1 and
  pg_temp.n_list()->'notes'->0->>'title' = 'Team note' and pg_temp.n_list()->'has_more' = 'false',
  'workspace list omits both project and personal notes'
);
select pg_temp.n_assert(
  pg_temp.n_create(null, 30, 'Team note') = pg_temp.n_list()->'notes'->0,
  'identical create retry returns the existing note'
);
select pg_temp.n_error($q$select pg_temp.n_create(null, 30, 'Different note')$q$, 'PT409', 'create ID binds original content');
select pg_temp.n_error($q$select pg_temp.n_create(null, 33, repeat('a', 121))$q$, '22023', 'overlong title denied');
select pg_temp.n_error($q$select public.tr8_notes_create(pg_temp.n_id(10), null, pg_temp.n_id(33),
  'Note', repeat('a', 30001), array[]::text[])$q$, '22023', 'overlong body denied');
select pg_temp.n_error($q$select public.tr8_notes_create(pg_temp.n_id(10), null, pg_temp.n_id(33),
  'Note', '', array[' '])$q$, '22023', 'blank tag denied');
select pg_temp.n_error($q$select public.tr8_notes_create(pg_temp.n_id(10), null, pg_temp.n_id(33),
  'Note', '', array_fill('tag'::text, array[9]))$q$, '22023', 'more than eight tags denied');
select pg_temp.n_error($q$select pg_temp.n_list(null, false, '', -1)$q$, '22023', 'negative offset denied');
select pg_temp.n_error($q$select pg_temp.n_list(null, false, repeat('a', 121))$q$, '22023', 'overlong query denied');
select pg_temp.n_assert(
  jsonb_array_length(pg_temp.n_list(null, false, 'TEAM NOTE')->'notes') = 1 and
  jsonb_array_length(pg_temp.n_list(null, false, ' body ')->'notes') = 1 and
  jsonb_array_length(pg_temp.n_list(null, false, 'example TAG')->'notes') = 1 and
  jsonb_array_length(pg_temp.n_list(null, false, '%')->'notes') = 0,
  'search matches title, body, tags and treats wildcard characters literally'
);

select pg_temp.n_actor(2);
select pg_temp.n_assert(pg_temp.n_list()->'notes'->0->>'can_edit' = 'false', 'team admin sees owner note as read-only');
select pg_temp.n_error($q$select pg_temp.n_edit(null, 30, 1, false, false)$q$, 'PT404', 'admin cannot edit owner workspace note');
select pg_temp.n_error($q$select pg_temp.n_create(null, 30, 'Team note')$q$, 'PT409', 'another author cannot claim create receipt');
select pg_temp.n_error($q$select pg_temp.n_list(21)$q$, 'PT404', 'membership cannot read private project notes');
select pg_temp.n_error($q$select pg_temp.n_edit(null, 31, 1, false, false)$q$, 'PT404', 'team note update cannot probe a project note');
select pg_temp.n_error($q$select public.tr8_notes_list(current_setting('tr8.notes_test_personal')::uuid, null, false, '', 0)$q$,
  'PT404', 'another user cannot read personal notes');
select pg_temp.n_error($q$select public.tr8_notes_list(pg_temp.n_id(11), pg_temp.n_id(20), false, '', 0)$q$,
  'PT404', 'project ID paired with the wrong workspace denied');
select pg_temp.n_assert(
  pg_temp.n_list(20)->'notes'->0->>'can_edit' = 'true' and
  pg_temp.n_edit(20, 30, 1, true, false)->>'version' = '2',
  'project editor may update another author project note'
);
select pg_temp.n_error($q$select pg_temp.n_edit(20, 30, 1, false, false)$q$, 'PT409', 'stale update cannot overwrite');
select pg_temp.n_assert(pg_temp.n_list(20)->'notes'->0->>'pinned' = 'true', 'stale update leaves newer pin intact');

select pg_temp.n_actor(3);
select pg_temp.n_assert(pg_temp.n_list(20)->'notes'->0->>'can_edit' = 'false', 'project reader sees note without edit flag');
select pg_temp.n_error($q$select pg_temp.n_edit(20, 30, 2, false, false)$q$, 'PT404', 'project reader cannot update');
select pg_temp.n_error($q$select pg_temp.n_create(20, 33)$q$, 'PT404', 'project reader cannot create');

select pg_temp.n_actor(4);
select pg_temp.n_assert(
  pg_temp.n_create(null, 32, 'Member note')->>'can_edit' = 'true', 'role-less active member can create team note'
);
select pg_temp.n_assert(pg_temp.n_edit(null, 32, 1, false, false)->>'version' = '2', 'team author can edit own note');
select pg_temp.n_assert(
  pg_temp.n_create(null, 32, 'Member note')->>'version' = '2', 'retry after edit returns the latest version'
);

select pg_temp.n_actor(5);
select pg_temp.n_error($q$select pg_temp.n_list()$q$, 'PT404', 'outsider cannot read team notebook');
select pg_temp.n_error($q$select pg_temp.n_create(null, 34)$q$, 'PT404', 'outsider cannot write team notebook');

select pg_temp.n_actor(1);
select pg_temp.n_error($q$select pg_temp.n_remove(null, 32, 2)$q$, '55000', 'active note must be archived first');
select pg_temp.n_assert(
  pg_temp.n_edit(null, 32, 2, true, true)->>'archived_at' is not null, 'team owner can archive another author note'
);
select pg_temp.n_assert(
  jsonb_array_length(pg_temp.n_list()->'notes') = 1 and pg_temp.n_list(null, true)->'notes'->0->>'version' = '3',
  'archive switches the note between list modes'
);
select pg_temp.n_assert(
  (pg_temp.n_edit(null, 32, 3, true, false)->'archived_at') = 'null'::jsonb, 'restore clears archive date'
);
select pg_temp.n_error($q$select pg_temp.n_remove(null, 32, 3)$q$, 'PT409', 'stale delete cannot remove restored note');
select pg_temp.n_assert(
  pg_temp.n_edit(null, 32, 4, true, true)->>'version' = '5', 'second archive succeeds at current version'
);
select pg_temp.n_remove(null, 32, 5);
select pg_temp.n_assert(jsonb_array_length(pg_temp.n_list(null, true)->'notes') = 0, 'permanent delete removes archived note');

select pg_temp.n_actor(4);
select pg_temp.n_error($q$select pg_temp.n_create(null, 32, 'Member note')$q$, 'PT409', 'late create retry cannot resurrect deleted note');

select pg_temp.n_actor(1);
select pg_temp.n_edit(null, 30, 1, true, false);
do $$begin
  for n in 201..230 loop
    perform pg_temp.n_create(null, n, 'Page note ' || n);
  end loop;
end;$$;
select pg_temp.n_assert(
  jsonb_array_length(pg_temp.n_list()->'notes') = 30 and pg_temp.n_list()->'has_more' = 'true' and
  pg_temp.n_list()->'notes'->0->>'id' = pg_temp.n_id(30)::text and
  jsonb_array_length(pg_temp.n_list(null, false, '', 30)->'notes') = 1 and
  pg_temp.n_list(null, false, '', 30)->'has_more' = 'false',
  'pinned note first and pagination bounded to thirty rows'
);

reset role;
update public.tr8_workspace_projects set archived_at = clock_timestamp() where id = pg_temp.n_id(20);
set local role authenticated;
select pg_temp.n_assert(pg_temp.n_list(20)->'notes'->0->>'can_edit' = 'false', 'archived project notebook remains visible');
select pg_temp.n_error($q$select pg_temp.n_create(20, 33)$q$, '55000', 'cannot create notes in archived project');
select pg_temp.n_error($q$select pg_temp.n_edit(20, 30, 2, false, true)$q$, '55000', 'cannot update notes in archived project');
select pg_temp.n_error($q$select pg_temp.n_remove(20, 30, 2)$q$, '55000', 'cannot delete notes in archived project');
select public.tr8_v2_delete_project(pg_temp.n_id(20), (select version from public.tr8_workspace_projects where id = pg_temp.n_id(20)), 'Shared project');
select pg_temp.n_error($q$select pg_temp.n_list(20)$q$, 'PT404', 'deleted project no longer has a notebook');

reset role;
select pg_temp.n_assert(
  exists (select 1 from tr8_private.note_create_requests
    where workspace_id = pg_temp.n_id(10) and project_id is null and id = pg_temp.n_id(32)
      and created_by is null and payload_hash is null),
  'deleted-note tombstone retains neither author nor content fingerprint'
);
select pg_temp.n_assert(
  not exists (select 1 from tr8_private.workspace_notes where project_id = pg_temp.n_id(20)) and
  not exists (select 1 from tr8_private.note_create_requests where project_id = pg_temp.n_id(20)) and
  exists (select 1 from tr8_private.workspace_notes where workspace_id = pg_temp.n_id(10) and project_id is null and id = pg_temp.n_id(30)),
  'project deletion cascades its notes and receipts only'
);
update tr8_private.workspace_members set status = 'removed' where id = pg_temp.n_id(104);
delete from auth.sessions where id = pg_temp.n_id(3);
set local role authenticated;
select pg_temp.n_actor(4);
select pg_temp.n_error($q$select pg_temp.n_list()$q$, 'PT404', 'removed member no longer reads team notes');
select pg_temp.n_actor(3);
select pg_temp.n_error($q$select pg_temp.n_list()$q$, '42501', 'terminated session cannot read notes');
select current_setting('tr8.notes_checks')::integer as notes_checks;
rollback;
