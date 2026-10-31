// Real multi-session PostgreSQL, local synthetic OAuth only. No hosted requests.
// Usage: node scripts/mcp/oauth-concurrency-test.mjs <absolute isolated native tools root>
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createNativeFinanceTestDatabase } from './finance-concurrency-test.mjs';

const digest = input => createHash('sha256').update(input).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const OAUTH_TEST_RESOURCE = 'https://tr8.vercel.app/api/mcp/finance';
export const OAUTH_TEST_CLIENT = 'native-synthetic-client';
export const OAUTH_TEST_CALLBACK = 'https://native-client.example/callback';
let serial = 0;

export async function seedOAuthFixture(cluster) {
  const { admin, connect } = cluster;
  const n = ++serial;
  const owner = `e5000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const workspace = `e5000010-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const credentials = [0, 1].map(k => `e5000030-0000-4000-8000-${String(2 * n + k).padStart(12, '0')}`);
  const pats = credentials.map(c => `tr8_mcp_${digest(c)}`);
  const account = `native-oauth-cash-${n}`;
  const snapshot = {
    schemaVersion: 1,
    financialSpace: {
      domainSchemaVersion: 5,
      currencyCatalogVersion: 'currency-catalog-v1',
      currencyDefinitions: ['DOP', 'USD', 'EUR', 'BOB'].map(code => ({ code, minorUnitDigits: 2 })),
      accounts: [{ id: account, name: 'Ahorros OAuth ficticios', type: 'debit', currency: 'DOP', openingBalanceMinor: 1000000, openingDate: '2026-01-01' }],
      operations: [],
      plans: [],
    },
  };
  await admin.query('update tr8_private.mcp_oauth_config set enabled=true');
  await admin.query(
    "insert into tr8_private.mcp_oauth_clients(client_id,client_name,redirect_uris,enabled)values($1,'Cliente OAuth ficticio',$2,true)on conflict(client_id)do nothing",
    [OAUTH_TEST_CLIENT, [OAUTH_TEST_CALLBACK]],
  );
  await admin.query("insert into auth.users(id,email,email_confirmed_at)values($1,'native-oauth@example.test',clock_timestamp())", [owner]);
  await admin.query('insert into auth.sessions(id,user_id)values($1,$1)', [owner]);
  await admin.query('insert into tr8_private.app_users(user_id)values($1)', [owner]);
  await admin.query("insert into tr8_private.workspaces(id,owner_id,kind,name)values($1,$2,'personal','OAuth ficticio')", [workspace, owner]);
  await admin.query('insert into tr8_private.workspace_members(workspace_id,user_id)values($1,$2)', [workspace, owner]);
  await admin.query('insert into tr8_private.account_finances(owner_id,version,snapshot,operation_id)values($1,1,$2::jsonb,gen_random_uuid())', [
    owner,
    JSON.stringify(snapshot),
  ]);
  const fixture = {
    owner,
    workspace,
    credentials,
    pats,
    account,
    snapshot,
    clientId: OAUTH_TEST_CLIENT,
    redirectUri: OAUTH_TEST_CALLBACK,
    resource: OAUTH_TEST_RESOURCE,
  };
  for (let k = 0; k < 2; k++) {
    await admin.query(
      "insert into tr8_private.mcp_credentials(id,owner_id,workspace_id,name,access,token_hash,expires_at)values($1,$2,$3,'Padre ficticio','read',$4,clock_timestamp()+interval '40 days')",
      [credentials[k], owner, workspace, digest(pats[k])],
    );
    const browser = await connect('tr8-oauth-parent-setup');
    await browserActor(browser, fixture);
    await browser.query("select public.tr8_mcp_finance_manage('set_grant',$1::jsonb)", [JSON.stringify(parentDraft(fixture, k))]);
    await browser.query('commit');
    await browser.end();
  }
  return fixture;
}

