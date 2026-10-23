import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// This pre-stage-5 backup contains private business data and internal stage-4
// leases, but must not contain Google credentials, Auth sessions or passwords.
const [backupPath, outputPath, ...migrationPaths] = process.argv.slice(2);
if (!backupPath || !outputPath || !migrationPaths.length) throw new Error('Expected private backup, private SQL output and migration paths.');
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const insideRepository = path => {
  const location = relative(repositoryRoot, resolve(path));
  return !location || (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`));
};
if (insideRepository(backupPath) || insideRepository(outputPath)) throw new Error('Backup and generated restoration SQL must remain outside the repository.');
const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
if (!record(backup) || backup.format !== 'tr8-stage5-backup-v1' || !record(backup.private) || !record(backup.sequence) || !Array.isArray(backup.owners))
  throw new Error('Unsupported backup.');
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
  'process_outbox',
  'process_jobs',
  'process_runtime',
  'process_attempts',
];
const allPrivateTables = [...privateTables, 'app_config', 'permission_catalog'];
if (Object.keys(backup.private).sort().join(',') !== [...allPrivateTables].sort().join(','))
  throw new Error('Expected exactly the 16 pre-stage-5 private tables; Google credentials cannot be restored by this rehearsal.');
for (const table of allPrivateTables) if (!Array.isArray(backup.private[table])) throw new Error('Incomplete private metadata.');
const exactKeys = (value, keys) => record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
if (!exactKeys(backup, ['format', 'captured_at', 'owners', 'private', 'projects', 'tasks', 'sequence']))
  throw new Error('Unexpected backup fields; only pre-stage-5 data is supported.');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const nullableUuid = value => value === null || uuid(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => typeof value === 'string' && value.length <= 50 && Number.isFinite(Date.parse(value));
const nullableTime = value => value === null || timestamp(value);
const date = value =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
if (
  !exactKeys(backup.sequence, ['last_value', 'is_called']) ||
  !Number.isSafeInteger(backup.sequence.last_value) ||
  backup.sequence.last_value < 1 ||
  typeof backup.sequence.is_called !== 'boolean'
)
  throw new Error('Invalid exported sequence.');
if (
  backup.private.app_config.length !== 1 ||
  !exactKeys(backup.private.app_config[0], ['singleton', 'owner_email', 'external_invites_enabled']) ||
  backup.private.app_config[0].singleton !== true ||
  backup.private.app_config[0].external_invites_enabled !== false
)
  throw new Error('External onboarding must remain disabled in the backup.');
for (const task of backup.tasks)
  if (!record(task) || !['scheduled_start_at', 'scheduled_end_at', 'scheduled_time_zone'].every(key => Object.hasOwn(task, key)))
    throw new Error('Incomplete stage-3 task scheduling fields.');
for (const account of backup.private.app_users)
  if (!record(account) || !['calendar_time_zone', 'calendar_preferences_version'].every(key => Object.hasOwn(account, key)))
    throw new Error('Incomplete stage-3 calendar preference fields.');
for (const owner of backup.owners)
  if (
    !exactKeys(owner, ['id', 'email', 'email_confirmed_at', 'created_at']) ||
    !uuid(owner.id) ||
    typeof owner.email !== 'string' ||
    !timestamp(owner.created_at) ||
    !nullableTime(owner.email_confirmed_at)
  )
    throw new Error('Invalid minimal Auth identity; sessions and passwords are excluded.');
const events = new Set(['task.created', 'task.changed', 'task.deleted', 'project.created', 'project.changed', 'project.deleted', 'authorization.changed']);
const states = new Set(['pending', 'leased', 'retry', 'succeeded', 'cancelled', 'unknown', 'dead']);
const terminal = new Set(['succeeded', 'cancelled', 'unknown', 'dead']);
const reasons = new Set([
  'reconciled',
  'superseded',
  'resource_removed',
  'access_changed',
  'lease_expired',
  'temporary_failure',
  'permanent_failure',
  'outcome_unknown',
  'attempt_limit',
  'cancelled',
]);
for (const row of backup.private.process_outbox) {
  if (
    !exactKeys(row, [
      'id',
      'workspace_id',
      'project_id',
      'entity_id',
      'entity_kind',
      'event_kind',
      'entity_version',
      'entity_created_at',
      'authz_version',
      'actor_id',
      'previous_member_id',
      'member_id',
      'created_at',
    ]) ||
    !uuid(row.id) ||
    !uuid(row.workspace_id) ||
    !uuid(row.entity_id) ||
    !nullableUuid(row.project_id) ||
    !nullableUuid(row.actor_id) ||
    !nullableUuid(row.previous_member_id) ||
    !nullableUuid(row.member_id) ||
    !['task', 'project', 'authorization'].includes(row.entity_kind) ||
    !events.has(row.event_kind) ||
    !row.event_kind.startsWith(`${row.entity_kind}.`) ||
    !count(row.entity_version) ||
    row.entity_version < 1 ||
    !count(row.authz_version) ||
    row.authz_version < 1 ||
    !timestamp(row.entity_created_at) ||
    !timestamp(row.created_at)
  )
    throw new Error('Invalid stage-4 outbox metadata.');
}
const outboxIds = new Set(backup.private.process_outbox.map(row => row.id));
for (const row of backup.private.process_jobs) {
  if (
    !exactKeys(row, [
      'id',
      'outbox_id',
      'channel',
      'state',
      'attempts',
      'available_at',
      'lease_token',
      'lease_expires_at',
      'reason',
      'created_at',
      'updated_at',
      'finished_at',
    ]) ||
    !uuid(row.id) ||
    !outboxIds.has(row.outbox_id) ||
    row.channel !== 'internal' ||
    !states.has(row.state) ||
    !count(row.attempts) ||
    row.attempts > 8 ||
    !timestamp(row.available_at) ||
    !timestamp(row.created_at) ||
    !timestamp(row.updated_at) ||
    !nullableTime(row.finished_at) ||
    !nullableUuid(row.lease_token) ||
    !nullableTime(row.lease_expires_at) ||
    (row.reason !== null && !reasons.has(row.reason)) ||
    (row.state === 'leased') !== (row.lease_token !== null && row.lease_expires_at !== null) ||
    terminal.has(row.state) !== (row.finished_at !== null)
  )
    throw new Error('Invalid stage-4 job state.');
}
for (const row of backup.private.process_attempts)
  if (
    !exactKeys(row, ['id', 'job_id', 'actor_id', 'workspace_id', 'leased_at']) ||
    !uuid(row.id) ||
    !uuid(row.job_id) ||
    !nullableUuid(row.actor_id) ||
    !uuid(row.workspace_id) ||
    !timestamp(row.leased_at)
  )
    throw new Error('Invalid stage-4 attempt receipt.');
const runtime = backup.private.process_runtime;
if (
  runtime.length !== 1 ||
  !exactKeys(runtime[0], [
    'singleton',
    'scheduler_enabled',
    'last_run_at',
    'last_finished_at',
    'day',
    'used_today',
    'month',
    'used_month',
    'daily_limit',
    'monthly_limit',
  ]) ||
  runtime[0].singleton !== true ||
  typeof runtime[0].scheduler_enabled !== 'boolean' ||
  !nullableTime(runtime[0].last_run_at) ||
  !nullableTime(runtime[0].last_finished_at) ||
  !date(runtime[0].day) ||
  !date(runtime[0].month) ||
  !runtime[0].month.endsWith('-01') ||
  !count(runtime[0].used_today) ||
  !count(runtime[0].used_month) ||
  !count(runtime[0].daily_limit) ||
  runtime[0].daily_limit < 1 ||
  runtime[0].daily_limit > 500 ||
  !count(runtime[0].monthly_limit) ||
  runtime[0].monthly_limit < 1 ||
  runtime[0].monthly_limit > 10000
)
  throw new Error('Invalid stage-4 singleton runtime.');
const migrations = migrationPaths.map(path => {
  const source = readFileSync(path, 'utf8');
  if (!source.trim() || /^\s*(?:begin|commit|rollback|start\s+transaction|end\s+transaction)\s*;/im.test(source))
    throw new Error('Rehearsal requires nonempty migrations without transaction boundaries.');
  return source;
});
const literal = JSON.stringify(backup).replaceAll("'", "''");
const tableInsert = table =>
  `insert into tr8_private.${table} select x.* from stage5_restore_backup b cross join lateral jsonb_populate_recordset(null::tr8_private.${table},b.data->'private'->'${table}') x;`;
const beforeContent = ['app_users', 'workspaces', 'workspace_authz_state', 'workspace_members', 'workspace_roles', 'role_permissions', 'member_roles'];
const afterContent = ['project_access', 'invitations'];
const checks = `
do $preservation$
declare v_table text; v_schema text; v_payload jsonb; v_expected jsonb; v_actual jsonb; v_key text; v_keys text[];
begin
  foreach v_table in array array['tr8_workspace_projects','tr8_workspace_tasks','app_config','app_users','workspaces','workspace_authz_state','workspace_members','workspace_roles','role_permissions','member_roles','project_access','invitations','workspace_activity','process_outbox','process_jobs','process_runtime','process_attempts'] loop
    v_schema := case when v_table like 'tr8_workspace_%' then 'public' else 'tr8_private' end;
    select case when v_table='tr8_workspace_projects' then data->'projects' when v_table='tr8_workspace_tasks' then data->'tasks' else data->'private'->v_table end into v_payload from stage5_restore_backup;
    for v_expected in select value from jsonb_array_elements(v_payload) loop
      v_keys := case when v_table in ('app_config','process_runtime') then array['singleton'] when v_table='app_users' then array['user_id'] when v_table='workspace_authz_state' then array['workspace_id'] when v_table='role_permissions' then array['workspace_id','role_id','permission'] when v_table='member_roles' then array['workspace_id','member_id','role_id'] when v_table='project_access' then array['workspace_id','project_id','member_id'] else array['id'] end;
      execute format('select to_jsonb(t) from %I.%I t where to_jsonb(t) @> $1',v_schema,v_table) into v_actual using (select jsonb_object_agg(k,v_expected->k) from unnest(v_keys) k);
      if v_actual is null then raise exception 'Restored record missing in %', v_table; end if;
      for v_key in select jsonb_object_keys(v_expected) loop
        if v_actual->v_key is distinct from v_expected->v_key then raise exception 'Historical field changed in %: %',v_table,v_key; end if;
      end loop;
    end loop;
  end loop;
end; $preservation$;
`;
const sql = `begin;
set local statement_timeout='90s';
set local lock_timeout='2s';
create temporary table stage5_restore_backup on commit drop as select '${literal}'::jsonb data;
do $isolated_only$ begin
  if not exists(select 1 from auth.users where email like 'tr8-stage1-http-owner-%@example.test')
    or exists(select 1 from auth.users u join stage5_restore_backup b on exists(select 1 from jsonb_array_elements(b.data->'owners') o where o->>'id'=u.id::text)) then
    raise exception 'Requires the designated synthetic test environment without backed-up owner IDs; never run on production';
  end if;
  if (select external_invites_enabled from tr8_private.app_config where singleton) then raise exception 'External onboarding must remain disabled'; end if;
  if (select jsonb_agg(to_jsonb(c) order by permission) from tr8_private.permission_catalog c) is distinct from (select data->'private'->'permission_catalog' from stage5_restore_backup) then raise exception 'Permission catalogue differs'; end if;
  if (select count(*) from tr8_private.process_runtime)<>1 then raise exception 'Expected the stage-4 singleton runtime'; end if;
  perform 1 from tr8_private.process_runtime where singleton for update;
end; $isolated_only$;
insert into auth.users(id,email,email_confirmed_at,created_at,updated_at,aud,role)
select (u->>'id')::uuid,u->>'email',(u->>'email_confirmed_at')::timestamptz,(u->>'created_at')::timestamptz,(u->>'created_at')::timestamptz,'authenticated','authenticated'
from stage5_restore_backup b cross join lateral jsonb_array_elements(b.data->'owners') u;
update tr8_private.app_config set owner_email=(select data->'private'->'app_config'->0->>'owner_email' from stage5_restore_backup) where singleton;
${beforeContent.map(tableInsert).join('\n')}
alter table public.tr8_workspace_projects disable trigger user;
alter table public.tr8_workspace_tasks disable trigger user;
insert into public.tr8_workspace_projects(id,owner_id,workspace_id,name,description,color,status,archived_at,version,created_at,updated_at)
select p.id,p.owner_id,p.workspace_id,p.name,p.description,p.color,p.status,p.archived_at,p.version,p.created_at,p.updated_at
from stage5_restore_backup b cross join lateral jsonb_populate_recordset(null::public.tr8_workspace_projects,b.data->'projects') p;
insert into public.tr8_workspace_tasks(id,owner_id,workspace_id,project_id,assignee_member_id,task_number,title,description,status,priority,start_date,due_date,position,version,created_at,updated_at,scheduled_start_at,scheduled_end_at,scheduled_time_zone)
overriding system value
select t.id,t.owner_id,t.workspace_id,t.project_id,t.assignee_member_id,t.task_number,t.title,t.description,t.status,t.priority,t.start_date,t.due_date,t.position,t.version,t.created_at,t.updated_at,t.scheduled_start_at,t.scheduled_end_at,t.scheduled_time_zone
from stage5_restore_backup b cross join lateral jsonb_populate_recordset(null::public.tr8_workspace_tasks,b.data->'tasks') t;
alter table public.tr8_workspace_projects enable trigger user;
alter table public.tr8_workspace_tasks enable trigger user;
${afterContent.map(tableInsert).join('\n')}
insert into tr8_private.workspace_activity overriding system value select x.* from stage5_restore_backup b cross join lateral jsonb_populate_recordset(null::tr8_private.workspace_activity,b.data->'private'->'workspace_activity') x;
${['process_outbox', 'process_jobs', 'process_attempts'].map(tableInsert).join('\n')}
update tr8_private.process_runtime t set scheduler_enabled=x.scheduler_enabled,last_run_at=x.last_run_at,last_finished_at=x.last_finished_at,day=x.day,used_today=x.used_today,month=x.month,used_month=x.used_month,daily_limit=x.daily_limit,monthly_limit=x.monthly_limit
from stage5_restore_backup b cross join lateral jsonb_populate_recordset(null::tr8_private.process_runtime,b.data->'private'->'process_runtime') x where t.singleton=x.singleton;
create temporary sequence stage5_exported_sequence;
select setval('stage5_exported_sequence',(select (data->'sequence'->>'last_value')::bigint from stage5_restore_backup),(select (data->'sequence'->>'is_called')::boolean from stage5_restore_backup));
${checks}
${migrations.join('\n')}
${checks}
do $sequence_and_gate$ begin
  if (select jsonb_build_object('last_value',last_value,'is_called',is_called) from stage5_exported_sequence) is distinct from (select data->'sequence' from stage5_restore_backup) then raise exception 'Exported sequence restoration differs'; end if;
  if (select external_invites_enabled from tr8_private.app_config where singleton) then raise exception 'Migration enabled external onboarding'; end if;
end; $sequence_and_gate$;
select jsonb_build_object('restoration','passed','migration_preservation','passed','projects',(select jsonb_array_length(data->'projects') from stage5_restore_backup),'tasks',(select jsonb_array_length(data->'tasks') from stage5_restore_backup),'private_metadata','passed','stage4_process_metadata','passed','auth_restore','minimal_identity_only') as stage5_rehearsal;
rollback;
`;
writeFileSync(resolve(outputPath), sql, { encoding: 'utf8', flag: 'wx' });
console.log('Rollback-only stage-5 rehearsal written outside the repository. No database commands were executed.');
