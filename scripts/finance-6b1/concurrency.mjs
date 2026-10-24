import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run only after the synthetic finance migration is installed in TEST.
// Usage: node scripts/finance-6b1/concurrency.mjs kajcbwlnqcwcpbtqyieo <private-output> [--close-gate]
// Default cleanup leaves the shared TEST gate alone for the independent HTTP
// suite. --close-gate is reserved for the orchestrator after that suite finishes.
const TEST = 'kajcbwlnqcwcpbtqyieo';
const [project, destination, option, ...extra] = process.argv.slice(2);
if (project !== TEST || !destination || (option && option !== '--close-gate') || extra.length)
  throw new Error('Requires literal TEST ref and a private output directory.');
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = resolve(destination);
if (!isAbsolute(destination) || !relative(root, output).startsWith('..')) throw new Error('Private output must be outside the repository.');
const cli = resolve(process.env.TR8_SUPABASE_CLI || `${homedir()}/.codex/tmp/tr8-stage1-tools/supabase.exe`);
const owners = Array.from({ length: 7 }, (_, n) => `f6b20000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`);
const sessions = Array.from({ length: 7 }, (_, n) => `f6b21000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`);
const ids = values => values.map(value => `'${value}'::uuid`).join(',');
const sqlText = value => `'${String(value).replaceAll("'", "''")}'`;
const b64 = (length, seed) => Buffer.alloc(length, seed).toString('base64url');
const rows = [];
const pending = [];
let sequence = 0;
let setupComplete = false;
let cleanup;
let failure;
await mkdir(output, { recursive: true });

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

async function query(label, sql) {
  const path = resolve(output, `${String(++sequence).padStart(3, '0')}-${label}.sql`);
  await writeFile(path, sql, { mode: 0o600 });
  const promise = new Promise((accept, reject) => {
    execFile(
      cli,
      ['db', 'query', '--linked', '--project-ref', TEST, '--file', path, '--output', 'json'],
      { cwd: root, timeout: 60000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // Keep any SQL diagnostics private; never print request/envelope bodies.
          void writeFile(`${path}.error.log`, String(stderr || error.message), { mode: 0o600 }).catch(() => {});
          return reject(new Error(`${label}: SQL execution failed; inspect private diagnostic.`));
        }
        try {
          const result = JSON.parse(stdout);
          if (!Array.isArray(result.rows)) throw new Error();
          accept(result.rows[0]?.proof);
        } catch {
          reject(new Error(`${label}: unexpected CLI result`));
        }
      },
    );
  });
  pending.push(promise);
  return promise;
}

async function observe(label, sql, predicate, maximumMs = 12000) {
  const deadline = Date.now() + maximumMs;
  do {
    const value = await query(label, sql);
    if (predicate(value)) return value;
    await new Promise(done => setTimeout(done, 150));
  } while (Date.now() < deadline);
  throw new Error(`${label}: required PostgreSQL blocking relation was not observed`);
}

function envelope(owner, seed) {
  return {
    formatVersion: 1,
    suiteId: 'pulso-v1-aes256gcm-hkdfsha256-argon2id13',
    vaultId: b64(16, seed),
    ownerId: owner,
    keyEpoch: '1',
    credentialEpoch: '1',
    revision: '1',
    operationId: b64(16, seed + 1),
    payloadSchemaVersion: 1,
    passwordWrap: {
      wrapVersion: 1,
      slotEpoch: '1',
      kdfId: 'argon2id',
      argonVersion: 19,
      profileId: 'argon2id-64m-t3-p1-v1',
      memoryKiB: 65536,
      passes: 3,
      parallelism: 1,
      outputBytes: 32,
      salt: b64(16, 4),
      nonce: b64(12, 5),
      wrappedKey: b64(48, 6),
    },
    recoveryWrap: { wrapVersion: 1, slotEpoch: '1', schemeId: 'HKDF-SHA-256', salt: b64(32, 7), nonce: b64(12, 8), wrappedKey: b64(48, 9) },
    payload: { keySalt: b64(32, 10), nonce: b64(12, 11), ciphertext: b64(17, 12) },
  };
}
const envelopes = owners.map((owner, index) => envelope(owner, 100 + index * 3));
const putBody = (value, revision = '0') =>
  Buffer.from(JSON.stringify({ expectedRevision: revision, operationId: value.operationId, envelope: value })).toString('base64');
