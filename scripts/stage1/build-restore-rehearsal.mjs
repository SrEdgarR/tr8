import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Produces a rollback-only rehearsal. Backup and output belong outside Git.
const [backupPath, migrationPath, outputPath] = process.argv.slice(2);
if (!backupPath || !migrationPath || !outputPath) throw new Error('Expected backup, migration and private output paths.');
const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
if (backup.format !== 'tr8-stage1-backup-v1' || !Array.isArray(backup.projects) || !Array.isArray(backup.tasks)) throw new Error('Unsupported backup.');
if (!Array.isArray(backup.owners) || !backup.owner_config || !backup.sequence) throw new Error('Incomplete backup.');
const migration = readFileSync(migrationPath, 'utf8');
if (!migration.trim()) throw new Error('Migration is empty.');
if (/^\s*(?:begin|commit|rollback|start\s+transaction|end\s+transaction)\s*;/im.test(migration))
  throw new Error('Migration must not contain transaction boundaries inside a rollback-only rehearsal.');
const literal = JSON.stringify(backup).replaceAll("'", "''");
const sql = `begin;
set local statement_timeout = '60s';
do $$ begin
  if exists(select 1 from public.tr8_projects) or exists(select 1 from public.tr8_tasks) then
    raise exception 'Restoration rehearsal requires empty isolated legacy tables';
  end if;
end $$;
create temporary table stage1_restore_backup as select '${literal}'::jsonb as data;
insert into auth.users(id,email,email_confirmed_at,created_at,updated_at,aud,role)
select (u->>'id')::uuid,u->>'email',(u->>'email_confirmed_at')::timestamptz,
       (u->>'created_at')::timestamptz,(u->>'created_at')::timestamptz,'authenticated','authenticated'
from stage1_restore_backup b cross join lateral jsonb_array_elements(b.data->'owners') u;
update tr8_private.app_config set owner_email=(select data->'owner_config'->>'owner_email' from stage1_restore_backup);
alter table public.tr8_projects disable trigger user;
alter table public.tr8_tasks disable trigger user;
insert into public.tr8_projects(id,owner_id,name,description,color,status,archived_at,version,created_at,updated_at)
select p.id,p.owner_id,p.name,p.description,p.color,p.status,p.archived_at,p.version,p.created_at,p.updated_at
from stage1_restore_backup b cross join lateral jsonb_populate_recordset(null::public.tr8_projects,b.data->'projects') p;
insert into public.tr8_tasks(id,owner_id,project_id,task_number,title,description,status,priority,start_date,due_date,position,version,created_at,updated_at)
overriding system value
select t.id,t.owner_id,t.project_id,t.task_number,t.title,t.description,t.status,t.priority,t.start_date,t.due_date,t.position,t.version,t.created_at,t.updated_at
from stage1_restore_backup b cross join lateral jsonb_populate_recordset(null::public.tr8_tasks,b.data->'tasks') t;
alter table public.tr8_projects enable trigger user;
alter table public.tr8_tasks enable trigger user;
select setval('public.tr8_tasks_task_number_seq', (select (data->'sequence'->>'last_value')::bigint from stage1_restore_backup), (select (data->'sequence'->>'is_called')::boolean from stage1_restore_backup));
do $$ begin
  if (select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) from public.tr8_projects p)
     is distinct from (select data->'projects' from stage1_restore_backup) then raise exception 'Legacy projects restoration differs'; end if;
  if (select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) from public.tr8_tasks t)
     is distinct from (select data->'tasks' from stage1_restore_backup) then raise exception 'Legacy tasks restoration differs'; end if;
end $$;
${migration}
do $$ begin
  if (select coalesce(jsonb_agg((to_jsonb(p)-'workspace_id'-'created_by') order by p.id),'[]'::jsonb) from public.tr8_workspace_projects p)
     is distinct from (select data->'projects' from stage1_restore_backup) then raise exception 'Migrated projects differ'; end if;
  if (select coalesce(jsonb_agg((to_jsonb(t)-'workspace_id'-'created_by') order by t.id),'[]'::jsonb) from public.tr8_workspace_tasks t)
     is distinct from (select data->'tasks' from stage1_restore_backup) then raise exception 'Migrated tasks differ'; end if;
  if (select jsonb_build_object('last_value',last_value,'is_called',is_called) from public.tr8_tasks_task_number_seq)
     is distinct from (select data->'sequence' from stage1_restore_backup) then raise exception 'Sequence changed'; end if;
end $$;
select jsonb_build_object('restoration','passed','migration_preservation','passed','projects',(select count(*) from public.tr8_workspace_projects),'tasks',(select count(*) from public.tr8_workspace_tasks)) as stage1_rehearsal;
rollback;
`;
writeFileSync(resolve(outputPath), sql, { encoding: 'utf8', flag: 'wx' });
console.log('Rollback-only restoration rehearsal written to the private output path.');
