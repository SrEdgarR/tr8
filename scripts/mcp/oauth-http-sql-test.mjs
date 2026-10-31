// Synthetic loopback-only SDK OAuth + MCP HTTP + native PostgreSQL rehearsal.
// The PostgREST wire is adapted to parameterized SQL; no hosted fetch is allowed.
// Compile: tsc -p tsconfig.mcp.json --noEmit false --outDir test-results/mcp-finance-runtime
// Run: node scripts/mcp/oauth-http-sql-test.mjs <absolute isolated native tools root>
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { auth as sdkAuth } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createNativeFinanceTestDatabase } from './finance-concurrency-test.mjs';
import { seedOAuthFixture, consentOAuthFixture } from './oauth-concurrency-test.mjs';
import { createOAuthBackend } from '../../test-results/mcp-finance-runtime/server/mcp/oauth/backend.js';
import {
  createOAuthProtocolRouter,
  oauthAuthorizationMetadata,
  oauthProtectedResourceMetadata,
  oauthResourceChallenge,
} from '../../test-results/mcp-finance-runtime/server/mcp/oauth/router.js';
import { createMcpDispatch } from '../../test-results/mcp-finance-runtime/server/mcp/backend.js';
import { handleMcpRequest } from '../../test-results/mcp-finance-runtime/server/mcp/http.js';

const cluster = await createNativeFinanceTestDatabase(process.argv[2]);
const issuer = 'https://tr8.vercel.app';
let checks = 0,
  rpcCalls = 0,
  server,
  report;