const next = value => ({
  ...structuredClone(value),
  revision: '2',
  operationId: b64(16, 180),
  payload: { keySalt: b64(32, 181), nonce: b64(12, 182), ciphertext: b64(17, 183) },
});
let proof;
const call = (index, action, { body = null, epoch = 1, vault = null, operation = null, expires = null, password = null } = {}) =>
  `public.tr8_server_finance(${sqlText(action)},'${owners[index]}','${sessions[index]}',${expires ?? proof.token_exp},${password ?? proof.password_at},${body === null ? 'null' : sqlText(body)},${epoch},${vault === null ? 'null' : sqlText(vault)},${operation === null ? 'null' : sqlText(operation)})`;

const fingerprint = `select jsonb_build_object(
 -- Exclude only the explicitly declared fixture of the independent deletion
 -- concurrency suite, which may be running at the same time in this TEST DB.
 'projects',(select md5(coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'')) from public.tr8_workspace_projects p where workspace_id<>'d9e10000-0000-4000-8000-000000000001'),
 'tasks',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.tr8_workspace_tasks t where workspace_id<>'d9e10000-0000-4000-8000-000000000001'),
 'app_config',(select to_jsonb(c) from tr8_private.app_config c where singleton),
 'synthetic_marker',exists(select 1 from auth.users where email like 'tr8-stage1-http-owner-%@example.test')
) proof;`;
const before = await query('baseline', fingerprint);
assert(before?.synthetic_marker && before.app_config.external_invites_enabled === false, 'Not the designated closed synthetic TEST environment.');

const cleanupSql = `begin; set local statement_timeout='20s';
do $$begin
 if exists(select 1 from auth.users where id in (${ids(owners)}) and email not like 'tr8-finance-race-%@example.test')
   or exists(select 1 from public.tr8_workspace_projects where owner_id in (${ids(owners)}))
   or exists(select 1 from public.tr8_workspace_tasks where owner_id in (${ids(owners)}))
   or exists(select 1 from tr8_private.workspaces where owner_id in (${ids(owners)})) then raise exception 'Unexpected fixture ownership; cleanup refused'; end if;
end; $$;
delete from tr8_finance.lifecycle_receipts where owner_id in (${ids(owners)});
delete from tr8_finance.receipts where owner_id in (${ids(owners)});
delete from tr8_finance.retired where owner_id in (${ids(owners)});
delete from tr8_finance.revoked_sessions where owner_id in (${ids(owners)});
delete from tr8_finance.vaults where owner_id in (${ids(owners)});
delete from tr8_finance.actors where owner_id in (${ids(owners)});
delete from tr8_finance.synthetic_allowlist where user_id in (${ids(owners)});
delete from auth.mfa_amr_claims where session_id in (${ids(sessions)});
delete from auth.sessions where id in (${ids(sessions)}) and user_id in (${ids(owners)});
delete from tr8_private.app_users where user_id in (${ids(owners)}) and display_name='Finance concurrency synthetic';
delete from auth.users where id in (${ids(owners)}) and email like 'tr8-finance-race-%@example.test';
drop table tr8_finance.concurrency_gate;
${option === '--close-gate' ? 'update tr8_finance.config set synthetic_enabled=false,restore_quarantined=true where singleton;' : '-- Shared gate deliberately left for the independent HTTP suite.'}
commit;
select jsonb_build_object('remaining_actors',(select count(*) from auth.users where id in (${ids(owners)})),
 'remaining_allowlist',(select count(*) from tr8_finance.synthetic_allowlist where user_id in (${ids(owners)})),
 'remaining_vaults',(select count(*) from tr8_finance.vaults where owner_id in (${ids(owners)})),
 'synthetic_enabled',(select synthetic_enabled from tr8_finance.config where singleton),
 'restore_quarantined',(select restore_quarantined from tr8_finance.config where singleton)) proof;`;
