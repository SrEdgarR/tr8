import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it, vi } from 'vitest';
import { createMcpDispatch, McpBackendError } from './backend';
import { handleMcpRequest } from './http';
import { oauthResourceChallenge } from './oauth/router';
import { GET as metadata } from '../../api/oauth-metadata';
import { POST as financeApi } from '../../api/mcp/finance';

const oauth = `tr8_oauth_a_${'a'.repeat(64)}`;
const legacy = `tr8_mcp_${'b'.repeat(64)}`;
const endpoint = 'https://tr8.vercel.app/api/mcp/finance';
const challenge = oauthResourceChallenge();
async function client(access: 'read' | 'write') {
  const dispatch = vi.fn(async (action: string) => (action === 'finance_context' ? { enabled: true, access } : { items: [], next_cursor: null, version: '1' }));
  const value = new Client({ name: 'independent-oauth-finance-client', version: '1' });
  await value.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${oauth}` } },
      fetch: (input, init) => handleMcpRequest(new Request(input, init), { dispatch: () => dispatch, oauthFinance: { challenge }, financeEnabled: true }),
    }),
  );
  return { value, dispatch };
}
describe('independent financial OAuth resource', () => {
  it.each([legacy, 'eyJhbGciOiJIUzI1NiJ9.example.signature', '', `tr8_oauth_r_${'a'.repeat(64)}`])(
    'rejects PATs, browser JWTs, refresh tokens and missing credentials before data access',
    async token => {
      const dispatch = vi.fn();
      const response = await handleMcpRequest(new Request(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' }), {
        dispatch,
        oauthFinance: { challenge },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(challenge);
      expect(dispatch).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain(token || 'any secret');
    },
  );
  it('publishes only the six financial tools and denies project operations', async () => {
    const h = await client('write');
    try {
      const tools = (await h.value.listTools()).tools;
      expect(tools).toHaveLength(6);
      expect(tools.every(t => t.name.includes('finance'))).toBe(true);
      expect((await h.value.callTool({ name: 'tr8_list_projects', arguments: {} })).isError).toBe(true);
      expect(h.dispatch.mock.calls.every(([action]) => action.startsWith('finance_'))).toBe(true);
    } finally {
      await h.value.close();
    }
  });
  it('limits a read-only OAuth token to five read tools', async () => {
    const h = await client('read');
    try {
      const tools = (await h.value.listTools()).tools;
      expect(tools).toHaveLength(5);
      expect(tools.every(t => t.annotations?.readOnlyHint === true)).toBe(true);
      expect(tools.some(t => t.name === 'tr8_submit_finance_notice')).toBe(false);
    } finally {
      await h.value.close();
    }
  });
  it('does not accept query-string tokens, including with a valid header', async () => {
    const dispatch = vi.fn();
    const response = await handleMcpRequest(new Request(`${endpoint}?access_token=${oauth}`, { headers: { Authorization: `Bearer ${oauth}` } }), {
      dispatch,
      oauthFinance: { challenge },
    });
    expect(response.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('checks revocation before every request and does not leak SQL diagnostics', async () => {
    const dispatch = vi.fn(async () => {
      throw new McpBackendError('PT401');
    });
    const response = await handleMcpRequest(new Request(endpoint, { headers: { Authorization: `Bearer ${oauth}` } }), {
      dispatch: () => dispatch,
      oauthFinance: { challenge },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(challenge);
    expect(await response.text()).not.toContain(oauth);
  });
  it('pins opaque OAuth tokens to the financial-only database bridge', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ enabled: true, access: 'read' }));
    const dispatch = createMcpDispatch(oauth, { url: 'https://qa.supabase.co', key: 'public', financeEnabled: true, oauthFinance: true, fetch: fetcher });
    await dispatch('finance_context', {});
    expect(fetcher.mock.calls[0]![0]).toEqual(new URL('https://qa.supabase.co/rest/v1/rpc/tr8_mcp_oauth_finance_dispatch'));
    await expect(dispatch('context', {})).rejects.toMatchObject({ code: 'PT403' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('leaves discovery and resource unavailable by default without calling a service', async () => {
    vi.stubEnv('TR8_MCP_OAUTH_REVIEW_ENABLED', 'false');
    vi.stubEnv('TR8_MCP_FINANCE_REVIEW_ENABLED', 'false');
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      expect(metadata(new Request('https://tr8.vercel.app/api/oauth-metadata?document=resource')).status).toBe(404);
      expect((await financeApi(new Request(endpoint, { method: 'POST' }))).status).toBe(503);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
      vi.unstubAllEnvs();
    }
  });
  it('advertises resource binding and PKCE without exposing provider credentials', async () => {
    vi.stubEnv('TR8_MCP_OAUTH_REVIEW_ENABLED', 'true');
    vi.stubEnv('TR8_MCP_FINANCE_REVIEW_ENABLED', 'true');
    try {
      const result = metadata(new Request('https://tr8.vercel.app/api/oauth-metadata?document=authorization'));
      expect(await result.json()).toMatchObject({
        issuer: 'https://tr8.vercel.app',
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      const prm = await metadata(new Request('https://tr8.vercel.app/api/oauth-metadata?document=resource')).json();
      expect(prm).toMatchObject({ resource: endpoint, bearer_methods_supported: ['header'] });
      expect(JSON.stringify(prm)).not.toMatch(/supabase|secret|client_secret/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
