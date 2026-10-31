// Native PostgreSQL rehearsal. Synthetic data only; no hosted project or app keys.
// Usage: node scripts/mcp/finance-concurrency-test.mjs <absolute isolated tools root>
// Tools root: node_modules/@embedded-postgres/windows-x64 18.6.0-beta.19 and pg 8.23.1.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FINANCE_SQL_BOOTSTRAP } from './finance-sql-bootstrap.mjs';

const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(value).digest('hex');
const migrationUrl = new URL('../../supabase/migrations/20261031210015_mcp_finance_delegated_draft.sql', import.meta.url);
const closed = async port =>
  new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });

/** Returns a disposable, loopback-only native DB, reusable by other local tests. */
export async function createNativeFinanceTestDatabase(toolsRoot) {
  if (!toolsRoot || !path.isAbsolute(toolsRoot)) throw Error('Pass an absolute isolated tools root. This script never downloads tools.');
  if (process.platform !== 'win32') throw Error('This pinned local harness currently supports Windows x64 only.');
  const packageRoot = path.join(toolsRoot, 'node_modules/@embedded-postgres/windows-x64');
  const binaryPackage = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const pgRoot = path.join(toolsRoot, 'node_modules/pg');
  const pgPackage = JSON.parse(await fs.readFile(path.join(pgRoot, 'package.json'), 'utf8'));
  if (binaryPackage.version !== '18.6.0-beta.19' || pgPackage.version !== '8.23.1') throw Error('Unexpected native test tool version.');
  const { initdb, pg_ctl: pgCtl } = await import(pathToFileURL(path.join(packageRoot, 'dist/index.js')).href);
  const pgModule = await import(pathToFileURL(path.join(pgRoot, 'lib/index.js')).href);
  const { Client } = pgModule.default;
  const base = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(base, 'tr8-finance-pg-'));
  const marker = randomUUID();
  const markerPath = path.join(directory, '.tr8-synthetic-owner');
  await fs.writeFile(markerPath, marker, { flag: 'wx' });
  const dataDirectory = path.join(directory, 'data');
  const passwordFile = path.join(directory, '.init-password');
  const password = randomBytes(32).toString('base64url');
  await fs.writeFile(passwordFile, password, { flag: 'wx', mode: 0o600 });
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const connections = new Set();
  let cleanupPromise;
  async function connect(name = 'tr8-synthetic-client') {
    const client = new Client({
      host: '127.0.0.1',
      port,
      user: 'tr8_synthetic',
      password,
      database: 'postgres',
      application_name: name,
      connectionTimeoutMillis: 5000,
    });
    client.on('error', () => {}); // Shutdown/rollback diagnostics never log connection configuration.
    await client.connect();
    connections.add(client);
    await client.query("set statement_timeout='12s'; set lock_timeout='10s'; set idle_in_transaction_session_timeout='25s'");
    return client;
  }
  function close() {
    cleanupPromise ??= (async () => {
      await Promise.allSettled(
        [...connections].map(async client => {
          await client.query('rollback').catch(() => {});
          await client.end();
        }),
      );
      connections.clear();
      const pidFile = await fs.stat(path.join(dataDirectory, 'postmaster.pid')).then(
        () => true,
        () => false,
      );
      if (pidFile) await execute(pgCtl, ['stop', '-D', dataDirectory, '-m', 'fast', '-w', '-t', '15'], { windowsHide: true, timeout: 20000 });
      const portClosed = await closed(port);
      if (!portClosed) throw Error('Temporary PostgreSQL port is still open.');
      const resolved = await fs.realpath(directory);
      if (
        path.dirname(resolved).toLowerCase() !== base.toLowerCase() ||
        !path.basename(resolved).startsWith('tr8-finance-pg-') ||
        (await fs.readFile(markerPath, 'utf8')) !== marker
      )
        throw Error('Temporary directory ownership/path check failed.');
      // Automatic review blocked recursive removal of a previous synthetic
      // cluster. Do not bypass that decision: stop the server and retain only
      // inactive fictional artifacts, never an active access or a password file.
      return { portClosed, directoryRemoved: false, directoryRetained: resolved };
    })();
    return cleanupPromise;
  }
  try {
    await execute(
      initdb,
      [
        '-D',
        dataDirectory,
        '-U',
        'tr8_synthetic',
        '--pwfile',
        passwordFile,
        '--auth-local=scram-sha-256',
        '--auth-host=scram-sha-256',
        '--encoding=UTF8',
        '--locale=C',
      ],
      { windowsHide: true, timeout: 30000 },
    );
    await fs.rm(passwordFile);
    const options = `-h 127.0.0.1 -p ${port} -c max_connections=100 -c logging_collector=off -c log_statement=none -c log_min_error_statement=panic -c fsync=off -c synchronous_commit=off`;
    await execute(pgCtl, ['start', '-D', dataDirectory, '-l', path.join(directory, 'postgres.log'), '-o', options, '-w', '-t', '15'], {
      windowsHide: true,
      timeout: 20000,
    });
    const admin = await connect('tr8-synthetic-admin');
    await admin.query(FINANCE_SQL_BOOTSTRAP);
    await admin.query(await fs.readFile(migrationUrl, 'utf8'));
    // Minimal dependencies only; the account_finance implementation itself is
    // the exact immutable migration used by the interactive application.
    await admin.query(`create schema tr8_finance;
      create function tr8_finance.closed(v jsonb,fields text[])returns boolean language sql immutable as $$select jsonb_typeof(v)='object' and v?&fields and (select count(*) from jsonb_object_keys(v))=cardinality(fields);$$;
      create function tr8_private.v5_require_session(actor uuid,sid uuid)returns void language plpgsql security definer set search_path='' as $$begin
        if not tr8_private.v2_user_live(actor) or not exists(select 1 from tr8_private.app_users where user_id=actor and enabled) then raise exception using errcode='42501';end if;
        perform 1 from auth.sessions where id=sid and user_id=actor and (not_after is null or not_after>clock_timestamp())for share;
        if not found then raise exception using errcode='42501';end if;
      end;$$;`);
    await admin.query(
      await fs.readFile(new URL('../../supabase/migrations/20261030150023_account_finance_cross_currency_payments.sql', import.meta.url), 'utf8'),
    );
    await admin.query(`create function public.tr8_account_finance(p_snapshot jsonb default null,p_expected_version text default null,p_operation_id uuid default null)returns jsonb language sql volatile security invoker set search_path='' as $$select tr8_private.account_finance(p_snapshot,p_expected_version,p_operation_id);$$;
      revoke all on function tr8_private.account_finance(jsonb,text,uuid),public.tr8_account_finance(jsonb,text,uuid)from public,anon,authenticated;
      grant execute on function tr8_private.account_finance(jsonb,text,uuid),public.tr8_account_finance(jsonb,text,uuid)to authenticated;`);
    const version = (await admin.query('show server_version')).rows[0].server_version;
    return { admin, connect, close, version, port };
  } catch (error) {
    await close().catch(() => {});
    throw Error(`Native PostgreSQL setup failed: ${error.code ?? ''} ${error.message}`);
  }
}

