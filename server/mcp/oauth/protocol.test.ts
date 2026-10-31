import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { auth as sdkAuth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createOAuthProtocolRouter } from './router';
import {
  createOAuthProvider,
  oauthAuthorizationMetadata,
  oauthProtectedResourceMetadata,
  oauthResourceChallenge,
  verifyOAuthAccessToken,
  OAUTH_ISSUER,
  OAUTH_RESOURCE,
} from './provider';
import { createOAuthBackend, type OAuthServerDispatch } from './backend';

const servers: Server[] = [];
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
});
const client = {
  client_id: 'tr8-cloud-test',
  client_name: 'Synthetic cloud client',
  redirect_uris: ['https://client.example/callback'],
  token_endpoint_auth_method: 'none' as const,
  grant_types: ['authorization_code' as const, 'refresh_token' as const],
  response_types: ['code' as const],
};
const grant = '11111111-1111-4111-8111-111111111111';
const verifier = 'a'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const code = 'tr8_oauth_c_' + 'c'.repeat(64);
const access = 'tr8_oauth_a_' + 'a'.repeat(64);
const refresh = 'tr8_oauth_r_' + 'b'.repeat(64);
const nextAccess = 'tr8_oauth_a_' + 'd'.repeat(64);
const nextRefresh = 'tr8_oauth_r_' + 'e'.repeat(64);

function fixture() {
  let usedCode = false,
    usedRefresh = false,
    revoked = false;
  let storedChallenge = challenge;
  const dispatch = vi.fn<OAuthServerDispatch>(async (action, input) => {
    if (action === 'get_client') return input.client_id === client.client_id ? client : null;
    if (action === 'begin') {
      storedChallenge = input.code_challenge as string;
      return { attempt: 'tr8_oauth_p_' + 'f'.repeat(64), expires_at: new Date(Date.now() + 300000).toISOString() };
    }
    if (action === 'challenge') return { code_challenge: challenge };
    if (action === 'exchange') {
      if (input.resource !== OAUTH_RESOURCE) throw new InvalidTargetError('Invalid resource');
      if (
        usedCode ||
        input.code !== code ||
        typeof input.code_verifier !== 'string' ||
        createHash('sha256').update(input.code_verifier).digest('base64url') !== storedChallenge ||
        input.redirect_uri !== client.redirect_uris[0] ||
        input.client_id !== client.client_id
      )
        throw new InvalidGrantError('Invalid grant');
      usedCode = true;
      return { access_token: access, token_type: 'Bearer', expires_in: 900, refresh_token: refresh, scope: 'finance:read' };
    }
    if (action === 'refresh') {
      if (input.refresh_token !== refresh || usedRefresh || revoked) {
        revoked = true;
        throw new InvalidGrantError('Invalid grant');
      }
      if (input.scopes && JSON.stringify(input.scopes) !== JSON.stringify(['finance:read'])) throw new InvalidGrantError('Scope escalation');
      usedRefresh = true;
      return { access_token: nextAccess, token_type: 'Bearer', expires_in: 900, refresh_token: nextRefresh, scope: 'finance:read' };
    }
    if (action === 'verify') {
      if (revoked || ![access, nextAccess].includes(input.token as string)) throw new InvalidTokenError('Invalid token');
      return {
        client_id: client.client_id,
        scopes: ['finance:read'],
        expires_at: new Date(Date.now() + 900000).toISOString(),
        resource: OAUTH_RESOURCE,
        grant_id: grant,
      };
    }
    if (action === 'revoke') {
      revoked = true;
      return {};
    }
    throw Error('Unexpected synthetic action');
  });
  return { dispatch };
}
async function listen(dispatch: OAuthServerDispatch, enabled = true) {
  const server = createServer(createOAuthProtocolRouter({ dispatch, enabled }));
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No loopback port');
  return `http://127.0.0.1:${address.port}`;
}
const auth = (patch: Record<string, string> = {}) => ({
  response_type: 'code',
  client_id: client.client_id,
  redirect_uri: client.redirect_uris[0],
  code_challenge: challenge,
  code_challenge_method: 'S256',
  scope: 'finance:read',
  state: 'opaque-state',
  resource: OAUTH_RESOURCE,
  ...patch,
});
const exchange = (patch: Record<string, string> = {}) => ({
  grant_type: 'authorization_code',
  client_id: client.client_id,
  code,
  code_verifier: verifier,
  redirect_uri: client.redirect_uris[0],
  resource: OAUTH_RESOURCE,
  ...patch,
});
const post = (url: string, data: Record<string, string>) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data), redirect: 'manual' });

