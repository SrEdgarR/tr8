import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import authorizeEntry from '../../../api/oauth/authorize';
import tokenEntry from '../../../api/oauth/token';
import revokeEntry from '../../../api/oauth/revoke';
import { createOAuthEntry } from './entry';

const servers: Server[] = [];
const clientId = 'synthetic-static-client';
const redirect = 'https://client.example/callback';
const code = `tr8_oauth_c_${'a'.repeat(64)}`;
const access = `tr8_oauth_a_${'b'.repeat(64)}`;
const refresh = `tr8_oauth_r_${'c'.repeat(64)}`;
const resource = 'https://tr8.vercel.app/api/mcp/finance';
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function configure(enabled = true) {
  vi.stubEnv('TR8_MCP_OAUTH_REVIEW_ENABLED', String(enabled));
  vi.stubEnv('TR8_MCP_FINANCE_REVIEW_ENABLED', 'true');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://synthetic-db.invalid');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'synthetic-public-key');
  const originalFetch = globalThis.fetch;
  const database = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const input = JSON.parse(String(init?.body));
    if (input.p_action === 'get_client')
      return Response.json({
        client_id: clientId,
        client_name: 'Synthetic static client',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    if (input.p_action === 'begin') return Response.json({ attempt: `tr8_oauth_p_${'d'.repeat(64)}`, expires_at: new Date(Date.now() + 300000).toISOString() });
    if (input.p_action === 'exchange')
      return Response.json({ access_token: access, token_type: 'Bearer', expires_in: 900, refresh_token: refresh, scope: 'finance:read' });
    if (input.p_action === 'revoke') return Response.json({});
    throw Error('Unexpected synthetic RPC');
  });
  return { database, originalFetch };
}
async function listen() {
  const app = createOAuthEntry();
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No synthetic loopback port');
  return `http://127.0.0.1:${address.port}`;
}
const authorization = () =>
  new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: 'x'.repeat(43),
    code_challenge_method: 'S256',
    scope: 'finance:read',
    state: 'synthetic-state',
    resource,
  });
const exchange = () =>
  new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: 'v'.repeat(43), redirect_uri: redirect, resource });

describe('static OAuth Node entry points', () => {
  it('exports the same actual Express listener from the three static API files', () => {
    expect(authorizeEntry).toBe(tokenEntry);
    expect(tokenEntry).toBe(revokeEntry);
    // The Vercel Node runtime uses this Express detection to skip its helpers.
    expect(typeof tokenEntry.listen).toBe('function');
  });
  it('returns unavailable while disabled without contacting the backend', async () => {
    const h = configure(false),
      base = await listen();
    const response = await h.originalFetch(`${base}/api/oauth/authorize?${authorization()}`);
    expect(response.status).toBe(503);
    expect(h.database).not.toHaveBeenCalled();
  });
  it('handles actual Node requests for authorize, form token exchange and revocation', async () => {
    const h = configure(),
      base = await listen();
    const begin = await h.originalFetch(`${base}/api/oauth/authorize?${authorization()}`, { redirect: 'manual' });
    expect(begin.status).toBe(302);
    expect(new URL(begin.headers.get('location')!).pathname).toBe('/oauth/consent');
    const result = await h.originalFetch(`${base}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: exchange(),
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ access_token: access, scope: 'finance:read' });
    expect(result.headers.get('cache-control')).toBe('no-store');
    const revoke = await h.originalFetch(`${base}/api/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, token: access }),
    });
    expect(revoke.status).toBe(200);
    expect(h.database.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).p_action)).toContain('revoke');
  });
  it('rejects route-like query parameters instead of weakening the OAuth allowlist', async () => {
    const h = configure(),
      base = await listen();
    const query = authorization();
    query.set('action', 'authorize');
    expect((await h.originalFetch(`${base}/api/oauth/authorize?${query}`, { redirect: 'manual' })).status).toBe(400);
    expect(
      (
        await h.originalFetch(`${base}/api/oauth/token?action=token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: exchange(),
        })
      ).status,
    ).toBe(400);
    expect(h.database).not.toHaveBeenCalled();
  });
  it('retains its raw form parser bounds and rejects duplicate fields over Node HTTP', async () => {
    const h = configure(),
      base = await listen();
    const doubled = exchange();
    doubled.append('client_id', clientId);
    const request = (body: URLSearchParams) =>
      h.originalFetch(`${base}/api/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    expect((await request(doubled)).status).toBe(400);
    const oversized = exchange();
    oversized.set('code_verifier', 'v'.repeat(17000));
    const failed = await request(oversized);
    expect(failed.status).toBe(400);
    expect(await failed.text()).not.toContain('v'.repeat(50));
    expect(h.database).not.toHaveBeenCalled();
  });
});
