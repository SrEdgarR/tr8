import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Backup and generated SQL contain private content: keep both outside Git.
const [backupPath, outputPath, ...migrationPaths] = process.argv.slice(2);
if (!backupPath || !outputPath || !migrationPaths.length) throw new Error('Expected private backup, private SQL output and migration paths.');
const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
if (backup.format !== 'tr8-stage3-backup-v1' || !backup.private || !backup.sequence || !Array.isArray(backup.owners)) throw new Error('Unsupported backup.');
for (const field of ['projects', 'tasks']) if (!Array.isArray(backup[field])) throw new Error('Incomplete backup.');
const privateTables = [
  'app_users',
  'workspaces',
  'workspace_authz_state',
  'workspace_members',
  'workspace_roles',
  'role_permissions',
  'member_roles',
  'project_access',
  'invitations',
  'workspace_activity',
];
for (const table of [...privateTables, 'app_config', 'permission_catalog'])
  if (!Array.isArray(backup.private[table])) throw new Error('Incomplete private metadata.');
const migrations = migrationPaths.map(path => {
  const source = readFileSync(path, 'utf8');
  if (!source.trim() || /^\s*(?:begin|commit|rollback|start\s+transaction|end\s+transaction)\s*;/im.test(source)) {
    throw new Error('Rehearsal requires nonempty migrations without transaction boundaries.');
  }
  return source;
});
const literal = JSON.stringify(backup).replaceAll("'", "''");
const tableInsert = table =>
  `insert into tr8_private.${table} select x.* from stage3_restore_backup b cross join lateral jsonb_populate_recordset(null::tr8_private.${table},b.data->'private'->'${table}') x;`;