const clients = [];
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
try {
  await cluster.admin.query(await fs.readFile(new URL('../../supabase/migrations/20261031210021_mcp_oauth_finance_draft.sql', import.meta.url), 'utf8'));
  const f = await seedOAuthFixture(cluster);
  const other = await seedOAuthFixture(cluster);
  const otherBefore = (await cluster.admin.query('select version::text,snapshot from tr8_private.account_finances where owner_id=$1', [other.owner])).rows[0];
  const rpcFetch = async (target, init) => {
    const url = new URL(target);
    assert.equal(url.origin, 'https://synthetic-db.invalid');
    assert.equal(init.headers.apikey, 'synthetic-public-key');
    assert.equal(new Headers(init.headers).has('Authorization'), false, 'no user JWT or service-role is delegated');
    const body = JSON.parse(init.body);
    const sql =
      url.pathname === '/rest/v1/rpc/tr8_mcp_oauth_server'
        ? ['select public.tr8_mcp_oauth_server($1,$2::jsonb)result', [body.p_action, JSON.stringify(body.p_input)]]
        : url.pathname === '/rest/v1/rpc/tr8_mcp_oauth_finance_dispatch'
          ? ['select public.tr8_mcp_oauth_finance_dispatch($1,$2,$3::jsonb)result', [body.p_token, body.p_action, JSON.stringify(body.p_input)]]
          : null;
    assert.ok(sql, 'only the two explicit public OAuth RPCs are used');
    const c = await cluster.connect('tr8-sdk-http-synthetic-rpc');
    rpcCalls++;
    try {
      await c.query('begin');
      await c.query('set local role anon');
      const result = (await c.query(...sql)).rows[0].result;
      await c.query('commit');
      return Response.json(result);
    } catch (error) {
      await c.query('rollback');
      return Response.json({ code: error.code }, { status: 400 });
    } finally {
      await c.end();
    }
  };
  const backend = { url: 'https://synthetic-db.invalid', key: 'synthetic-public-key', fetch: rpcFetch };
  const protocol = createOAuthProtocolRouter({ enabled: true, dispatch: createOAuthBackend(backend) });
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, issuer);
      let response;
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) response = Response.json(oauthProtectedResourceMetadata());
      else if (url.pathname === '/.well-known/oauth-authorization-server') response = Response.json(oauthAuthorizationMetadata());
      else if (url.pathname === '/api/mcp/finance') {
        const hasBody = !['GET', 'HEAD'].includes(req.method);
        response = await handleMcpRequest(
          new Request(url, {
            method: req.method,
            headers: req.headers,
            ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
          }),
          {
            oauthFinance: { challenge: oauthResourceChallenge() },
            dispatch: token => createMcpDispatch(token, { ...backend, financeEnabled: true, oauthFinance: true }),
          },
        );
      } else {
        protocol(req, res);
        return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500);
      res.end('Synthetic test handler failed');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const localFetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, issuer, 'never contact an external issuer or callback');
    assert.ok(url.pathname.startsWith('/.well-known/') || /^\/api\/(oauth\/(authorize|token|revoke)|mcp\/finance)$/.test(url.pathname));
    return fetch(`${base}${url.pathname}${url.search}`, { ...init, redirect: 'manual' });
  };
  async function authorize(scope) {
    let verifier, authorization, saved;
    const metadata = {
      client_id: f.clientId,
      client_name: 'SDK ficticio',
      redirect_uris: [f.redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
    const provider = {
      redirectUrl: f.redirectUri,
      clientMetadata: metadata,
      clientInformation: () => ({ ...metadata, issuer }),
      tokens: () => saved,
      saveTokens: value => {
        saved = value;
      },
      redirectToAuthorization: value => {
        authorization = value;
      },
      saveCodeVerifier: value => {
        verifier = value;
      },
      codeVerifier: () => verifier,
      state: () => 'synthetic-sdk-state',
    };
    check((await sdkAuth(provider, { serverUrl: f.resource, scope, fetchFn: localFetch })) === 'REDIRECT', 'SDK discovers authorization metadata');
    check(authorization.searchParams.get('code_challenge_method') === 'S256', 'SDK generates PKCE S256');
    const begin = await localFetch(authorization, { redirect: 'manual' });
    check(begin.status === 302, 'actual HTTP authorization creates pending SQL attempt');
    const location = new URL(begin.headers.get('location'));
    check(location.pathname === '/oauth/consent' && [...location.searchParams.keys()].join() === 'attempt', 'browser URL carries only a pending nonce');
    const approval = await consentOAuthFixture(cluster, f, location.searchParams.get('attempt'));
    check(approval.state === 'synthetic-sdk-state', 'real browser-session SQL consent retains state');
    check(
      (await sdkAuth(provider, { serverUrl: f.resource, scope, authorizationCode: approval.code, fetchFn: localFetch })) === 'AUTHORIZED',
      'SDK exchanges one-time code through HTTP into SQL',
    );
    check(
      /^tr8_oauth_a_[a-f0-9]{64}$/.test(saved.access_token) && !saved.access_token.includes('.'),
      'client receives opaque financial access, not a browser JWT',
    );
    return saved;
  }
  async function clientFor(tokens) {
    const c = new Client({ name: 'synthetic-oauth-finance-sdk', version: '1.0.0' });
    clients.push(c);
    await c.connect(
      new StreamableHTTPClientTransport(new URL(f.resource), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
        fetch: localFetch,
      }),
    );
    return c;
  }
  async function call(c, name, args = {}) {
    const r = await c.callTool({ name: `tr8_${name}`, arguments: args });
    let data;
    try {
      data = JSON.parse(r.content[0].text);
    } catch {
      assert.equal(r.isError, true, 'only SDK protocol errors may omit structured financial data');
      data = null;
    }
    return { data, error: r.isError === true };
  }
  const writeTokens = await authorize('finance:read finance:write');
  const writer = await clientFor(writeTokens);
  check((await writer.listTools()).tools.length === 6, 'write token sees six financial tools only');
  const accounts = (await call(writer, 'list_finance_accounts')).data;
  check(accounts.items.length === 1 && accounts.items[0].id === f.account, 'account list reads real SQL grant');
  const notice = {
    request_id: 'e7000000-0000-4000-8000-000000000001',
    expected_version: '1',
    source: {
      provider: 'gmail',
      mailbox_id: 'a'.repeat(64),
      message_id: 'sdk-synthetic-message',
      bank_transaction_id: createHash('sha256').update('sdk bank reference').digest('hex'),
    },
    account_id: f.account,
    kind: 'purchase',
    status: 'posted',
    amount: '20.20',
    currency: 'DOP',
    occurred_at: '2026-06-03T14:00:00-04:00',
    time_zone: 'America/Santo_Domingo',
    date: '2026-06-03',
    description: 'Compra ficticia SDK',
    category: 'other',
  };
  const submissions = await Promise.all(Array.from({ length: 4 }, () => call(writer, 'submit_finance_notice', notice)));
  check(
    submissions.every(r => !r.error),
    'concurrent SDK replays receive committed receipts',
  );
  check(
    submissions.every(r => JSON.stringify(r.data) === JSON.stringify(submissions[0].data)),
    'all replays return the same historical receipt',
  );
  const ledger = (await cluster.admin.query('select version::text,snapshot from tr8_private.account_finances where owner_id=$1', [f.owner])).rows[0];
  check(ledger.version === '2' && ledger.snapshot.financialSpace.operations.length === 1, 'HTTP requests commit one movement and one version');
  check(ledger.snapshot.financialSpace.operations[0].amountMinor === 2020, 'exact integer cents survive SDK, HTTP and SQL');
  const movements = (await call(writer, 'list_finance_movements', { date_from: '2026-06-01', date_to: '2026-07-01' })).data;
  check(movements.items.length === 1, 'reconciliation retrieves the one committed movement');
  const reader = await clientFor(await authorize('finance:read'));
  const names = (await reader.listTools()).tools.map(t => t.name);
  check(names.length === 5 && !names.includes('tr8_submit_finance_notice'), 'read consent exposes no writer tool');
  check((await call(reader, 'submit_finance_notice', notice)).error, 'hidden write cannot be called by name');
  const foreign = await call(writer, 'list_finance_movements', { date_from: '2026-06-01', date_to: '2026-07-01', account_id: other.account });
  check(foreign.error, 'other owner account is rejected through the complete resource path');
  const post = (path, values) =>
    localFetch(`${issuer}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });
  const rotate = await post('/api/oauth/token', {
    grant_type: 'refresh_token',
    client_id: f.clientId,
    refresh_token: writeTokens.refresh_token,
    resource: f.resource,
  });
  check(rotate.status === 200, 'real HTTP refresh rotates SQL token family');
  const rotated = await rotate.json();
  check(rotated.access_token !== writeTokens.access_token && rotated.refresh_token !== writeTokens.refresh_token, 'both tokens rotate');
  const revoke = await post('/api/oauth/revoke', { client_id: f.clientId, token: rotated.access_token });
  check(revoke.status === 200, 'HTTP revocation succeeds');
  const denied = await localFetch(f.resource, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rotated.access_token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  check(
    denied.status === 401 && denied.headers.get('www-authenticate')?.includes('resource_metadata'),
    'revoked token receives discovery challenge without data',
  );
  check((await call(reader, 'list_finance_accounts')).data.items.length === 1, 'separate read-only grant survives writer revocation');
  assert.deepEqual(
    (await cluster.admin.query('select version::text,snapshot from tr8_private.account_finances where owner_id=$1', [other.owner])).rows[0],
    otherBefore,
  );
  check(true, 'unrelated owner ledger remains byte-for-byte equivalent');
  report = {
    checks,
    rpcCalls,
    postgresVersion: cluster.version,
    officialSdk: true,
    loopbackHttp: true,
    postgrestWire: 'synthetic SQL adapter',
    hosted: false,
    realData: false,
  };
} finally {
  await Promise.allSettled(clients.map(c => c.close()));
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  const cleanup = await cluster.close();
  assert.ok(cleanup.portClosed);
  if (report) report.cleanup = cleanup;
}
process.stdout.write(JSON.stringify(report) + '\n');