export function parentDraft(f, index = 0, access = 'write') {
  return {
    credential_id: f.credentials[index],
    access,
    accounts: [{ account_id: f.account, start_at: '2026-01-02T00:00:00Z' }],
    mailbox_ids: ['a'.repeat(64)],
    expense_categories: ['other'],
    income_categories: ['other', 'salary'],
  };
}
export async function browserActor(client, f) {
  await client.query('begin');
  await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.owner, session_id: f.owner, role: 'authenticated' })]);
  await client.query('set local role authenticated');
}
export async function consentOAuthFixture(cluster, fixture, attempt, credentialIndex = 0) {
  const browser = await cluster.connect('tr8-oauth-synthetic-browser');
  try {
    await browserActor(browser, fixture);
    const details = (await browser.query("select public.tr8_mcp_oauth_consent('details',$1::jsonb)result", [JSON.stringify({ attempt })])).rows[0].result;
    const reviewed = details.connections.find(connection => connection.credential_id === fixture.credentials[credentialIndex]);
    assert.ok(reviewed?.grant_fingerprint, 'selected synthetic parent present in the actual consent review');
    const approval = (
      await browser.query("select public.tr8_mcp_oauth_consent('approve',$1::jsonb)result", [
        JSON.stringify({ attempt, credential_id: fixture.credentials[credentialIndex], grant_fingerprint: reviewed.grant_fingerprint }),
      ])
    ).rows[0].result;
    await browser.query('commit');
    return approval;
  } catch (error) {
    await browser.query('rollback').catch(() => {});
    throw error;
  } finally {
    await browser.end();
  }
}
async function anon(client, sql, parameters = [], commit = true) {
  try {
    await client.query('begin');
    await client.query('set local role anon');
    const result = (await client.query(sql, parameters)).rows[0].result;
    if (commit) await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return { _sql_error: { code: error.code } };
  }
}
const oauth = (c, action, input = {}, commit = true) =>
  anon(c, 'select public.tr8_mcp_oauth_server($1,$2::jsonb)result', [action, JSON.stringify(input)], commit);
const bridge = (c, token, action, input = {}, commit = true) =>
  anon(c, 'select public.tr8_mcp_oauth_finance_dispatch($1,$2,$3::jsonb)result', [token, action, JSON.stringify(input)], commit);

