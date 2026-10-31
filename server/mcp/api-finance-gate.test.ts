import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { POST } from '../../api/mcp';

const endpoint = 'https://tr8.vercel.app/api/mcp';
const token = `tr8_mcp_${'a'.repeat(64)}`;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function connect(legacyGate: string | undefined) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://synthetic-db.invalid');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'synthetic-public-key');
  vi.stubEnv('TR8_MCP_FINANCE_REVIEW_ENABLED', 'true');
  vi.stubEnv('TR8_MCP_OAUTH_REVIEW_ENABLED', 'true');
  vi.stubEnv('TR8_MCP_LEGACY_FINANCE_ENABLED', legacyGate);
  const database = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json(body.p_action === 'context' ? { workspace: { id: 'synthetic', kind: 'personal' }, access: 'read' } : { items: [] });
  });
  const client = new Client({ name: 'synthetic-legacy-rollout-client', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: (input, init) => POST(new Request(input, init)),
    }),
  );
  return { client, database };
}

describe('production legacy financial catalog gate', () => {
  it.each([undefined, 'false'])('keeps eleven PAT tools when OAuth finance is enabled but legacy gate is %s', async gate => {
    const h = await connect(gate);
    try {
      const tools = (await h.client.listTools()).tools;
      expect(tools).toHaveLength(11);
      expect(tools.every(tool => !tool.name.includes('finance'))).toBe(true);
      expect((await h.client.callTool({ name: 'tr8_list_finance_accounts', arguments: {} })).isError).toBe(true);
      expect(h.database.mock.calls.every(([, init]) => JSON.parse(String(init?.body)).p_action === 'context')).toBe(true);
    } finally {
      await h.client.close();
    }
  });

  it('adds financial PAT tools only when their separate legacy gate is explicitly true', async () => {
    const h = await connect('true');
    try {
      const tools = (await h.client.listTools()).tools;
      expect(tools).toHaveLength(17);
      expect(tools.filter(tool => tool.name.includes('finance'))).toHaveLength(6);
    } finally {
      await h.client.close();
    }
  });
});
