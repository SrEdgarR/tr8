import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Usage: node scripts/project-deletion/concurrency.mjs kajcbwlnqcwcpbtqyieo <private-output-directory>
// Only committed synthetic fixtures in the designated TEST project are touched.
const TEST = 'kajcbwlnqcwcpbtqyieo';
const [requestedProject, outputDirectory, ...extra] = process.argv.slice(2);
if (requestedProject !== TEST || !outputDirectory || extra.length) throw new Error('Requires the literal TEST ref and a private output directory.');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = resolve(outputDirectory);
const fromRepository = relative(root, output);
if (!isAbsolute(outputDirectory) || !(fromRepository === '..' || fromRepository.startsWith(`..${sep}`) || isAbsolute(fromRepository)))
  throw new Error('Output must be an absolute directory outside the repository.');
const cli = resolve(process.env.TR8_SUPABASE_CLI || `${homedir()}/.codex/tmp/tr8-stage1-tools/supabase.exe`);
const actor = 'f9e10000-0000-4000-8000-000000000001';
const workspace = 'd9e10000-0000-4000-8000-000000000001';
const member = 'b9e10000-0000-4000-8000-000000000001';
const email = 'tr8-project-delete-concurrency@example.test';
const projects = [1, 2, 3, 4].map(n => `a9e1000${n}-0000-4000-8000-00000000000${n}`);
const tasks = [1, 2, 3, 4].map(n => `e9e1000${n}-0000-4000-8000-00000000000${n}`);
const literalIds = ids => ids.map(id => `'${id}'::uuid`).join(',');
let sequence = 0;
const pending = [];
await mkdir(output, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function query(label, sql) {
  const path = resolve(output, `${String(++sequence).padStart(2, '0')}-${label}.sql`);
  await writeFile(path, sql, { mode: 0o600 });
  const result = new Promise((accept, reject) => {
    execFile(
      cli,
      ['db', 'query', '--linked', '--project-ref', TEST, '--file', path, '--output', 'json'],
      { cwd: root, timeout: 50000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`${label}: ${String(stderr || error.message).slice(0, 1000)}`));
        try {
          const response = JSON.parse(stdout);
          if (!Array.isArray(response.rows)) throw new Error('Missing query rows');
          accept(response.rows[0]?.proof);
        } catch {
          reject(new Error(`${label}: unexpected CLI response`));
        }
      },
    );
  });
  pending.push(result);
  const proof = await result;
  await writeFile(path.replace(/\.sql$/, '.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
  return proof;
}

const fingerprintSql = `select jsonb_build_object(
 'projects',(select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p where workspace_id<>'${workspace}'),
 'tasks',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t where workspace_id<>'${workspace}'),
 'project_count',(select count(*) from public.tr8_workspace_projects where workspace_id<>'${workspace}'),
 'task_count',(select count(*) from public.tr8_workspace_tasks where workspace_id<>'${workspace}'),
 'app_config',(select to_jsonb(c) from tr8_private.app_config c where singleton),
 'synthetic_marker',exists(select 1 from auth.users where email like 'tr8-stage1-http-owner-%@example.test'),
 'delete_rpc_ready',to_regprocedure('public.tr8_v2_delete_project(uuid,bigint,text)') is not null,
 'permission_ready',exists(select 1 from tr8_private.permission_catalog where permission='project.delete')
) proof;`;
const before = await query('before', fingerprintSql);
assert(before?.synthetic_marker && before.app_config.external_invites_enabled === false, 'Not the closed synthetic TEST environment.');
assert(before.delete_rpc_ready && before.permission_ready, 'Install the project deletion migration in TEST before creating fixtures.');
const claims = `select set_config('request.jwt.claim.sub','${actor}',true);
select set_config('request.jwt.claims','{"sub":"${actor}","role":"authenticated"}',true);
set local role authenticated;`;
const create = n => `select public.tr8_v2_create_task('${workspace}','${tasks[n]}','${projects[n]}','Concurrent child fixture','','todo','none',null,null);`;
const update = n => `select public.tr8_v2_update_task('${workspace}','${tasks[n]}',1,'{"title":"Concurrent updated fixture"}');`;
const remove = n => `select public.tr8_v2_delete_project('${projects[n]}',1,'Concurrency fixture ${n + 1}');`;

const cleanupSql = `begin;
set local statement_timeout='15s';
do $$begin
 if not exists(select 1 from auth.users where id='${actor}' and email='${email}')
   or not exists(select 1 from tr8_private.workspaces where id='${workspace}' and owner_id='${actor}' and name='Deletion concurrency synthetic') then
   raise exception 'Fixture identity guard refused cleanup';
 end if;
 if exists(select 1 from public.tr8_workspace_projects where workspace_id='${workspace}' and id not in (${literalIds(projects)}))
   or exists(select 1 from public.tr8_workspace_tasks where workspace_id='${workspace}' and id not in (${literalIds(tasks)}))
   or exists(select 1 from tr8_private.google_connections where user_id='${actor}') then
   raise exception 'Unexpected fixture children; manual review required';
 end if;
end;$$;
delete from public.tr8_workspace_tasks where workspace_id='${workspace}' and id in (${literalIds(tasks)});
delete from tr8_private.project_access where workspace_id='${workspace}' and project_id in (${literalIds(projects)});
delete from tr8_private.workspace_activity where workspace_id='${workspace}';
delete from public.tr8_workspace_projects where workspace_id='${workspace}' and id in (${literalIds(projects)});
delete from tr8_private.process_attempts where workspace_id='${workspace}';
delete from tr8_private.process_jobs j using tr8_private.process_outbox o where j.outbox_id=o.id and o.workspace_id='${workspace}';
delete from tr8_private.process_outbox where workspace_id='${workspace}';
delete from tr8_private.workspace_authz_state where workspace_id='${workspace}';
delete from tr8_private.workspace_members where workspace_id='${workspace}' and id='${member}' and user_id='${actor}';
delete from tr8_private.workspaces where id='${workspace}' and owner_id='${actor}' and name='Deletion concurrency synthetic';
delete from tr8_private.app_users where user_id='${actor}' and display_name='Deletion concurrency synthetic';
delete from auth.users where id='${actor}' and email='${email}';
drop table tr8_private.project_delete_concurrency_gate;
commit;
select jsonb_build_object('fixture_projects',(select count(*) from public.tr8_workspace_projects where id in (${literalIds(projects)})),
 'fixture_tasks',(select count(*) from public.tr8_workspace_tasks where id in (${literalIds(tasks)})),
 'fixture_workspace',(select count(*) from tr8_private.workspaces where id='${workspace}'),
 'fixture_actor',(select count(*) from auth.users where id='${actor}'),
 'fixture_gate',case when to_regclass('tr8_private.project_delete_concurrency_gate') is null then 0 else 1 end) proof;`;
await writeFile(resolve(output, 'cleanup.sql'), cleanupSql, { mode: 0o600 });
let setupComplete = false;
let cleanup;
let failure;
const cases = [];

async function observe(label, sql, predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await query(label, sql);
    if (predicate(result)) return result;
    await new Promise(accept => setTimeout(accept, 150));
  } while (Date.now() < deadline);
  throw new Error(`${label}: no database lock wait observed`);
}

