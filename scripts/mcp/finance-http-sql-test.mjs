// Offline rehearsal: real MCP SDK/HTTP handler + SQL RPC, mocked PostgREST wire.
// Not a hosted endpoint, not a dot/cloud test, and not a multi-session PG race.
// Compile first: tsc -p tsconfig.mcp.json --noEmit false --outDir test-results/mcp-finance-runtime
// Usage: node scripts/mcp/finance-http-sql-test.mjs <absolute PGlite package root>
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createFinanceTestDatabase } from './finance-sql-test.mjs';
import { handleMcpRequest } from '../../test-results/mcp-finance-runtime/server/mcp/http.js';
import { createMcpDispatch } from '../../test-results/mcp-finance-runtime/server/mcp/backend.js';

const db = await createFinanceTestDatabase(process.argv[2]);
const owner = 'e1000000-0000-4000-8000-000000000001';
const workspace = 'e1000010-0000-4000-8000-000000000001';
const credential = 'e1000030-0000-4000-8000-000000000001';
const token = `tr8_mcp_${'a'.repeat(64)}`;
const mailbox = 'c'.repeat(64);
let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
const clients = [];
const scalar = async sql => (await db.query(sql)).rows[0];
async function makeClient(auth = token, enabled = true) {
  const client = new Client({ name: 'offline-financial-sql-client', version: '1.0.0' });
  const dispatch = createMcpDispatch(auth, {
    url: 'https://offline.example',
    key: 'synthetic-public-key',
    financeEnabled: enabled,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      const isFinance = url.pathname === '/rest/v1/rpc/tr8_mcp_finance_dispatch';
      // Initial legacy context is represented by the real finance auth check in
      // this minimal fixture. Existing legacy context has separate SDK tests.
      assert.ok(isFinance || body.p_action === 'context');
      try {
        const value = await db.transaction(async tx => {
          await tx.exec('set local role anon');
          const { rows } = await tx.query('select public.tr8_mcp_finance_dispatch($1,$2,$3::jsonb) as result', [
            body.p_token,
            isFinance ? body.p_action : 'finance_context',
            JSON.stringify(body.p_input),
          ]);
          return rows[0].result;
        });
        return Response.json(value);
      } catch (error) {
        return Response.json({ code: error.code }, { status: 400 });
      }
    },
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('https://tr8.example/api/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${auth}` } },
      fetch: async (url, init) => handleMcpRequest(new Request(url, init), { dispatch: () => dispatch, financeEnabled: enabled }),
    }),
  );
  clients.push(client);
  return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name: `tr8_${name}`, arguments: args });
  const data = JSON.parse(result.content[0].text);
  if (result.isError) throw Object.assign(Error(data.message), { code: data.code });
  return data;
}
function notice(n, patch = {}) {
  return {
    request_id: `e2000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    expected_version: '1',
    source: { provider: 'gmail', mailbox_id: mailbox, message_id: `message_${n}`, bank_transaction_id: n.toString(16).padStart(64, '0') },
    account_id: 'cash-dop',
    kind: 'purchase',
    status: 'posted',
    amount: '20.20',
    currency: 'DOP',
    occurred_at: '2026-06-03T14:00:00-04:00',
    time_zone: 'America/Santo_Domingo',
    date: '2026-06-03',
    description: 'Compra ficticia',
    category: 'other',
    ...patch,
  };
}
try {
  await db.query(`insert into auth.users(id,email,email_confirmed_at)values($1,'synthetic@example.test',clock_timestamp());`, [owner]);
  await db.query('insert into auth.sessions(id,user_id)values($1,$1)', [owner]);
  await db.query('insert into tr8_private.app_users(user_id)values($1)', [owner]);
  await db.query("insert into tr8_private.workspaces(id,owner_id,kind,name)values($1,$2,'personal','Synthetic')", [workspace, owner]);
  await db.query('insert into tr8_private.workspace_members(workspace_id,user_id)values($1,$2)', [workspace, owner]);
  await db.query(
    "insert into tr8_private.mcp_credentials(id,owner_id,workspace_id,name,access,token_hash,expires_at)values($1,$2,$3,'Synthetic','read',encode(sha256(convert_to($4,'UTF8')),'hex'),clock_timestamp()+interval '1 day')",
    [credential, owner, workspace, token],
  );
  const snapshot = {
    schemaVersion: 1,
    financialSpace: {
      domainSchemaVersion: 5,
      currencyCatalogVersion: 'currency-catalog-v1',
      currencyDefinitions: ['DOP', 'USD', 'EUR', 'BOB'].map(code => ({ code, minorUnitDigits: 2 })),
      accounts: [{ id: 'cash-dop', type: 'debit', name: 'Ahorro ficticio', currency: 'DOP', openingBalanceMinor: 1000000, openingDate: '2026-01-01' }],
      operations: [],
      plans: [],
    },
  };
  await db.query('insert into tr8_private.account_finances(owner_id,version,snapshot,operation_id)values($1,1,$2::jsonb,gen_random_uuid())', [
    owner,
    JSON.stringify(snapshot),
  ]);
  const grant = {
    credential_id: credential,
    access: 'write',
    accounts: [{ account_id: 'cash-dop', start_at: '2026-01-02T00:00:00Z' }],
    mailbox_ids: [mailbox],
    expense_categories: ['other'],
    income_categories: ['salary', 'other'],
  };
  await db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated', session_id: owner })]);
    await tx.exec('set local role authenticated');
    await tx.query("select public.tr8_mcp_finance_manage('set_grant',$1::jsonb)", [JSON.stringify(grant)]);
  });
  const client = await makeClient();
  const tools = (await client.listTools()).tools;
  check(tools.length === 17, 'opt-in tool count');
  const accounts = await call(client, 'list_finance_accounts');
  check(accounts.items.length === 1 && accounts.items[0].currency === 'DOP', 'real SQL account lookup');
  const input = notice(1);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => call(client, 'submit_finance_notice', input)));
  check(
    concurrent.every(r => r.status === 'recorded' && r.operation_id === concurrent[0].operation_id),
    'eight simultaneous MCP retries share one receipt',
  );
  check(
    (await scalar("select jsonb_array_length(snapshot#>'{financialSpace,operations}') as n from tr8_private.account_finances")).n === 1,
    'one SQL movement after retries',
  );
  check(concurrent[0].version === '2', 'one ledger version increment');
  const alias = await call(client, 'submit_finance_notice', notice(2, { expected_version: '2', source: { ...input.source, message_id: 'second_email' } }));
  check(alias.operation_id === concurrent[0].operation_id, 'a second bank email links the same operation');
  const income = await call(
    client,
    'submit_finance_notice',
    notice(3, { expected_version: '2', kind: 'income', amount: '1000.01', category: 'salary', description: 'Ingreso ficticio' }),
  );
  check(income.status === 'recorded' && income.version === '3', 'income uses exact existing financial ledger');
  const retry = await call(client, 'submit_finance_notice', input);
  check(retry.operation_id === concurrent[0].operation_id && retry.version === '2', 'lost response retry survives later writes');
  const duplicateAmount = await call(client, 'submit_finance_notice', notice(4, { expected_version: '3' }));
  check(duplicateAmount.status === 'review', 'same amount/date with new bank ID stays review, never merged');
  for (const [n, patch] of [
    [5, { kind: 'own_transfer' }],
    [6, { kind: 'card_payment' }],
    [7, { kind: 'refund' }],
    [8, { kind: 'reversal' }],
    [9, { status: 'pending' }],
    [10, { status: 'rejected' }],
    [11, { kind: 'unknown', amount: undefined, currency: undefined }],
  ]) {
    // Pace/quota behavior is covered by SQL tests; reset only the fake credential
    // counter here so protocol assertions remain independent of SDK handshakes.
    await db.query('update tr8_private.mcp_credentials set minute_count=0');
    const result = await call(client, 'submit_finance_notice', notice(n, { expected_version: '3', ...patch }));
    check(result.status === 'review' && result.operation_id === null && result.version === '3', `${patch.kind ?? patch.status} does not affect balances`);
  }
  await assert.rejects(call(client, 'submit_finance_notice', notice(20, { expected_version: '3', account_id: 'foreign-account' })), { code: 'PT403' });
  checks++;
  await assert.rejects(call(client, 'submit_finance_notice', notice(21, { expected_version: '3', currency: 'USD' })), { code: 'INVALID_INPUT' });
  checks++;
  const history = await call(client, 'list_finance_movements', { date_from: '2026-06-01', date_to: '2026-07-01', limit: 1 });
  check(history.items.length === 1 && history.next_cursor !== null, 'movement pagination');
  const history2 = await call(client, 'list_finance_movements', { date_from: '2026-06-01', date_to: '2026-07-01', cursor: history.next_cursor, limit: 1 });
  check(history2.items.length === 1 && history2.next_cursor === null, 'second movement page');
  const row = await scalar("select snapshot#>'{financialSpace,operations}' as operations from tr8_private.account_finances");
  check(
    row.operations.length === 2 && row.operations.some(o => o.amountMinor === 2020) && row.operations.some(o => o.amountMinor === 100001),
    'exact DOP cents and only two confirmed operations',
  );
  check(
    row.operations.every(o => o.note === ''),
    'source/email data is outside notes',
  );
  process.stdout.write(
    JSON.stringify({ checks, mode: 'offline-http-and-sql', parallelMcpRetries: 8, hosted: false, concurrentPgSessions: false, cloudDotTest: false }) + '\n',
  );
} catch (error) {
  process.stderr.write(JSON.stringify({ message: error.message, code: error.code }) + '\n');
  process.exitCode = 1;
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
  await db.close();
}