async function run(toolsRoot) {
  const cluster = await createNativeFinanceTestDatabase(toolsRoot),
    { admin, connect } = cluster;
  let checks = 0,
    barriers = 0;
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
    throw Error(`OAuth native lock barrier failed: ${label}`);
  }
  async function blocked(c, holder, label) {
    await waitFor(async () => {
      const row = (
        await admin.query('select cardinality(pg_blocking_pids($1))>0 blocked,$2::integer=any(pg_blocking_pids($1))direct from pg_stat_activity where pid=$1', [
          c.processID,
          holder?.processID ?? 0,
        ])
      ).rows[0];
      return row?.blocked && (!holder || row.direct);
    }, label);
    ok(true, label);
    barriers++;
  }
  const codeInput = (f, code, verifier) => ({ client_id: f.clientId, code, code_verifier: verifier, redirect_uri: f.redirectUri, resource: f.resource });
  async function approved(f, credentialIndex = 0) {
    const verifier = 'v'.repeat(43),
      code_challenge = createHash('sha256').update(verifier).digest('base64url');
    const caller = await connect('tr8-oauth-authorization');
    const pending = await oauth(caller, 'begin', {
      client_id: f.clientId,
      redirect_uri: f.redirectUri,
      code_challenge,
      state: 'native-synthetic-state',
      scopes: ['finance:read', 'finance:write'],
      resource: f.resource,
    });
    ok(typeof pending.attempt === 'string', 'synthetic attempt created');
    const approval = await consentOAuthFixture(cluster, f, pending.attempt, credentialIndex);
    ok(approval.code?.startsWith('tr8_oauth_c_'), 'real SQL browser approval issues opaque code');
    return { code: approval.code, verifier, caller };
  }
  async function issued(f, index = 0) {
    const a = await approved(f, index),
      tokens = await oauth(a.caller, 'exchange', codeInput(f, a.code, a.verifier));
    ok(tokens.access_token?.startsWith('tr8_oauth_a_'), 'synthetic opaque access issued');
    return { ...a, tokens };
  }
  const version = async f => (await admin.query('select version::text,snapshot from tr8_private.account_finances where owner_id=$1', [f.owner])).rows[0];
  const lockParent = async (c, f, index = 0) => {
    await c.query('begin');
    await c.query('select 1 from tr8_private.mcp_credentials where id=$1 for update', [f.credentials[index]]);
  };
  const ownerLock = async (c, f) => {
    await c.query('begin');
    await c.query("select pg_advisory_xact_lock(hashtextextended('tr8-account-finance:'||$1,0))", [f.owner]);
  };
  const input = (f, n, patch = {}) => ({
    request_id: `e6000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    expected_version: '1',
    source: { provider: 'gmail', mailbox_id: 'a'.repeat(64), message_id: `oauth-native-message-${n}`, bank_transaction_id: digest(`oauth bank ${n}`) },
    account_id: f.account,
    kind: 'purchase',
    status: 'posted',
    amount: `${100 + n}.20`,
    currency: 'DOP',
    occurred_at: '2026-06-03T14:00:00-04:00',
    time_zone: 'America/Santo_Domingo',
    date: '2026-06-03',
    description: 'Compra OAuth ficticia',
    category: 'other',
    ...patch,
  });
  const caseDone = name => {
    cases.push(name);
    process.stdout.write(JSON.stringify({ case: name, status: 'passed' }) + '\n');
  };
  let report;
  try {
    await admin.query(await fs.readFile(new URL('../../supabase/migrations/20261031210021_mcp_oauth_finance_draft.sql', import.meta.url), 'utf8'));
    const results = await admin.query(await fs.readFile(new URL('../../supabase/tests/mcp_oauth.sql', import.meta.url), 'utf8'));
    const suite = results.flatMap(r => r.rows ?? []).find(r => Object.hasOwn(r, 'checks'));
    ok(Number(suite?.checks) >= 60, 'existing OAuth SQL suite passes native PostgreSQL');
    const untouched = await seedOAuthFixture(cluster),
      untouchedBefore = await version(untouched);

    {
      const f = await seedOAuthFixture(cluster),
        a = await approved(f),
        bad = await connect(),
        good = await connect();
      const denied = await oauth(bad, 'exchange', codeInput(f, a.code, 'x'.repeat(43)));
      equal(denied._tr8_oauth_error?.code, 'invalid_grant', 'incorrect PKCE rejected');
      const codeRow = (await admin.query('select failures,consumed_at from tr8_private.mcp_oauth_codes where code_hash=$1', [digest(a.code)])).rows[0];
      equal(codeRow.failures, 1, 'incorrect verifier budget is persisted');
      equal(codeRow.consumed_at, null, 'incorrect verifier does not consume the authorization code');
      const success = await oauth(good, 'exchange', codeInput(f, a.code, a.verifier));
      ok(success.access_token?.startsWith('tr8_oauth_a_'), 'correct verifier can exchange after one wrong verifier');
      equal((await version(f)).version, '1', 'PKCE/token exchange does not modify ledger');
      caseDone('wrong-pkce-then-correct');
    }
    {
      const f = await seedOAuthFixture(cluster),
        a = await approved(f),
        holder = await connect(),
        left = await connect(),
        right = await connect();
      await lockParent(holder, f);
      const p1 = oauth(left, 'exchange', codeInput(f, a.code, a.verifier)),
        p2 = oauth(right, 'exchange', codeInput(f, a.code, a.verifier));
      await blocked(left, null, 'first authorization exchange waits at parent row');
      await blocked(right, null, 'second authorization exchange also waits');
      await holder.query('commit');
      const values = await Promise.all([p1, p2]);
      equal(values.filter(x => x.access_token).length, 1, 'one concurrent authorization exchange issues tokens');
      equal(values.filter(x => x._tr8_oauth_error?.code === 'invalid_grant').length, 1, 'second concurrent code exchange is rejected');
      const counts = (
        await admin.query(
          'select (select count(*)::int from tr8_private.mcp_oauth_access t join tr8_private.mcp_oauth_grants g on g.id=t.grant_id where g.owner_id=$1)access,(select count(*)::int from tr8_private.mcp_oauth_refresh t join tr8_private.mcp_oauth_grants g on g.id=t.grant_id where g.owner_id=$1)refresh',
          [f.owner],
        )
      ).rows[0];
      equal(counts, { access: 1, refresh: 1 }, 'one access/refresh pair persisted');
      caseDone('single-use-code-two-sessions');
    }
    {
      const f = await seedOAuthFixture(cluster),
        a = await issued(f),
        holder = await connect(),
        left = await connect(),
        right = await connect();
      await lockParent(holder, f);
      const refresh = { client_id: f.clientId, refresh_token: a.tokens.refresh_token, resource: f.resource };
      const p1 = oauth(left, 'refresh', refresh),
        p2 = oauth(right, 'refresh', refresh);
      await blocked(left, null, 'first refresh waits');
      await blocked(right, null, 'second refresh waits');
      await holder.query('commit');
      const values = await Promise.all([p1, p2]);
      const rotated = values.find(x => x.access_token);
      ok(rotated, 'first rotation yields a pair');
      equal(values.filter(x => x._tr8_oauth_error?.code === 'invalid_grant').length, 1, 'old refresh replay rejected');
      equal(
        (await oauth(left, 'verify', { token: rotated.access_token, resource: f.resource }))._tr8_oauth_error?.code,
        'invalid_token',
        'concurrent old refresh reuse invalidates newly rotated access',
      );
      equal(
        (await oauth(left, 'verify', { token: a.tokens.access_token, resource: f.resource }))._tr8_oauth_error?.code,
        'invalid_token',
        'original access also invalidated by family replay',
      );
      equal(
        (await admin.query('select count(*)::int n from tr8_private.mcp_oauth_grants where owner_id=$1 and revoked_at is not null', [f.owner])).rows[0].n,
        1,
        'whole OAuth family revoked persistently',
      );
      equal(await version(f), { version: '1', snapshot: f.snapshot }, 'token rotation/reuse never changes ledger');
      caseDone('refresh-reuse-two-sessions-revokes-family');
    }
    {
      const f = await seedOAuthFixture(cluster),
        a = await issued(f),
        manager = await connect(),
        caller = await connect();
      await browserActor(manager, f);
      await manager.query("select public.tr8_mcp_finance_manage('revoke_grant',$1::jsonb)", [JSON.stringify({ credential_id: f.credentials[0] })]);
      const pending = bridge(caller, a.tokens.access_token, 'finance_submit_notice', input(f, 1));
      await blocked(caller, manager, 'OAuth write waits for parent financial grant revocation');
      await manager.query('commit');
      equal((await pending)._tr8_mcp_error?.code, 'PT401', 'revoked parent denies waiting OAuth write');
      equal(await version(f), { version: '1', snapshot: f.snapshot }, 'parent revocation leaves ledger exact');
      caseDone('parent-grant-revocation-before-oauth-write');
    }
    {
      const f = await seedOAuthFixture(cluster),
        a = await issued(f),
        holder = await connect(),
        writer = await connect(),
        manager = await connect();
      await ownerLock(holder, f);
      const writing = bridge(writer, a.tokens.access_token, 'finance_submit_notice', input(f, 2), false);
      await blocked(writer, holder, 'authorized OAuth writer holds parent and waits owner lock');
      await browserActor(manager, f);
      const downgrade = manager.query("select public.tr8_mcp_finance_manage('set_grant',$1::jsonb)", [JSON.stringify(parentDraft(f, 0, 'read'))]);
      await blocked(manager, writer, 'parent downgrade waits for earlier OAuth transaction');
      await holder.query('commit');
      equal((await writing).status, 'recorded', 'earlier authorized OAuth transaction records');
      await blocked(manager, writer, 'downgrade still waits through actual OAuth writer commit');
      await writer.query('commit');
      await downgrade;
      await manager.query('commit');
      equal(
        (await bridge(writer, a.tokens.access_token, 'finance_submit_notice', input(f, 3, { expected_version: '2' })))._tr8_mcp_error?.code,
        'PT401',
        'parent revision invalidates previous OAuth consent',
      );
      equal((await version(f)).snapshot.financialSpace.operations.length, 1, 'only the earlier permitted purchase survives');
      caseDone('oauth-write-before-parent-downgrade');
    }
    {
      const f = await seedOAuthFixture(cluster),
        a = await issued(f),
        manager = await connect(),
        caller = await connect();
      const grantId = (await oauth(a.caller, 'verify', { token: a.tokens.access_token, resource: f.resource })).grant_id;
      await browserActor(manager, f);
      await manager.query("select public.tr8_mcp_oauth_consent('revoke',$1::jsonb)", [JSON.stringify({ grant_id: grantId })]);
      const pending = bridge(caller, a.tokens.access_token, 'finance_submit_notice', input(f, 4));
      await blocked(caller, manager, 'OAuth caller waits for explicit browser consent revocation');
      await manager.query('commit');
      equal((await pending)._tr8_mcp_error?.code, 'PT401', 'browser-revoked OAuth consent denies late write');
      equal(await version(f), { version: '1', snapshot: f.snapshot }, 'OAuth consent revocation preserves ledger');
      caseDone('browser-oauth-revocation-before-write');
    }
    {
      const f = await seedOAuthFixture(cluster),
        a = await issued(f),
        holder = await connect(),
        caller = await connect();
      await ownerLock(holder, f);
      await admin.query("update tr8_private.mcp_oauth_access set expires_at=clock_timestamp()+interval '1 second'where token_hash=$1", [
        digest(a.tokens.access_token),
      ]);
      const pending = bridge(caller, a.tokens.access_token, 'finance_submit_notice', input(f, 5));
      await blocked(caller, holder, 'OAuth access valid before waiting at owner boundary');
      await waitFor(
        async () =>
          (
            await admin.query('select clock_timestamp()>=expires_at expired from tr8_private.mcp_oauth_access where token_hash=$1', [
              digest(a.tokens.access_token),
            ])
          ).rows[0].expired,
        'actual database clock crosses access-token expiry',
      );
      await holder.query('commit');
      equal((await pending)._tr8_mcp_error?.code, 'PT401', 'expired OAuth access denied after lock wait');
      equal(await version(f), { version: '1', snapshot: f.snapshot }, 'access expiry leaves ledger untouched');
      caseDone('oauth-access-expires-during-wait');
    }
    {
      const f = await seedOAuthFixture(cluster),
        a = await approved(f),
        holder = await connect(),
        caller = await connect();
      await holder.query('begin');
      await holder.query("select pg_advisory_xact_lock(hashtextextended('tr8-mcp-oauth-owner:'||$1,0))", [f.owner]);
      await admin.query("update tr8_private.mcp_oauth_codes set expires_at=clock_timestamp()+interval '1 second'where code_hash=$1", [digest(a.code)]);
      const pending = oauth(caller, 'exchange', codeInput(f, a.code, a.verifier));
      await blocked(caller, holder, 'valid authorization code waits at OAuth owner budget lock');
      await waitFor(
        async () =>
          (await admin.query('select clock_timestamp()>=expires_at expired from tr8_private.mcp_oauth_codes where code_hash=$1', [digest(a.code)])).rows[0]
            .expired,
        'actual database clock crosses authorization-code expiry',
      );
      await holder.query('commit');
      equal((await pending)._tr8_oauth_error?.code, 'invalid_grant', 'code that expires while waiting cannot issue tokens');
      equal(
        (
          await admin.query(
            'select count(*)::int n from tr8_private.mcp_oauth_access t join tr8_private.mcp_oauth_grants g on g.id=t.grant_id where g.owner_id=$1',
            [f.owner],
          )
        ).rows[0].n,
        0,
        'expired waiting code persists no access token',
      );
      equal(
        (await admin.query('select consumed_at from tr8_private.mcp_oauth_codes where code_hash=$1', [digest(a.code)])).rows[0].consumed_at,
        null,
        'expired waiting code is not consumed',
      );
      caseDone('authorization-code-expires-during-owner-lock');
    }
    {
      const f = await seedOAuthFixture(cluster),
        caller = await connect(),
        browser = await connect(),
        manager = await connect();
      const pending = await oauth(caller, 'begin', {
        client_id: f.clientId,
        redirect_uri: f.redirectUri,
        code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
        scopes: ['finance:read', 'finance:write'],
        resource: f.resource,
      });
      await browserActor(browser, f);
      const details = (await browser.query("select public.tr8_mcp_oauth_consent('details',$1::jsonb)result", [JSON.stringify({ attempt: pending.attempt })]))
        .rows[0].result;
      await browser.query('commit');
      const reviewed = details.connections.find(connection => connection.credential_id === f.credentials[0]);
      await browserActor(manager, f);
      await manager.query("select public.tr8_mcp_finance_manage('set_grant',$1::jsonb)", [JSON.stringify(parentDraft(f))]);
      await browserActor(browser, f);
      const approving = browser
        .query("select public.tr8_mcp_oauth_consent('approve',$1::jsonb)result", [
          JSON.stringify({ attempt: pending.attempt, credential_id: f.credentials[0], grant_fingerprint: reviewed.grant_fingerprint }),
        ])
        .then(
          r => r.rows[0].result,
          error => ({ _sql_error: { code: error.code } }),
        );
      await blocked(browser, manager, 'consent approval waits for parent grant revision after review');
      await manager.query('commit');
      const approval = await approving;
      await browser.query('rollback');
      equal(approval._sql_error?.code, 'PT409', 'stale reviewed fingerprint refuses widened or revised parent consent');
      equal(
        (await admin.query('select count(*)::int n from tr8_private.mcp_oauth_grants where owner_id=$1', [f.owner])).rows[0].n,
        0,
        'stale review persists no OAuth grant',
      );
      equal(await version(f), { version: '1', snapshot: f.snapshot }, 'stale consent review never changes financial ledger');
      caseDone('consent-parent-revision-after-review');
    }
    {
      const f = await seedOAuthFixture(cluster),
        caller = await connect(),
        browser = await connect(),
        holder = await connect();
      const pending = await oauth(caller, 'begin', {
        client_id: f.clientId,
        redirect_uri: f.redirectUri,
        code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
        scopes: ['finance:read', 'finance:write'],
        resource: f.resource,
      });
      await browserActor(browser, f);
      const details = (await browser.query("select public.tr8_mcp_oauth_consent('details',$1::jsonb)result", [JSON.stringify({ attempt: pending.attempt })]))
        .rows[0].result;
      await browser.query('commit');
      const reviewed = details.connections.find(connection => connection.credential_id === f.credentials[0]);
      await admin.query("update auth.sessions set not_after=clock_timestamp()+interval '1 second' where id=$1", [f.owner]);
      await holder.query('begin');
      await holder.query('select 1 from tr8_private.mcp_oauth_attempts where attempt_hash=$1 for update', [digest(pending.attempt)]);
      await browserActor(browser, f);
      const approving = browser
        .query("select public.tr8_mcp_oauth_consent('approve',$1::jsonb)result", [
          JSON.stringify({ attempt: pending.attempt, credential_id: f.credentials[0], grant_fingerprint: reviewed.grant_fingerprint }),
        ])
        .then(
          r => r.rows[0].result,
          error => ({ _sql_error: { code: error.code } }),
        );
      await blocked(browser, holder, 'live browser approval waits on the actual consent attempt row');
      await waitFor(
        async () => (await admin.query('select clock_timestamp()>=not_after expired from auth.sessions where id=$1', [f.owner])).rows[0].expired,
        'actual database clock crosses browser session deadline',
      );
      await holder.query('commit');
      equal((await approving)._sql_error?.code, '42501', 'expired browser session cannot approve after waiting');
      await browser.query('rollback');
      equal(
        (await admin.query('select count(*)::int n from tr8_private.mcp_oauth_grants where owner_id=$1', [f.owner])).rows[0].n,
        0,
        'expired waiting session persists no OAuth grant',
      );
      caseDone('browser-session-expires-during-consent-wait');
    }
    {
      const f = await seedOAuthFixture(cluster),
        a = await issued(f),
        holder = await connect(),
        caller = await connect();
      const grantId = (await oauth(a.caller, 'verify', { token: a.tokens.access_token, resource: f.resource })).grant_id;
      await admin.query("update tr8_private.mcp_credentials set expires_at=clock_timestamp()+interval '1 second' where id=$1", [f.credentials[0]]);
      await holder.query('begin');
      await holder.query('select 1 from tr8_private.mcp_oauth_grants where id=$1 for update', [grantId]);
      const pending = bridge(caller, a.tokens.access_token, 'finance_submit_notice', input(f, 8));
      await blocked(caller, holder, 'valid parent credential waits at OAuth grant row');
      await waitFor(
        async () =>
          (await admin.query('select clock_timestamp()>=expires_at expired from tr8_private.mcp_credentials where id=$1', [f.credentials[0]])).rows[0].expired,
        'actual database clock crosses parent credential deadline',
      );
      await holder.query('commit');
      equal((await pending)._tr8_mcp_error?.code, 'PT401', 'parent that expires while waiting cannot authorize a financial write');
      equal(await version(f), { version: '1', snapshot: f.snapshot }, 'parent expiry leaves exact financial ledger');
      caseDone('parent-credential-expires-during-oauth-grant-wait');
    }
    {
      const f = await seedOAuthFixture(cluster),
        a = await issued(f, 1),
        holder = await connect(),
        patClient = await connect(),
        oauthClient = await connect();
      await ownerLock(holder, f);
      const notice = input(f, 6),
        alias = input(f, 7, { amount: notice.amount, source: { ...notice.source, message_id: 'same_bank_via_oauth' } });
      const p1 = anon(patClient, 'select public.tr8_mcp_finance_dispatch($1,$2,$3::jsonb)result', [f.pats[0], 'finance_submit_notice', JSON.stringify(notice)]);
      const p2 = bridge(oauthClient, a.tokens.access_token, 'finance_submit_notice', alias);
      await blocked(patClient, holder, 'PAT using its own parent reaches owner lock');
      await blocked(oauthClient, holder, 'OAuth on different parent also reaches shared owner lock');
      await holder.query('commit');
      const results = await Promise.all([p1, p2]);
      ok(
        results.every(x => x.status === 'recorded') && results[0].operation_id === results[1].operation_id,
        'PAT and OAuth share owner-wide source idempotency',
      );
      equal((await version(f)).snapshot.financialSpace.operations.length, 1, 'mixed transport yields exactly one purchase');
      equal(
        (await anon(patClient, 'select public.tr8_mcp_finance_dispatch($1,$2,$3::jsonb)result', [a.tokens.access_token, 'finance_context', '{}']))._sql_error
          ?.code,
        'PT401',
        'legacy PAT RPC rejects OAuth token prefix',
      );
      equal(
        (await bridge(oauthClient, a.tokens.access_token, 'list_projects'))._tr8_mcp_error?.code,
        'PT403',
        'OAuth financial bridge refuses unrelated project actions',
      );
      caseDone('oauth-and-pat-same-bank-idempotency-and-isolation');
    }
    equal(await version(untouched), untouchedBefore, 'unrelated owner exact ledger preserved across all OAuth races');
    report = {
      checks,
      sqlChecks: Number(suite.checks),
      observedLockBarriers: barriers,
      cases,
      postgresVersion: cluster.version,
      concurrentPgSessions: true,
      hosted: false,
      realData: false,
    };
  } finally {
    const cleanup = await cluster.close();
    assert.ok(cleanup.portClosed);
    if (report) report.cleanup = cleanup;
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(await run(process.argv[2])) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message, code: error.code }) + '\n');
    process.exitCode = 1;
  }
}