try {
  await query(
    'setup',
    `begin;
do $$begin
 if exists(select 1 from auth.users where id='${actor}' or email='${email}') or exists(select 1 from tr8_private.workspaces where id='${workspace}')
   or exists(select 1 from public.tr8_workspace_projects where id in (${literalIds(projects)}))
   or exists(select 1 from public.tr8_workspace_tasks where id in (${literalIds(tasks)}))
   or to_regclass('tr8_private.project_delete_concurrency_gate') is not null then raise exception 'Fixture IDs already exist; refusing reuse';end if;
end;$$;
create table tr8_private.project_delete_concurrency_gate(id integer primary key,workspace_id uuid not null,released boolean not null default false);
alter table tr8_private.project_delete_concurrency_gate enable row level security;
revoke all on table tr8_private.project_delete_concurrency_gate from public,anon,authenticated,service_role;
insert into tr8_private.project_delete_concurrency_gate(id,workspace_id) select n,'${workspace}'::uuid from generate_series(0,3)n;
insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values('${actor}','authenticated','authenticated','${email}',now(),'{}','{}',now(),now());
insert into tr8_private.app_users(user_id,display_name) values('${actor}','Deletion concurrency synthetic');
insert into tr8_private.workspaces(id,kind,owner_id,name) values('${workspace}','team','${actor}','Deletion concurrency synthetic');
insert into tr8_private.workspace_authz_state(workspace_id) values('${workspace}');
insert into tr8_private.workspace_members(id,workspace_id,user_id) values('${member}','${workspace}','${actor}');
${claims}
${projects.map((id, n) => `select public.tr8_v2_create_project('${workspace}','${id}','Concurrency fixture ${n + 1}','','#5A67D8','active');`).join('\n')}
${create(1)}
${create(2)}
commit;select jsonb_build_object('ok',true) proof;`,
  );
  setupComplete = true;
  const scenarios = [
    { name: 'delete-first-create', n: 0, first: remove(0), second: create(0), denied: true },
    { name: 'delete-first-update', n: 1, first: remove(1), second: update(1), denied: true },
    { name: 'update-first-delete', n: 2, first: update(2), second: remove(2), denied: false },
    { name: 'create-first-delete', n: 3, first: create(3), second: remove(3), denied: false },
  ];
  for (const scenario of scenarios) {
    const tagA = `tr8-delete-concurrency-${scenario.n}-a`;
    const tagB = `tr8-delete-concurrency-${scenario.n}-b`;
    const first = query(
      `${scenario.name}-a`,
      `begin;
set local statement_timeout='45s';set local application_name='${tagA}';
${claims}
${scenario.first}
reset role;
do $$declare deadline timestamptz:=clock_timestamp()+interval '40 seconds';begin
 loop
  exit when (select released from tr8_private.project_delete_concurrency_gate where id=${scenario.n} and workspace_id='${workspace}');
  if clock_timestamp()>deadline then raise exception 'Synthetic gate release timed out';end if;
  perform pg_sleep(0.1);
 end loop;
end;$$;
commit;select jsonb_build_object('committed',true) proof;`,
    );
    void first.catch(() => {});
    await observe(
      `${scenario.name}-holder`,
      `select jsonb_build_object('holding',exists(select 1 from pg_stat_activity where application_name='${tagA}' and wait_event='PgSleep')) proof;`,
      value => value?.holding,
    );
    const secondStatement = scenario.denied
      ? `do $$begin begin ${scenario.second.replace(/^select /, 'perform ')} raise exception 'Concurrent write unexpectedly succeeded';
         exception when sqlstate 'PT404' then null;end;end;$$;`
      : scenario.second;
    const started = Date.now();
    const second = query(
      `${scenario.name}-b`,
      `begin;
set local statement_timeout='45s';set local application_name='${tagB}';
${claims}
${secondStatement}
commit;select jsonb_build_object('outcome','${scenario.denied ? 'PT404' : 'committed'}') proof;`,
    );
    void second.catch(() => {});
    const blocked = await observe(
      `${scenario.name}-blocking`,
      `select jsonb_build_object('blocked',exists(
 select 1 from pg_stat_activity a join pg_stat_activity b on a.pid=any(pg_blocking_pids(b.pid))
 where a.application_name='${tagA}' and b.application_name='${tagB}' and b.wait_event_type='Lock'),
 'holder_pid',(select pid from pg_stat_activity where application_name='${tagA}'),
 'waiter_pid',(select pid from pg_stat_activity where application_name='${tagB}')) proof;`,
      value => value?.blocked,
    );
    await query(
      `${scenario.name}-release`,
      `update tr8_private.project_delete_concurrency_gate set released=true where id=${scenario.n} and workspace_id='${workspace}';select jsonb_build_object('released',true) proof;`,
    );
    const [a, b] = await Promise.all([first, second]);
    assert(a?.committed && b?.outcome === (scenario.denied ? 'PT404' : 'committed'), `${scenario.name}: wrong outcome`);
    const removed = await query(
      `${scenario.name}-removed`,
      `select jsonb_build_object(
 'project_absent',not exists(select 1 from public.tr8_workspace_projects where id='${projects[scenario.n]}'),
 'tasks_absent',not exists(select 1 from public.tr8_workspace_tasks where project_id='${projects[scenario.n]}')) proof;`,
    );
    assert(removed?.project_absent && removed?.tasks_absent, `${scenario.name}: project or child survived`);
    cases.push({ name: scenario.name, blocked, second: b.outcome, elapsed_ms: Date.now() - started, ...removed });
    process.stdout.write(`${JSON.stringify(cases.at(-1))}\n`);
  }
} catch (error) {
  failure = error;
} finally {
  await Promise.allSettled(pending);
  if (setupComplete) cleanup = await query('cleanup', cleanupSql);
}

const after = await query('after', fingerprintSql);
const originalsUnchanged =
  before.projects === after.projects && before.tasks === after.tasks && JSON.stringify(before.app_config) === JSON.stringify(after.app_config);
assert(originalsUnchanged, 'Original domain rows or application configuration changed.');
assert(!cleanup || Object.values(cleanup).every(value => value === 0), 'Fixture cleanup incomplete.');
const proof = {
  test_project: TEST,
  captured_at: new Date().toISOString(),
  cases,
  before,
  after,
  cleanup,
  originals_unchanged: originalsUnchanged,
  success: !failure,
};
await writeFile(resolve(output, 'project-deletion-concurrency-proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
if (failure) throw failure;
process.stdout.write(`${JSON.stringify({ success: true, scenarios: cases.length, originals_unchanged: originalsUnchanged, cleanup })}\n`);
