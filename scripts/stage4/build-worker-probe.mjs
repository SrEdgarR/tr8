/**
 * Prepare private, separately committed SQL probes for the designated test DB.
 * No network access. Run HTTP fixtures first, then execute the generated phases
 * in numeric order via the privileged test-project SQL tool. Never production.
 * Each execute_sql call commits one phase; combining phases defeats recovery QA.
 * Optional budget race: run phase 09 twice concurrently after 08, then 10, and
 * always run 11 in finally to restore the test worker and temporary counters.
 * Usage: node scripts/stage4/build-worker-probe.mjs <private-config.json> <out-dir>
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const TEST_HOST = 'kajcbwlnqcwcpbtqyieo.supabase.co';
const PRODUCTION_USER = '74368b81-39f8-4bc3-bbbf-f541b64df4cf';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
class ProbeError extends Error {}

async function main() {
  if (!process.argv[2] || !process.argv[3]) throw new ProbeError('Expected private config and output directory');
  const configPath = resolve(process.argv[2]);
  const output = resolve(process.argv[3]);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const url = new URL(config.url);
  if (url.protocol !== 'https:' || url.hostname !== TEST_HOST || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new ProbeError('Only the designated disposable project is permitted');
  const result = JSON.parse(await readFile(join(dirname(configPath), 'http-stage4-result.json'), 'utf8'));
  if (result.result !== 'passed' || result.projectRef !== TEST_HOST.split('.')[0]) throw new ProbeError('Passed synthetic HTTP evidence is required');
  const actor = config.users?.owner;
  const ids = result.ids;
  if (!actor || !/^[^@\s]+@example\.test$/i.test(actor.email) || !uuid(actor.id) || actor.id === PRODUCTION_USER)
    throw new ProbeError('Only a synthetic enabled owner is permitted');
  for (const name of ['workspaceId', 'projectId', 'taskId']) if (!uuid(ids?.[name])) throw new ProbeError('Synthetic fixture identifiers are required');
  if (ids.workspaceId !== config.teamId) throw new ProbeError('Fixture workspace mismatch');
  await mkdir(output, { recursive: true });
  const guard = `
do $guard$ begin
  if exists(select 1 from tr8_private.app_users where user_id='${PRODUCTION_USER}'::uuid and enabled)
    or not exists(select 1 from auth.users where id='${actor.id}'::uuid and email like '%@example.test')
    or not exists(select 1 from tr8_private.workspaces where id='${ids.workspaceId}'::uuid and owner_id='${actor.id}'::uuid)
    or not exists(select 1 from public.tr8_workspace_tasks where id='${ids.taskId}'::uuid and workspace_id='${ids.workspaceId}'::uuid and project_id='${ids.projectId}'::uuid)
  then raise exception 'Refusing worker probe: not the designated synthetic fixtures'; end if;
end; $guard$;
`;
  const actorSql = `select set_config('request.jwt.claim.sub','${actor.id}',true);
select set_config('request.jwt.claims','{"sub":"${actor.id}","role":"authenticated"}',true);`;
  const sql = (name, body) =>
    writeFile(join(output, name), `-- Test-only worker probe. Execute this file in its own SQL request.\nbegin;\n${guard}\n${body}\ncommit;\n`, {
      mode: 0o600,
    });

  await sql(
    '01-prepare-lease.sql',
    `${actorSql}
create table tr8_private.stage4_worker_probe (
  singleton boolean primary key default true check(singleton),
  job_id uuid not null,
  first_token uuid,
  second_token uuid,
  autonomous_job_id uuid,
  autonomous_created_at timestamptz
);
alter table tr8_private.stage4_worker_probe enable row level security;
revoke all on tr8_private.stage4_worker_probe from public,anon,authenticated,service_role;
select public.tr8_v2_update_task('${ids.workspaceId}','${ids.taskId}',
  (select version from public.tr8_workspace_tasks where id='${ids.taskId}'),
  jsonb_build_object('title','Synthetic stage 4 durable recovery probe'));
insert into tr8_private.stage4_worker_probe(singleton,job_id)
select true,j.id from tr8_private.process_jobs j join tr8_private.process_outbox e on e.id=j.outbox_id
  join public.tr8_workspace_tasks t on t.id=e.entity_id and t.workspace_id=e.workspace_id
where t.id='${ids.taskId}' and e.entity_kind='task' and e.entity_version=t.version and e.entity_created_at=t.created_at;
update tr8_private.process_jobs set available_at=clock_timestamp()+interval '1 hour'
  where id=(select job_id from tr8_private.stage4_worker_probe);
select 'prepared valid synthetic job; no worker called' as evidence;`,
  );

  await sql(
    '02-claim-and-commit.sql',
    `do $probe$ declare v_claim jsonb; v_job uuid; begin
  select job_id into strict v_job from tr8_private.stage4_worker_probe;
  update tr8_private.process_jobs set available_at='2000-01-01T00:00:00Z' where id=v_job;
  select value into v_claim from jsonb_array_elements(tr8_private.v4_claim_jobs(1)) where (value->>'id')::uuid=v_job;
  if v_claim is null then raise exception 'Target job was not claimed'; end if;
  update tr8_private.stage4_worker_probe set first_token=(v_claim->>'lease_token')::uuid;
end; $probe$;
select state='leased' and attempts=1 and lease_token=(select first_token from tr8_private.stage4_worker_probe) as claim_durable_before_commit
  from tr8_private.process_jobs where id=(select job_id from tr8_private.stage4_worker_probe);`,
  );

  await sql(
    '03-recover-after-commit.sql',
    `do $probe$ declare p tr8_private.stage4_worker_probe; j tr8_private.process_jobs; v_claim jsonb; begin
  select * into strict p from tr8_private.stage4_worker_probe;
  select * into strict j from tr8_private.process_jobs where id=p.job_id;
  if j.state<>'leased' or j.attempts<>1 or j.lease_token is distinct from p.first_token then
    raise exception 'The prior committed lease was not durable'; end if;
  -- Simulates a crashed worker and elapsed lease without sleeping or rewinding
  -- any domain data. Only this synthetic process lease is expired.
  update tr8_private.process_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=p.job_id;
  select value into v_claim from jsonb_array_elements(tr8_private.v4_claim_jobs(1)) where (value->>'id')::uuid=p.job_id;
  if v_claim is null or (v_claim->>'lease_token')::uuid=p.first_token or (v_claim->>'attempt')::integer<>2 then
    raise exception 'Expired committed lease was not reclaimed with a new token'; end if;
  update tr8_private.stage4_worker_probe set second_token=(v_claim->>'lease_token')::uuid;
  if tr8_private.v4_finish_job(p.job_id,p.first_token,'succeeded') then
    raise exception 'A stale worker confirmed a reclaimed job'; end if;
end; $probe$;
select 'committed lease recovered; stale token rejected' as evidence;`,
  );

  await sql(
    '04-confirm-recovery.sql',
    `do $probe$ declare p tr8_private.stage4_worker_probe; begin
  select * into strict p from tr8_private.stage4_worker_probe;
  if not tr8_private.v4_finish_job(p.job_id,p.second_token,'succeeded') then
    raise exception 'Current committed lease did not confirm'; end if;
  if tr8_private.v4_finish_job(p.job_id,p.first_token,'succeeded')
    or tr8_private.v4_finish_job(p.job_id,p.second_token,'succeeded') then
    raise exception 'Terminal job accepted duplicate confirmation'; end if;
end; $probe$;
select state='succeeded' and reason='reconciled' and attempts=2 and lease_token is null and lease_expires_at is null as recovered_exactly_once_internally
  from tr8_private.process_jobs where id=(select job_id from tr8_private.stage4_worker_probe);`,
  );

  await sql(
    '05-prepare-autonomous.sql',
    `${actorSql}
select public.tr8_v2_update_task('${ids.workspaceId}','${ids.taskId}',
  (select version from public.tr8_workspace_tasks where id='${ids.taskId}'),
  jsonb_build_object('title','Synthetic stage 4 autonomous cron probe'));
update tr8_private.stage4_worker_probe p set autonomous_job_id=q.id,autonomous_created_at=q.created_at
from(select j.id,j.created_at from tr8_private.process_jobs j join tr8_private.process_outbox e on e.id=j.outbox_id
  join public.tr8_workspace_tasks t on t.id=e.entity_id and t.workspace_id=e.workspace_id
  where t.id='${ids.taskId}' and e.entity_kind='task' and e.entity_version=t.version and e.entity_created_at=t.created_at) q;
select 'committed job ready; do not call worker manually; inspect after cron runs' as evidence;`,
  );

  await sql(
    '06-inspect-autonomous.sql',
    `select j.state,j.reason,j.attempts,
  j.state='succeeded' and j.reason='reconciled' and j.attempts=1 as autonomous_job_passed,
  exists(select 1 from cron.job_run_details r join cron.job c on c.jobid=r.jobid
    where c.jobname='tr8-process-worker' and r.status='succeeded' and r.start_time>=p.autonomous_created_at
      and r.start_time<=j.finished_at and r.end_time>=j.finished_at) as successful_cron_run_observed,
  (select active from cron.job where jobname='tr8-process-worker') as scheduler_active
from tr8_private.stage4_worker_probe p join tr8_private.process_jobs j on j.id=p.autonomous_job_id;`,
  );
  await sql(
    '07-cleanup-probe.sql',
    `drop table tr8_private.stage4_worker_probe;
select 'removed only the synthetic probe table; domain fixtures remain isolated' as evidence;`,
  );
  const raceTasks = [randomUUID(), randomUUID()];
  await sql(
    '08-prepare-budget-race.sql',
    `${actorSql}
create table tr8_private.stage4_budget_probe (
  singleton boolean primary key default true check(singleton),runtime_before jsonb not null,
  worker_active boolean not null,job_ids uuid[],created_at timestamptz not null default clock_timestamp()
);
alter table tr8_private.stage4_budget_probe enable row level security;
revoke all on tr8_private.stage4_budget_probe from public,anon,authenticated,service_role;
insert into tr8_private.stage4_budget_probe(singleton,runtime_before,worker_active)
  select true,to_jsonb(r),(select active from cron.job where jobname='tr8-process-worker')
  from tr8_private.process_runtime r where singleton;
select cron.alter_job((select jobid from cron.job where jobname='tr8-process-worker'),active=>false);
${raceTasks
  .map(
    (task, i) => `select public.tr8_v2_create_task('${ids.workspaceId}','${task}','${ids.projectId}',
  'Synthetic stage 4 parallel budget ${i + 1}','Synthetic concurrency verification','todo','none',null,null);`,
  )
  .join('\n')}
update tr8_private.stage4_budget_probe set job_ids=(select array_agg(j.id) from tr8_private.process_jobs j
  join tr8_private.process_outbox e on e.id=j.outbox_id where e.entity_id=any(array['${raceTasks[0]}'::uuid,'${raceTasks[1]}'::uuid]) and e.entity_version=1);
update tr8_private.process_jobs set available_at='2000-01-01T00:00:00Z'
  where id=any((select job_ids from tr8_private.stage4_budget_probe)::uuid[]);
update tr8_private.process_runtime set day=(clock_timestamp() at time zone 'UTC')::date,used_today=daily_limit-1,
  month=date_trunc('month',clock_timestamp() at time zone 'UTC')::date,used_month=0 where singleton;
select 'two eligible synthetic jobs; one shared budget slot; TEST cron paused until mandatory phase 11' as evidence;`,
  );
  await sql(
    '09-concurrent-claim.sql',
    `create temporary table tr8_stage4_parallel_claim on commit drop as
  select jsonb_array_length(tr8_private.v4_claim_jobs(1)) as claimed;
select pg_sleep(2);
select claimed from tr8_stage4_parallel_claim;`,
  );
  await sql(
    '10-inspect-budget-race.sql',
    `do $probe$ declare v_ids uuid[]; begin
  select job_ids into strict v_ids from tr8_private.stage4_budget_probe;
  if cardinality(v_ids)<>2 or (select count(*) from tr8_private.process_jobs where id=any(v_ids) and state='leased' and attempts=1)<>1
    or (select count(*) from tr8_private.process_jobs where id=any(v_ids) and state='pending' and attempts=0)<>1
    or (select count(*) from tr8_private.process_attempts where job_id=any(v_ids))<>1
    or not exists(select 1 from tr8_private.process_runtime where singleton and used_today=daily_limit and used_month=1) then
    raise exception 'Concurrent claims exceeded a shared budget or lost work'; end if;
end; $probe$;
select 'concurrent connections reserved exactly one shared slot; second job remained durable' as evidence;`,
  );
  await sql(
    '11-mandatory-budget-cleanup.sql',
    `-- Mandatory finally step even if phase 09 or 10 fails. Preserve real probe
-- reservation consumption; restore only the temporary test quota scenario.
update tr8_private.process_runtime r set
  day=(p.runtime_before->>'day')::date,
  used_today=(p.runtime_before->>'used_today')::integer+(select count(*) from tr8_private.process_attempts where job_id=any(p.job_ids)),
  month=(p.runtime_before->>'month')::date,
  used_month=(p.runtime_before->>'used_month')::integer+(select count(*) from tr8_private.process_attempts where job_id=any(p.job_ids))
from tr8_private.stage4_budget_probe p where r.singleton;
select cron.alter_job((select jobid from cron.job where jobname='tr8-process-worker'),
  active=>(select worker_active from tr8_private.stage4_budget_probe));
drop table tr8_private.stage4_budget_probe;
select (select active from cron.job where jobname='tr8-process-worker') as scheduler_restored,
  not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='tr8_private' and c.relname in ('stage4_worker_probe','stage4_budget_probe')) as probe_tables_removed;`,
  );
  console.log(
    'Prepared 7 recovery/autonomous phases and optional phases 08-11 for a real budget race. Run 02/03/04 promptly as separate committed requests. Run 06 after cron. Run 09 twice concurrently and phase 11 in finally.',
  );
}

main().catch(error => {
  console.error(error instanceof ProbeError ? error.message : 'Worker probe preparation failed: local configuration or output error');
  process.exitCode = 1;
});