const beforeContent = ['app_users', 'workspaces', 'workspace_authz_state', 'workspace_members', 'workspace_roles', 'role_permissions', 'member_roles'];
const afterContent = ['project_access', 'invitations'];
const checks = `
do $preservation$
declare v_table text; v_schema text; v_payload jsonb; v_expected jsonb; v_actual jsonb; v_key text; v_keys text[];
begin
  foreach v_table in array array['tr8_workspace_projects','tr8_workspace_tasks','app_config','app_users','workspaces','workspace_authz_state','workspace_members','workspace_roles','role_permissions','member_roles','project_access','invitations','workspace_activity'] loop
    v_schema := case when v_table like 'tr8_workspace_%' then 'public' else 'tr8_private' end;
    select case when v_table='tr8_workspace_projects' then data->'projects' when v_table='tr8_workspace_tasks' then data->'tasks' else data->'private'->v_table end into v_payload from stage3_restore_backup;
    for v_expected in select value from jsonb_array_elements(v_payload) loop
      v_keys := case when v_table='app_config' then array['singleton'] when v_table='app_users' then array['user_id'] when v_table='workspace_authz_state' then array['workspace_id'] when v_table='role_permissions' then array['workspace_id','role_id','permission'] when v_table='member_roles' then array['workspace_id','member_id','role_id'] when v_table='project_access' then array['workspace_id','project_id','member_id'] else array['id'] end;
      execute format('select to_jsonb(t) from %I.%I t where to_jsonb(t) @> $1',v_schema,v_table) into v_actual using (select jsonb_object_agg(k,v_expected->k) from unnest(v_keys) k);
      if v_actual is null then raise exception 'Restored record missing in %', v_table; end if;
      for v_key in select jsonb_object_keys(v_expected) loop
        if v_actual->v_key is distinct from v_expected->v_key then raise exception 'Historical field changed in %: %',v_table,v_key; end if;
      end loop;
    end loop;
  end loop;
end;
$preservation$;
`;
const sql = `begin;
set local statement_timeout='90s';
create temporary table stage3_restore_backup on commit drop as select '${literal}'::jsonb data;
do $isolated_only$ begin
  if not exists(select 1 from auth.users where email like 'tr8-stage1-http-owner-%@example.test')
    or exists(select 1 from auth.users u join stage3_restore_backup b on exists(select 1 from jsonb_array_elements(b.data->'owners') o where o->>'id'=u.id::text)) then
    raise exception 'Requires the designated synthetic test environment without backed-up owner IDs; never run on production';
  end if;
  if (select external_invites_enabled from tr8_private.app_config where singleton) then raise exception 'External onboarding must remain disabled'; end if;
  if (select jsonb_agg(to_jsonb(c) order by permission) from tr8_private.permission_catalog c) is distinct from (select data->'private'->'permission_catalog' from stage3_restore_backup) then raise exception 'Permission catalogue differs'; end if;
end; $isolated_only$;
insert into auth.users(id,email,email_confirmed_at,created_at,updated_at,aud,role)
select (u->>'id')::uuid,u->>'email',(u->>'email_confirmed_at')::timestamptz,(u->>'created_at')::timestamptz,(u->>'created_at')::timestamptz,'authenticated','authenticated'
from stage3_restore_backup b cross join lateral jsonb_array_elements(b.data->'owners') u;
update tr8_private.app_config set owner_email=(select data->'private'->'app_config'->0->>'owner_email' from stage3_restore_backup) where singleton;
${beforeContent.map(tableInsert).join('\n')}
alter table public.tr8_workspace_projects disable trigger user;
alter table public.tr8_workspace_tasks disable trigger user;
insert into public.tr8_workspace_projects(id,owner_id,workspace_id,name,description,color,status,archived_at,version,created_at,updated_at)
select p.id,p.owner_id,p.workspace_id,p.name,p.description,p.color,p.status,p.archived_at,p.version,p.created_at,p.updated_at
from stage3_restore_backup b cross join lateral jsonb_populate_recordset(null::public.tr8_workspace_projects,b.data->'projects') p;
insert into public.tr8_workspace_tasks(id,owner_id,workspace_id,project_id,assignee_member_id,task_number,title,description,status,priority,start_date,due_date,position,version,created_at,updated_at)
overriding system value
select t.id,t.owner_id,t.workspace_id,t.project_id,t.assignee_member_id,t.task_number,t.title,t.description,t.status,t.priority,t.start_date,t.due_date,t.position,t.version,t.created_at,t.updated_at
from stage3_restore_backup b cross join lateral jsonb_populate_recordset(null::public.tr8_workspace_tasks,b.data->'tasks') t;
alter table public.tr8_workspace_projects enable trigger user;
alter table public.tr8_workspace_tasks enable trigger user;
${afterContent.map(tableInsert).join('\n')}
insert into tr8_private.workspace_activity overriding system value select x.* from stage3_restore_backup b cross join lateral jsonb_populate_recordset(null::tr8_private.workspace_activity,b.data->'private'->'workspace_activity') x;
create temporary sequence stage3_exported_sequence;
select setval('stage3_exported_sequence',(select (data->'sequence'->>'last_value')::bigint from stage3_restore_backup),(select (data->'sequence'->>'is_called')::boolean from stage3_restore_backup));
${checks}
${migrations.join('\n')}
${checks}
do $sequence_and_gate$ begin
  if (select jsonb_build_object('last_value',last_value,'is_called',is_called) from stage3_exported_sequence) is distinct from (select data->'sequence' from stage3_restore_backup) then raise exception 'Exported sequence restoration differs'; end if;
  if (select external_invites_enabled from tr8_private.app_config where singleton) then raise exception 'Migration enabled external onboarding'; end if;
end; $sequence_and_gate$;
select jsonb_build_object('restoration','passed','migration_preservation','passed','projects',(select jsonb_array_length(data->'projects') from stage3_restore_backup),'tasks',(select jsonb_array_length(data->'tasks') from stage3_restore_backup),'private_metadata','passed') as stage3_rehearsal;
rollback;
`;
writeFileSync(resolve(outputPath), sql, { encoding: 'utf8', flag: 'wx' });
console.log('Rollback-only stage-3 rehearsal written to the private output path.');