describe('independent financial OAuth protocol with the maintained MCP SDK handlers', () => {
  it('ignores spoofed Forwarded and X-Forwarded-For identities while sharing the socket-IP limiter without diagnostics', async () => {
    const { dispatch } = fixture();
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const base = await listen(dispatch);
      for (let n = 0; n <= 50; n++) {
        const response = await fetch(`${base}/api/oauth/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Forwarded: `for="198.51.100.${n + 1}";proto=https;host=tr8.example`,
            'X-Forwarded-For': `203.0.113.${n + 1}`,
          },
          body: new URLSearchParams(exchange({ client_id: 'unknown-client' })),
        });
        // All requests share the loopback socket IP despite different claimed
        // forwarding identities. The 51st is blocked before client lookup.
        if (n < 50) expect(response.status).not.toBe(429);
        else expect(response.status).toBe(429);
        await response.arrayBuffer();
      }
      expect(dispatch.mock.calls.filter(([action]) => action === 'get_client')).toHaveLength(50);
      expect(diagnostics).not.toHaveBeenCalled();
    } finally {
      diagnostics.mockRestore();
    }
  });

  it('interoperates with the official MCP OAuth client discovery and PKCE code exchange', async () => {
    const { dispatch } = fixture();
    const base = await listen(dispatch);
    let clientVerifier = '',
      authorization: URL | undefined,
      saved: OAuthTokens | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: client.redirect_uris[0],
      clientMetadata: { ...client },
      clientInformation: () => ({ ...client, issuer: OAUTH_ISSUER }),
      tokens: () => saved,
      saveTokens: value => {
        saved = value;
      },
      redirectToAuthorization: value => {
        authorization = value;
      },
      saveCodeVerifier: value => {
        clientVerifier = value;
      },
      codeVerifier: () => clientVerifier,
      state: () => 'sdk-state',
    };
    const fetchFn: typeof fetch = async (input, init) => {
      const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      expect(target.origin).toBe(OAUTH_ISSUER);
      if (target.pathname.startsWith('/.well-known/oauth-protected-resource')) return Response.json(oauthProtectedResourceMetadata());
      if (target.pathname === '/.well-known/oauth-authorization-server') return Response.json(oauthAuthorizationMetadata());
      return fetch(`${base}${target.pathname}${target.search}`, { ...init, redirect: 'manual' });
    };
    expect(await sdkAuth(provider, { serverUrl: OAUTH_RESOURCE, scope: 'finance:read', fetchFn })).toBe('REDIRECT');
    expect(authorization?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization?.searchParams.get('resource')).toBe(OAUTH_RESOURCE);
    const begin = await fetchFn(authorization!.href, { redirect: 'manual' });
    expect(begin.status).toBe(302);
    // A synthetic consent grants the fixed fixture code; no actual user or browser session exists.
    expect(await sdkAuth(provider, { serverUrl: OAUTH_RESOURCE, authorizationCode: code, scope: 'finance:read', fetchFn })).toBe('AUTHORIZED');
    expect(saved).toMatchObject({ access_token: access, refresh_token: refresh, issuer: OAUTH_ISSUER });
    expect(dispatch).toHaveBeenCalledWith('exchange', expect.objectContaining({ code_verifier: clientVerifier, resource: OAUTH_RESOURCE }));
  });
  it('completes authorization-code + atomic S256 verifier, refresh rotation and revocation over loopback HTTP', async () => {
    const { dispatch } = fixture();
    const base = await listen(dispatch);
    const authorization = await fetch(`${base}/api/oauth/authorize?${new URLSearchParams(auth())}`, { redirect: 'manual' });
    expect(authorization.status).toBe(302);
    const location = new URL(authorization.headers.get('location')!);
    expect(location.origin).toBe(OAUTH_ISSUER);
    expect(location.pathname).toBe('/oauth/consent');
    expect([...location.searchParams.keys()]).toEqual(['attempt']);
    expect(location.href).not.toContain('opaque-state');
    expect(dispatch).toHaveBeenCalledWith('begin', expect.objectContaining({ code_challenge: challenge, resource: OAUTH_RESOURCE }));
    const response = await post(`${base}/api/oauth/token`, exchange());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ access_token: access, scope: 'finance:read', expires_in: 900 });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(dispatch).toHaveBeenCalledWith('exchange', expect.objectContaining({ code_verifier: verifier }));
    const principal = await verifyOAuthAccessToken(dispatch, access);
    expect(principal).toMatchObject({ clientId: client.client_id, scopes: ['finance:read'], extra: { grantId: grant } });
    expect(principal.resource?.href).toBe(OAUTH_RESOURCE);
    const rotated = await post(`${base}/api/oauth/token`, {
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: refresh,
      resource: OAUTH_RESOURCE,
    });
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toMatchObject({ access_token: nextAccess, refresh_token: nextRefresh });
    const revoke = await post(`${base}/api/oauth/revoke`, { client_id: client.client_id, token: nextAccess });
    expect(revoke.status).toBe(200);
    await expect(verifyOAuthAccessToken(dispatch, nextAccess)).rejects.toBeInstanceOf(InvalidTokenError);
  });
  it('rejects wrong PKCE without consuming the valid code and then rejects the consumed code', async () => {
    const { dispatch } = fixture();
    const base = await listen(dispatch);
    expect((await post(`${base}/api/oauth/token`, exchange({ code_verifier: 'b'.repeat(43) }))).status).toBe(400);
    expect((await post(`${base}/api/oauth/token`, exchange())).status).toBe(200);
    const replay = await post(`${base}/api/oauth/token`, exchange());
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
  });
  it('revokes the refreshed family when a used refresh token is replayed', async () => {
    const { dispatch } = fixture();
    const base = await listen(dispatch);
    await post(`${base}/api/oauth/token`, exchange());
    const body = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: refresh, resource: OAUTH_RESOURCE };
    expect((await post(`${base}/api/oauth/token`, body)).status).toBe(200);
    expect((await post(`${base}/api/oauth/token`, body)).status).toBe(400);
    await expect(verifyOAuthAccessToken(dispatch, nextAccess)).rejects.toBeInstanceOf(InvalidTokenError);
  });
  it.each<Record<string, string>>([
    { redirect_uri: 'https://attacker.example/callback' },
    { client_id: 'unknown-client' },
    { code_challenge_method: 'plain' },
    { code_challenge: 'short' },
    { resource: 'https://attacker.example/mcp' },
    { scope: 'finance:read admin' },
  ])('never begins authorization for invalid client, redirect, PKCE, scope or resource', async patch => {
    const { dispatch } = fixture();
    const base = await listen(dispatch);
    const response = await fetch(`${base}/api/oauth/authorize?${new URLSearchParams(auth(patch))}`, { redirect: 'manual' });
    expect([400, 302]).toContain(response.status);
    if (response.status === 302) expect(new URL(response.headers.get('location')!).searchParams.has('error')).toBe(true);
    expect(dispatch.mock.calls.some(([action]) => action === 'begin')).toBe(false);
  });
  it('rejects missing PKCE, credential fields, JSON bodies, URL query tokens and duplicate parameters', async () => {
    const { dispatch } = fixture();
    const base = await listen(dispatch);
    const noVerifier: Record<string, string> = exchange();
    delete noVerifier.code_verifier;
    expect((await post(`${base}/api/oauth/token`, noVerifier)).status).toBe(400);
    expect((await post(`${base}/api/oauth/token`, exchange({ client_secret: 'private-synthetic-secret' }))).status).toBe(400);
    expect(
      (await fetch(`${base}/api/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exchange()) })).status,
    ).toBe(415);
    expect((await post(`${base}/api/oauth/token?access_token=${access}`, exchange())).status).toBe(400);
    const doubled = new URLSearchParams(auth());
    doubled.append('client_id', client.client_id);
    expect((await fetch(`${base}/api/oauth/authorize?${doubled}`, { redirect: 'manual' })).status).toBe(400);
    expect(dispatch.mock.calls.some(([action]) => action === 'exchange')).toBe(false);
  });
  it('does not read client configuration or create attempts while disabled by default', async () => {
    const { dispatch } = fixture();
    const base = await listen(dispatch, false);
    const response = await fetch(`${base}/api/oauth/authorize?${new URLSearchParams(auth())}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('does not offer client registration, password grants, or client credentials grants', async () => {
    const { dispatch } = fixture();
    const base = await listen(dispatch);
    expect((await post(`${base}/api/oauth/register`, { client_name: 'Unapproved' })).status).toBe(400);
    const response = await post(`${base}/api/oauth/token`, { grant_type: 'client_credentials', client_id: client.client_id });
    expect(await response.json()).toMatchObject({ error: 'unsupported_grant_type' });
    expect(createOAuthProvider(dispatch).clientsStore.registerClient).toBeUndefined();
  });
});

describe('metadata and opaque resource verification', () => {
  it.each([
    { access_token: 'eyJhbGciOiJIUzI1NiJ9.private-session.signature' },
    { scope: 'admin' },
    { expires_in: 3600 },
    { user_session: 'must-never-be-forwarded' },
  ])('does not forward an excessive or non-financial token response to a client', async patch => {
    const dispatch = vi.fn<OAuthServerDispatch>(async action =>
      action === 'get_client'
        ? client
        : { access_token: access, token_type: 'Bearer', expires_in: 900, refresh_token: refresh, scope: 'finance:read', ...patch },
    );
    const provider = createOAuthProvider(dispatch);
    const registered = (await provider.clientsStore.getClient(client.client_id))!;
    await expect(provider.exchangeAuthorizationCode(registered, code, verifier, client.redirect_uris[0], new URL(OAUTH_RESOURCE))).rejects.toThrow(
      'TR8 no pudo comprobar',
    );
  });
  it('publishes protocol metadata without secrets or dynamic client registration', () => {
    expect(OAuthMetadataSchema.safeParse(oauthAuthorizationMetadata()).success).toBe(true);
    expect(OAuthProtectedResourceMetadataSchema.safeParse(oauthProtectedResourceMetadata()).success).toBe(true);
    expect(oauthAuthorizationMetadata()).not.toHaveProperty('registration_endpoint');
    expect(oauthAuthorizationMetadata().code_challenge_methods_supported).toEqual(['S256']);
    expect(oauthResourceChallenge()).toContain(`resource_metadata="${OAUTH_ISSUER}/.well-known/oauth-protected-resource/api/mcp/finance"`);
    expect(oauthResourceChallenge()).toContain('finance:read');
  });
  it.each(['', 'tr8_mcp_' + 'a'.repeat(64), 'eyJhbGciOiJIUzI1NiJ9.payload.signature', 'tr8_oauth_r_' + 'b'.repeat(64)])(
    'rejects other token types before any backend read',
    async value => {
      const { dispatch } = fixture();
      await expect(verifyOAuthAccessToken(dispatch, value)).rejects.toBeInstanceOf(InvalidTokenError);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { resource: 'https://attacker.example/mcp' },
    { client_id: 'bad client' },
    { scopes: ['finance:write'] },
    { scopes: ['finance:read', 'admin'] },
    { grant_id: 'not-a-grant' },
    { owner_id: 'do-not-forward-private-identity' },
  ])('rejects malformed or excessive verifier response', async patch => {
    const dispatch = vi.fn<OAuthServerDispatch>(async () => ({
      client_id: client.client_id,
      scopes: ['finance:read'],
      expires_at: new Date(Date.now() + 900000).toISOString(),
      resource: OAUTH_RESOURCE,
      grant_id: grant,
      ...patch,
    }));
    await expect(verifyOAuthAccessToken(dispatch, access)).rejects.toThrow('TR8 no pudo comprobar');
  });
  it.each([-1000, 901000])('rejects expired or excessively long-lived verifier results', async delta => {
    const now = Date.now();
    const dispatch = vi.fn<OAuthServerDispatch>(async () => ({
      client_id: client.client_id,
      scopes: ['finance:read'],
      expires_at: new Date(now + delta).toISOString(),
      resource: OAUTH_RESOURCE,
      grant_id: grant,
    }));
    await expect(verifyOAuthAccessToken(dispatch, access, now)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe('OAuth public-key backend boundary', () => {
  it.each(['not a URL with private-config', 'http://qa.supabase.co', 'https://user:private@qa.supabase.co'])(
    'does not expose an invalid backend configuration',
    value => {
      expect(() => createOAuthBackend({ url: value, key: 'public' })).toThrow('TR8 no pudo autorizar');
      expect(() => createOAuthBackend({ url: value, key: 'public' })).not.toThrow(value);
    },
  );
  it('sends only the fixed protocol RPC, without a Supabase user session or admin key', async () => {
    const fetcher = vi.fn(async () => Response.json(null));
    const dispatch = createOAuthBackend({ url: 'https://qa.supabase.co', key: 'public-key', fetch: fetcher });
    await dispatch('get_client', { client_id: client.client_id });
    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://qa.supabase.co/rest/v1/rpc/tr8_mcp_oauth_server'),
      expect.objectContaining({ headers: { apikey: 'public-key', 'Content-Type': 'application/json' }, redirect: 'error', cache: 'no-store' }),
    );
  });
  it.each(['invalid_grant', 'invalid_client', 'invalid_scope', 'too_many_requests'])('returns only fixed safe diagnostics for %s', async code => {
    const dispatch = createOAuthBackend({ url: 'https://qa.supabase.co', key: 'public-key', fetch: async () => Response.json({ _tr8_oauth_error: { code } }) });
    await expect(dispatch('exchange', {})).rejects.toMatchObject({ errorCode: code });
    await expect(dispatch('exchange', {})).rejects.toThrow('TR8 no pudo autorizar');
  });
  it.each([{ _tr8_oauth_error: { code: 'invalid_grant', message: access } }, { _tr8_oauth_error: null }, { _tr8_oauth_error: { code: 400 } }])(
    'fails closed on malformed error envelopes',
    async body => {
      const dispatch = createOAuthBackend({ url: 'https://qa.supabase.co', key: 'public-key', fetch: async () => Response.json(body) });
      await expect(dispatch('exchange', {})).rejects.toMatchObject({ errorCode: 'server_error' });
      await expect(dispatch('exchange', {})).rejects.not.toThrow(access);
    },
  );
  it('sanitizes network and SQL exceptions', async () => {
    const network = createOAuthBackend({
      url: 'https://qa.supabase.co',
      key: 'public',
      fetch: async () => {
        throw Error('Supabase private token ' + access);
      },
    });
    await expect(network('exchange', {})).rejects.toMatchObject({ errorCode: 'temporarily_unavailable' });
    const database = createOAuthBackend({
      url: 'https://qa.supabase.co',
      key: 'public',
      fetch: async () => Response.json({ code: '22023', message: access }, { status: 400 }),
    });
    await expect(database('exchange', {})).rejects.not.toThrow(access);
  });
});