await writeFile(resolve(output, 'cleanup.sql'), cleanupSql, { mode: 0o600 });

try {
  proof = await query(
    'setup',
    `begin; set local statement_timeout='20s';
do $$begin if exists(select 1 from auth.users where id in (${ids(owners)}) or email like 'tr8-finance-race-%@example.test') or to_regclass('tr8_finance.concurrency_gate') is not null then raise exception 'Fixture IDs already exist; refusing reuse'; end if; end; $$;
create table tr8_finance.concurrency_gate(id integer primary key check(id between 0 and 6),released boolean not null default false);
alter table tr8_finance.concurrency_gate enable row level security;
revoke all on table tr8_finance.concurrency_gate from public,anon,authenticated,service_role;
insert into tr8_finance.concurrency_gate(id) select generate_series(0,6);
insert into auth.users(id,aud,role,email,email_confirmed_at,created_at,updated_at,is_anonymous)
 values ${owners.map((owner, index) => `('${owner}','authenticated','authenticated','tr8-finance-race-${index + 1}@example.test',clock_timestamp(),clock_timestamp(),clock_timestamp(),false)`).join(',')};
insert into tr8_private.app_users(user_id,enabled,display_name) values ${owners.map(owner => `('${owner}',true,'Finance concurrency synthetic')`).join(',')};
insert into auth.sessions(id,user_id,created_at,updated_at,not_after) values ${owners.map((owner, index) => `('${sessions[index]}','${owner}',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour')`).join(',')};
insert into auth.mfa_amr_claims(id,session_id,authentication_method,created_at,updated_at)
 select gen_random_uuid(),id,'password',date_trunc('second',clock_timestamp()),date_trunc('second',clock_timestamp()) from auth.sessions where id in (${ids(sessions)});
insert into tr8_finance.synthetic_allowlist(user_id) values ${owners.map(owner => `('${owner}')`).join(',')};
update tr8_finance.config set synthetic_enabled=true,restore_quarantined=false where singleton;
commit; select jsonb_build_object('token_exp',floor(extract(epoch from clock_timestamp()+interval '1 hour'))::bigint,
 'password_at',(select floor(extract(epoch from updated_at))::bigint from auth.mfa_amr_claims where session_id='${sessions[0]}' and authentication_method='password')) proof;`,
  );
  setupComplete = true;
  assert(Number.isSafeInteger(proof?.token_exp) && Number.isSafeInteger(proof?.password_at), 'Invalid server timestamps.');
  // Set one identical server-accredited proof time across fixtures, independent
  // of client clocks. No actual token/login is simulated by this SQL race suite.
  await query(
    'align-amr',
    `update auth.mfa_amr_claims set updated_at=to_timestamp(${proof.password_at}) where session_id in (${ids(sessions)}); select jsonb_build_object('aligned',true) proof;`,
  );
  await query('reset-baseline', `select ${call(3, 'put', { body: putBody(envelopes[3]) })} proof;`);
  const scenarios = [
    {
      name: 'logout-first',
      index: 0,
      holder: `delete from auth.sessions where id='${sessions[0]}';`,
      action: call(0, 'put', { body: putBody(envelopes[0]) }),
      code: 'PT401',
    },
    {
      name: 'writer-first',
      index: 1,
      holder: `select ${call(1, 'put', { body: putBody(envelopes[1]) })};`,
      action: `delete from auth.sessions where id='${sessions[1]}'`,
      code: 'OK',
      statement: true,
    },
    {
      name: 'disable-first',
      index: 2,
      holder: `update tr8_private.app_users set enabled=false where user_id='${owners[2]}';`,
      action: call(2, 'put', { body: putBody(envelopes[2]) }),
      code: 'PT403',
    },
    {
      name: 'reset-first',
      index: 3,
      holder: `select ${call(3, 'reset', { vault: envelopes[3].vaultId, operation: b64(16, 190) })};`,
      action: call(3, 'put', { body: putBody(next(envelopes[3]), '1') }),
      code: 'PT403',
    },
    {
      name: 'token-expiry-after-wait',
      index: 4,
      holder: `select 1 from auth.sessions where id='${sessions[4]}' for update;`,
      code: 'PT401',
      expiringToken: true,
    },
    {
      name: 'login-expiry-after-wait',
      index: 5,
      holder: `select 1 from tr8_private.app_users where user_id='${owners[5]}' for update;`,
      code: 'PT428',
      expiringLogin: true,
    },
    {
      name: 'session-expiry-after-wait',
      index: 6,
      holder: `select 1 from tr8_private.app_users where user_id='${owners[6]}' for update;`,
      code: 'PT401',
      expiringSession: true,
    },
  ];
  for (const scenario of scenarios) {
    const index = scenario.index;
    const tagA = `tr8-finance-race-${index}-a`;
    const tagB = `tr8-finance-race-${index}-b`;
    const first = query(
      `${scenario.name}-holder`,
      `begin;set local statement_timeout='45s';set local application_name='${tagA}';${scenario.holder}
do $$declare deadline timestamptz:=clock_timestamp()+interval '40 seconds';begin
 loop
  exit when (select released from tr8_finance.concurrency_gate where id=${index});
  if clock_timestamp()>deadline then raise exception 'Synthetic gate release timed out';end if;
  perform pg_sleep(0.1);
 end loop;
end;$$;
commit;select jsonb_build_object('committed',true) proof;`,
    );
    void first.catch(() => {});
    await observe(
      `${scenario.name}-holding`,
      `select jsonb_build_object('holding',exists(select 1 from pg_stat_activity where application_name='${tagA}' and wait_event='PgSleep')) proof;`,
      value => value?.holding,
    );
    if (scenario.expiringToken) {
      const clock = await query(
        'token-deadline',
        `select jsonb_build_object('expires',floor(extract(epoch from clock_timestamp()+interval '6 seconds'))::bigint) proof;`,
      );
      scenario.action = call(index, 'put', { body: putBody(envelopes[index]), expires: clock.expires });
      scenario.deadline = clock.expires;
    }
    if (scenario.expiringLogin) {
      const clock = await query(
        'login-deadline',
        `update auth.mfa_amr_claims set updated_at=date_trunc('second',clock_timestamp()-interval '294 seconds') where session_id='${sessions[index]}' and authentication_method='password'; select jsonb_build_object('password_at',(select floor(extract(epoch from updated_at))::bigint from auth.mfa_amr_claims where session_id='${sessions[index]}' and authentication_method='password')) proof;`,
      );
      scenario.action = call(index, 'put', { body: putBody(envelopes[index]), password: clock.password_at });
      scenario.deadline = clock.password_at + 300;
    }
    if (scenario.expiringSession) {
      const clock = await query(
        'session-deadline',
        `update auth.sessions set not_after=clock_timestamp()+interval '6 seconds' where id='${sessions[index]}'; select jsonb_build_object('expires',(select extract(epoch from not_after) from auth.sessions where id='${sessions[index]}')) proof;`,
      );
      scenario.action = call(index, 'put', { body: putBody(envelopes[index]) });
      scenario.deadline = clock.expires;
    }
    const second = query(
      `${scenario.name}-contender`,
      `begin;set local statement_timeout='45s';set local application_name='${tagB}';
do $$begin perform set_config('tr8.finance_race_started',extract(epoch from clock_timestamp())::text,false); begin ${scenario.statement ? scenario.action + ';' : 'perform ' + scenario.action + ';'} perform set_config('tr8.finance_race_result','OK',false);
exception when others then perform set_config('tr8.finance_race_result',sqlstate,false);end;end;$$;
commit;select jsonb_build_object('code',current_setting('tr8.finance_race_result'),'started',(current_setting('tr8.finance_race_started'))::numeric,'finished',extract(epoch from clock_timestamp())) proof;`,
    );
    void second.catch(() => {});
    const blocked = await observe(
      `${scenario.name}-blocking`,
      `select jsonb_build_object('blocked',exists(select 1 from pg_stat_activity a join pg_stat_activity b on a.pid=any(pg_blocking_pids(b.pid)) where a.application_name='${tagA}' and b.application_name='${tagB}' and b.wait_event_type='Lock')) proof;`,
      value => value?.blocked,
    );
    if (scenario.deadline) {
      await query(
        `${scenario.name}-cross-expiry`,
        `select pg_sleep(greatest(0,${scenario.deadline}-extract(epoch from clock_timestamp())+0.1)); select jsonb_build_object('crossed',extract(epoch from clock_timestamp())>=${scenario.deadline}) proof;`,
      );
    }
    await query(
      `${scenario.name}-release`,
      `update tr8_finance.concurrency_gate set released=true where id=${index};select jsonb_build_object('released',true) proof;`,
    );
    const [holder, contender] = await Promise.all([first, second]);
    assert(holder?.committed && blocked?.blocked && contender?.code === scenario.code, `${scenario.name}: unexpected SQL outcome`);
    if (scenario.deadline)
      assert(
        contender.started < scenario.deadline && contender.finished >= scenario.deadline,
        `${scenario.name}: did not cross the expiry boundary during the database wait`,
      );
    const state = await query(
      `${scenario.name}-state`,
      `select jsonb_build_object('vaults',(select count(*) from tr8_finance.vaults where owner_id='${owners[index]}'),
 'receipts',(select count(*) from tr8_finance.receipts where owner_id='${owners[index]}'),
 'retired',(select count(*) from tr8_finance.retired where owner_id='${owners[index]}')) proof;`,
    );
    assert(state?.vaults === (scenario.name === 'writer-first' ? 1 : 0), `${scenario.name}: wrong committed vault count`);
    assert(state?.receipts === (['writer-first', 'reset-first'].includes(scenario.name) ? 1 : 0), `${scenario.name}: wrong committed receipt count`);
    assert(state?.retired === (scenario.name === 'reset-first' ? 1 : 0), `${scenario.name}: wrong retirement count`);
    if (scenario.name === 'reset-first') {
      const old = await query(
        'old-receipt-after-reset',
        `do $$begin begin perform ${call(index, 'put', { body: putBody(envelopes[index]), epoch: 2 })};perform set_config('tr8.finance_race_old','OK',false);exception when others then perform set_config('tr8.finance_race_old',sqlstate,false);end;end;$$;select jsonb_build_object('code',current_setting('tr8.finance_race_old')) proof;`,
      );
      assert(old?.code === 'PT403', 'Old receipt revived a retired context.');
    }
    rows.push({
      name: scenario.name,
      holder_committed: true,
      postgres_blocking_observed: true,
      contender_code: contender.code,
      ...(scenario.deadline ? { started: contender.started, expired_at: scenario.deadline, finished: contender.finished } : {}),
      ...state,
    });
    console.log(JSON.stringify({ case: scenario.name, passed: true }));
  }
} catch (cause) {
  failure = cause instanceof Error ? cause.message : 'Unknown concurrency failure';
} finally {
  await Promise.allSettled(pending);
  if (setupComplete) {
    try {
      cleanup = await query('cleanup', cleanupSql);
    } catch {
      failure ??= 'Guarded fixture cleanup failed; inspect private cleanup.sql.';
    }
  }
}
const after = await query('after', fingerprint);
const preserved =
  before.projects === after?.projects && before.tasks === after?.tasks && JSON.stringify(before.app_config) === JSON.stringify(after?.app_config);
if (!preserved) failure ??= 'Existing project/task/config fingerprints changed.';
if (setupComplete && (cleanup?.remaining_actors !== 0 || cleanup?.remaining_allowlist !== 0 || cleanup?.remaining_vaults !== 0))
  failure ??= 'Synthetic fixture cleanup was incomplete.';
const report = {
  project: TEST,
  scope: 'SQL-only synthetic actors; independent real-Auth HTTP evidence is required',
  cases: rows,
  preserved,
  cleanup,
  before,
  after,
  ...(failure ? { failure } : {}),
};
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
if (failure) throw new Error(failure);
console.log(JSON.stringify({ passed: true, cases: rows.length, preserved, cleanup }));