async function run(toolsRoot) {
  const cluster = await createNativeFinanceTestDatabase(toolsRoot);
  const { admin, connect } = cluster;
  let checks = 0,
    barrierChecks = 0;
  const cases = [];
  const ok = (value, label) => {
    assert.ok(value, label);
    checks++;
  };
  const equal = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    checks++;
  };
  async function waitFor(predicate, label, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(15);
    }
    throw Error(`Native concurrency barrier failed: ${label}`);
  }
  async function blocked(waiter, blocker, label) {
    await waitFor(
      async () =>
        (await admin.query('select $2::integer=any(pg_blocking_pids($1::integer)) as blocked', [waiter.processID, blocker.processID])).rows[0].blocked,
      label,
    );
    const row = (await admin.query('select wait_event_type,state from pg_stat_activity where pid=$1', [waiter.processID])).rows[0];
    ok(row.wait_event_type === 'Lock' && row.state === 'active', label);
    barrierChecks++;
  }
  const rpc = async (client, fixture, input, key = 0, commit = true) => {
    try {
      await client.query('begin');
      await client.query('set local role anon');
      const data = (
        await client.query("select public.tr8_mcp_finance_dispatch($1,'finance_submit_notice',$2::jsonb) as result", [
          fixture.tokens[key],
          JSON.stringify(input),
        ])
      ).rows[0].result;
      if (commit) await client.query('commit');
      return data;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      return { _tr8_mcp_error: { code: error.code } };
    }
  };
  const auth = async (client, fixture) => {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: fixture.owner, session_id: fixture.owner, role: 'authenticated' }),
    ]);
    await client.query('set local role authenticated');
  };
  const ownerLock = async (client, fixture) => {
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(hashtextextended('tr8-account-finance:'||$1,0))", [fixture.owner]);
  };
  const state = async fixture =>
    (await admin.query('select version::text,snapshot from tr8_private.account_finances where owner_id=$1', [fixture.owner])).rows[0];
  const rows = async fixture =>
    (
      await admin.query(
        'select (select count(*)::int from tr8_private.mcp_finance_notices where owner_id=$1)notices,(select count(*)::int from tr8_private.mcp_finance_messages where owner_id=$1)messages,(select count(*)::int from tr8_private.mcp_finance_requests where owner_id=$1)requests',
        [fixture.owner],
      )
    ).rows[0];
  let serial = 0;
  async function seed() {
    const n = ++serial;
    const owner = `e3000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const workspace = `e3000010-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const credentials = [0, 1].map(k => `e3000030-0000-4000-8000-${String(n * 2 + k).padStart(12, '0')}`);
    const tokens = credentials.map(id => `tr8_mcp_${digest(id)}`);
    const account = `cash-${n}`;
    const snapshot = {
      schemaVersion: 1,
      financialSpace: {
        domainSchemaVersion: 5,
        currencyCatalogVersion: 'currency-catalog-v1',
        currencyDefinitions: ['DOP', 'USD', 'EUR', 'BOB'].map(code => ({ code, minorUnitDigits: 2 })),
        accounts: [{ id: account, type: 'debit', currency: 'DOP', name: 'Cuenta ficticia', openingDate: '2026-01-01', openingBalanceMinor: 1000000 }],
        operations: [
          {
            id: `manual-${n}`,
            accountId: account,
            kind: 'income',
            amountMinor: 500,
            currency: 'DOP',
            date: '2026-01-03',
            description: 'Registro manual que debe conservarse',
            category: 'other',
            note: 'Nota privada sintética',
          },
        ],
        plans: [],
      },
    };
    await admin.query("insert into auth.users(id,email,email_confirmed_at)values($1,'native-test@example.test',clock_timestamp());", [owner]);
    await admin.query('insert into auth.sessions(id,user_id)values($1,$1)', [owner]);
    await admin.query('insert into tr8_private.app_users(user_id)values($1)', [owner]);
    await admin.query("insert into tr8_private.workspaces(id,owner_id,kind,name)values($1,$2,'personal','Prueba nativa')", [workspace, owner]);
    await admin.query('insert into tr8_private.workspace_members(workspace_id,user_id)values($1,$2)', [workspace, owner]);
    await admin.query('insert into tr8_private.account_finances(owner_id,version,snapshot,operation_id)values($1,1,$2::jsonb,gen_random_uuid())', [
      owner,
      JSON.stringify(snapshot),
    ]);
    const fixture = { owner, workspace, credentials, tokens, account, snapshot };
    for (let k = 0; k < 2; k++) {
      await admin.query(
        "insert into tr8_private.mcp_credentials(id,owner_id,workspace_id,name,access,token_hash,expires_at)values($1,$2,$3,'Ficticia','read',$4,clock_timestamp()+interval '1 hour')",
        [credentials[k], owner, workspace, digest(tokens[k])],
      );
      const manager = await connect('tr8-grant-setup');
      await auth(manager, fixture);
      await manager.query("select public.tr8_mcp_finance_manage('set_grant',$1::jsonb)", [
        JSON.stringify({
          credential_id: credentials[k],
          access: 'write',
          accounts: [{ account_id: account, start_at: '2026-01-02T00:00:00Z' }],
          mailbox_ids: ['a'.repeat(64)],
          expense_categories: ['other'],
          income_categories: ['other', 'salary'],
        }),
      ]);
      await manager.query('commit');
      await manager.end();
    }
    return fixture;
  }
  const input = (fixture, n, patch = {}) => ({
    request_id: `e4000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    expected_version: '1',
    source: { provider: 'gmail', mailbox_id: 'a'.repeat(64), message_id: `native_message_${n}`, bank_transaction_id: digest(`native bank ${n}`) },
    account_id: fixture.account,
    kind: 'purchase',
    status: 'posted',
    amount: `${100 + n}.20`,
    currency: 'DOP',
    occurred_at: '2026-06-03T14:00:00-04:00',
    time_zone: 'America/Santo_Domingo',
    date: '2026-06-03',
    description: 'Compra ficticia',
    category: 'other',
    ...patch,
  });
  async function noChange(fixture, expected, label) {
    equal(await state(fixture), expected, label);
    equal(await rows(fixture), { notices: 0, messages: 0, requests: 0 }, `${label}: no receipts`);
  }
  async function caseDone(name) {
    cases.push(name);
    process.stdout.write(JSON.stringify({ case: name, status: 'passed' }) + '\n');
  }
  let cleanup;
  try {
    const beforeSuite = await admin.query(await fs.readFile(new URL('../../supabase/tests/mcp_finance.sql', import.meta.url), 'utf8'));
    const suiteReport = beforeSuite.flatMap(r => r.rows ?? []).find(r => Object.hasOwn(r, 'checks'));
    ok(suiteReport?.checks >= 124, 'existing direct SQL regression suite');
    const foreign = await seed(),
      foreignBefore = await state(foreign);

    {
      // Eight sessions, one request, held at a visible database lock barrier.
      const f = await seed(),
        holder = await connect(),
        clients = await Promise.all(Array.from({ length: 8 }, () => connect()));
      await ownerLock(holder, f);
      const pending = clients.map(c => rpc(c, f, input(f, 1)));
      const pids = clients.map(c => c.processID);
      let firstPid;
      await waitFor(async () => {
        firstPid = (
          await admin.query('select pid from pg_stat_activity where pid=any($1::integer[]) and $2::integer=any(pg_blocking_pids(pid))limit 1', [
            pids,
            holder.processID,
          ])
        ).rows[0]?.pid;
        return firstPid !== undefined;
      }, 'one same-key session reaches owner boundary');
      await blocked(
        clients.find(c => c.processID === firstPid),
        holder,
        'observed replay winner waits at owner lock',
      );
      await waitFor(
        async () =>
          (await admin.query('select count(*)::int n from pg_stat_activity where pid=any($1::integer[]) and cardinality(pg_blocking_pids(pid))>0', [pids]))
            .rows[0].n === clients.length,
        'all same-key replay sessions visibly wait',
      );
      ok(true, 'eight independent waiting replay backends observed');
      await holder.query('commit');
      const result = await Promise.all(pending);
      ok(
        result.every(r => r.status === 'recorded' && r.operation_id === result[0].operation_id),
        'eight simultaneous requests share one operation',
      );
      equal(await rows(f), { notices: 1, messages: 1, requests: 1 }, 'same request durable cardinalities');
      equal((await state(f)).version, '2', 'one ledger increment');
      equal((await state(f)).snapshot.financialSpace.operations.length, 2, 'manual record plus one purchase');
      await caseDone('same-request-eight-sessions');
    }
    {
      const f = await seed(),
        holder = await connect(),
        a = await connect(),
        b = await connect();
      await ownerLock(holder, f);
      const first = input(f, 2),
        second = input(f, 3, { amount: first.amount, source: { ...first.source, message_id: 'second_notification' } });
      const pa = rpc(a, f, first, 0),
        pb = rpc(b, f, second, 1);
      await blocked(a, holder, 'first credential reaches owner lock');
      await blocked(b, holder, 'different credential also reaches owner lock');
      await holder.query('commit');
      const [ra, rb] = await Promise.all([pa, pb]);
      ok(ra.status === 'recorded' && rb.status === 'recorded' && ra.operation_id === rb.operation_id, 'same bank transaction across credentials is linked');
      equal(await rows(f), { notices: 1, messages: 2, requests: 2 }, 'two email aliases, one bank notice');
      await caseDone('same-bank-different-credentials');
    }
    {
      const f = await seed(),
        holder = await connect(),
        a = await connect(),
        b = await connect();
      await ownerLock(holder, f);
      const inputs = [input(f, 4), input(f, 5)];
      const pa = rpc(a, f, inputs[0], 0),
        pb = rpc(b, f, inputs[1], 1);
      await blocked(a, holder, 'distinct transaction A reaches barrier');
      await blocked(b, holder, 'distinct transaction B reaches barrier');
      await holder.query('commit');
      const results = await Promise.all([pa, pb]);
      equal(results.filter(r => r.status === 'recorded').length, 1, 'one version wins');
      equal(results.filter(r => r._tr8_mcp_error?.code === 'PT409').length, 1, 'stale distinct transaction conflicts');
      const losing = results.findIndex(r => r._tr8_mcp_error);
      const retry = await rpc(losing ? b : a, f, { ...inputs[losing], expected_version: '2' }, losing);
      equal(retry.status, 'recorded', 'distinct legitimate transaction records after explicit version refresh');
      const lostResponse = await rpc(a, f, inputs[1 - losing], 1 - losing);
      equal(lostResponse, results[1 - losing], 'lost response replay survives intervening write');
      equal((await state(f)).version, '3', 'both legitimate transactions retained');
      equal((await state(f)).snapshot.financialSpace.operations.length, 3, 'manual record retained with both purchases');
      await caseDone('different-transactions-version-conflict-retry');
    }
    {
      const f = await seed(),
        gui = await connect(),
        mcp = await connect();
      const guiSnapshot = structuredClone(f.snapshot);
      guiSnapshot.financialSpace.operations.push({
        id: 'gui-purchase',
        accountId: f.account,
        kind: 'expense',
        currency: 'DOP',
        amountMinor: 750,
        date: '2026-05-01',
        description: 'Registro manual concurrente',
        category: 'other',
        note: '',
      });
      await auth(gui, f);
      await gui.query('select public.tr8_account_finance($1::jsonb,$2,$3::uuid)', [JSON.stringify(guiSnapshot), '1', randomUUID()]);
      const pending = rpc(mcp, f, input(f, 6));
      await blocked(mcp, gui, 'MCP waits for interactive save');
      await gui.query('commit');
      equal((await pending)._tr8_mcp_error?.code, 'PT409', 'MCP cannot overwrite GUI winner');
      equal((await state(f)).snapshot, guiSnapshot, 'GUI snapshot preserved after stale MCP write');
      equal((await rpc(mcp, f, input(f, 6, { expected_version: '2' }))).status, 'recorded', 'MCP can append after refreshing');
      ok(
        (await state(f)).snapshot.financialSpace.operations.some(o => o.id === 'gui-purchase'),
        'GUI movement preserved after append',
      );
      await caseDone('interactive-save-wins');
    }
    {
      const f = await seed(),
        writer = await connect(),
        gui = await connect();
      const recorded = await rpc(writer, f, input(f, 7), 0, false);
      equal(recorded.status, 'recorded', 'MCP holds uncommitted successful write');
      await auth(gui, f);
      const pending = gui.query('select public.tr8_account_finance($1::jsonb,$2,$3::uuid)', [JSON.stringify(f.snapshot), '1', randomUUID()]).then(
        () => null,
        error => error.code,
      );
      await blocked(gui, writer, 'GUI waits for financial MCP writer');
      await writer.query('commit');
      equal(await pending, 'PT409', 'GUI stale save conflicts');
      await gui.query('rollback');
      equal((await state(f)).snapshot.financialSpace.operations.length, 2, 'MCP movement cannot be overwritten by stale GUI');
      await caseDone('financial-mcp-save-wins');
    }
    {
      const f = await seed(),
        revoker = await connect(),
        caller = await connect(),
        before = await state(f);
      await revoker.query('begin');
      await revoker.query('update tr8_private.mcp_credentials set revoked_at=clock_timestamp()where id=$1', [f.credentials[0]]);
      const pending = rpc(caller, f, input(f, 8));
      await blocked(caller, revoker, 'MCP waits for bearer revocation');
      await revoker.query('commit');
      equal((await pending)._tr8_mcp_error?.code, 'PT401', 'revocation winner denies late write');
      await noChange(f, before, 'revocation leaves ledger unchanged');
      await caseDone('bearer-revocation-wins');
    }
    {
      const f = await seed(),
        holder = await connect(),
        writer = await connect(),
        revoker = await connect();
      await ownerLock(holder, f);
      const write = rpc(writer, f, input(f, 9), 0, false);
      await blocked(writer, holder, 'writer owns credential while awaiting owner lock');
      await revoker.query('begin');
      const revoke = revoker.query('update tr8_private.mcp_credentials set revoked_at=clock_timestamp()where id=$1', [f.credentials[0]]);
      await blocked(revoker, writer, 'revocation waits for earlier writer credential');
      await holder.query('commit');
      equal((await write).status, 'recorded', 'authorized earlier writer records');
      await blocked(revoker, writer, 'revocation still waits until actual writer commit');
      await writer.query('commit');
      await revoke;
      await revoker.query('commit');
      equal((await rpc(writer, f, input(f, 10, { expected_version: '2' })))._tr8_mcp_error?.code, 'PT401', 'subsequent call denied after revocation');
      equal((await state(f)).snapshot.financialSpace.operations.length, 2, 'earlier authorized write preserved');
      await caseDone('writer-before-bearer-revocation');
    }
    {
      const f = await seed(),
        manager = await connect(),
        caller = await connect(),
        before = await state(f);
      await auth(manager, f);
      await manager.query("select public.tr8_mcp_finance_manage('revoke_grant',$1::jsonb)", [JSON.stringify({ credential_id: f.credentials[0] })]);
      const pending = rpc(caller, f, input(f, 11));
      await blocked(caller, manager, 'caller waits for financial grant revocation');
      await manager.query('commit');
      equal((await pending)._tr8_mcp_error?.code, 'PT403', 'removed financial grant denies waiting call');
      await noChange(f, before, 'grant removal leaves ledger unchanged');
      await caseDone('financial-grant-revocation-wins');
    }
    {
      const f = await seed(),
        remover = await connect(),
        caller = await connect(),
        before = await state(f);
      await remover.query('begin');
      await remover.query('select tr8_private.v2_lock_workspace($1,true)', [f.workspace]);
      await remover.query("update tr8_private.workspace_members set status='inactive'where workspace_id=$1", [f.workspace]);
      const pending = rpc(caller, f, input(f, 12));
      await blocked(caller, remover, 'caller waits at true workspace authorization lock');
      await remover.query('commit');
      equal((await pending)._tr8_mcp_error?.code, 'PT403', 'membership removal denies waiting call');
      await noChange(f, before, 'membership removal leaves ledger unchanged');
      await caseDone('workspace-membership-removal-wins');
    }
    {
      const f = await seed(),
        disabler = await connect(),
        caller = await connect(),
        before = await state(f);
      await disabler.query('begin');
      await disabler.query('update tr8_private.app_users set enabled=false where user_id=$1', [f.owner]);
      const pending = rpc(caller, f, input(f, 13));
      await blocked(caller, disabler, 'caller waits for owner disable');
      await disabler.query('commit');
      equal((await pending)._tr8_mcp_error?.code, 'PT403', 'disabled owner denies waiting call');
      await noChange(f, before, 'disable leaves ledger unchanged');
      await caseDone('owner-disable-wins');
    }
    {
      const f = await seed(),
        holder = await connect(),
        caller = await connect(),
        before = await state(f);
      await ownerLock(holder, f);
      await admin.query("update tr8_private.mcp_credentials set expires_at=clock_timestamp()+interval '1 second'where id=$1", [f.credentials[0]]);
      const pending = rpc(caller, f, input(f, 14));
      await blocked(caller, holder, 'credential is valid before waiting at owner lock');
      await waitFor(
        async () =>
          (await admin.query('select clock_timestamp()>=expires_at as expired from tr8_private.mcp_credentials where id=$1', [f.credentials[0]])).rows[0]
            .expired,
        'database clock crosses actual credential expiration',
      );
      await holder.query('commit');
      equal((await pending)._tr8_mcp_error?.code, 'PT401', 'expiry during wait denies late write');
      await noChange(f, before, 'expired waiting write leaves ledger unchanged');
      await caseDone('credential-expires-during-wait');
    }
    {
      const f = await seed(),
        caller = await connect(),
        before = await state(f);
      await admin.query(`create function tr8_private.test_fail_receipt()returns trigger language plpgsql as $$begin if new.owner_id='${f.owner}'::uuid then raise exception using errcode='P0001',message='Synthetic receipt failure';end if;return new;end;$$;
        create trigger test_fail_receipt before insert on tr8_private.mcp_finance_notices for each row execute function tr8_private.test_fail_receipt();`);
      equal((await rpc(caller, f, input(f, 15)))._tr8_mcp_error?.code, 'P0001', 'synthetic receipt failure surfaced safely');
      await noChange(f, before, 'failed receipt atomically rolls back ledger');
      await admin.query('drop trigger test_fail_receipt on tr8_private.mcp_finance_notices;drop function tr8_private.test_fail_receipt()');
      equal((await rpc(caller, f, input(f, 15))).status, 'recorded', 'same request retries after a rolled-back receipt failure');
      equal((await state(f)).snapshot.financialSpace.operations.length, 2, 'retry adds exactly one purchase');
      await caseDone('ledger-and-receipt-atomic-rollback');
    }
    {
      const f = await seed(),
        holder = await connect(),
        a = await connect(),
        b = await connect();
      await ownerLock(holder, f);
      const first = input(f, 16),
        second = input(f, 17, { kind: 'income', amount: first.amount, source: { ...first.source, message_id: 'conflicting_bank_email' } });
      const pa = rpc(a, f, first),
        pb = rpc(b, f, second, 1);
      await blocked(a, holder, 'bank identity A waits at owner boundary');
      await blocked(b, holder, 'bank identity B waits at owner boundary');
      await holder.query('commit');
      const result = await Promise.all([pa, pb]);
      equal(result.filter(r => r.status === 'recorded').length, 1, 'one conflicting bank identity records');
      const losing = result.findIndex(r => r._tr8_mcp_error?.code === 'PT409');
      ok(losing >= 0, 'competing conflicting classification first receives a stale-version conflict');
      const heldReview = await rpc(losing ? b : a, f, { ...(losing ? second : first), expected_version: '2' }, losing);
      ok(
        heldReview.status === 'review' && heldReview.review_reason === 'bank_reference_conflict',
        'conflicting classification requires review after refreshing version',
      );
      equal((await state(f)).snapshot.financialSpace.operations.length, 2, 'conflicting bank identity never double posts');
      await caseDone('same-bank-conflicting-classification');
    }
    equal(await state(foreign), foreignBefore, 'unrelated owner exact snapshot/version preserved across all races');
    const activeBackends = (await admin.query("select count(*)::int as n from pg_stat_activity where application_name like 'tr8-%'")).rows[0].n;
    ok(activeBackends > 2, 'multiple independent native PostgreSQL backends participated');
    return {
      checks,
      sqlChecks: Number(suiteReport.checks),
      observedLockBarriers: barrierChecks,
      cases,
      postgresVersion: cluster.version,
      native: true,
      concurrentPgSessions: true,
      hosted: false,
      authDependencies: 'minimal synthetic fixture; exact account_finance implementation and actual workspace lock semantics',
      cleanup: await cluster.close(),
    };
  } finally {
    cleanup = await cluster.close();
    assert.ok(cleanup.portClosed);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(await run(process.argv[2])) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message, code: error.code }) + '\n');
    process.exitCode = 1;
  }
}
