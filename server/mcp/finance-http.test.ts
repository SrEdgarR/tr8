import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleMcpRequest } from './http';
import { createMcpDispatch, McpBackendError, type McpDispatch } from './backend';

const token = `tr8_mcp_${'a'.repeat(64)}`;
const endpoint = 'https://tr8.example/api/mcp';
const context = { workspace: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'personal' }, scopes: ['tasks:read'] };
const notice = {
  request_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  expected_version: '2',
  source: { provider: 'gmail', mailbox_id: 'c'.repeat(64), message_id: 'message_1', bank_transaction_id: 'd'.repeat(64) },
  account_id: 'debit-dop',
  kind: 'purchase',
  status: 'posted',
  amount: '20.20',
  currency: 'DOP',
  occurred_at: '2026-10-29T14:00:00-04:00',
  time_zone: 'America/Santo_Domingo',
  date: '2026-10-29',
  description: 'Comercio ficticio',
  category: 'shopping',
};

async function connect(dispatch: McpDispatch, enabled = false) {
  const client = new Client({ name: 'independent-finance-review-client', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) => handleMcpRequest(new Request(input, init), { dispatch: () => dispatch, financeEnabled: enabled }),
    }),
  );
  return client;
}

describe('financial MCP local review opt-in', () => {
  it('retains the existing 11-tool surface and denies a financial call while disabled', async () => {
    const dispatch = vi.fn<McpDispatch>(async () => context);
    const client = await connect(dispatch);
    try {
      expect((await client.listTools()).tools).toHaveLength(11);
      const result = await client.callTool({ name: 'tr8_submit_finance_notice', arguments: notice });
      expect(result.isError).toBe(true);
      expect(dispatch.mock.calls.every(([action]) => action === 'context')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('publishes six bounded finance tools only with explicit server opt-in', async () => {
    const dispatch = vi.fn(async (action: string) => (action === 'context' ? context : { items: [], next_cursor: null, version: '2' }));
    const client = await connect(dispatch, true);
    try {
      const all = (await client.listTools()).tools;
      expect(all).toHaveLength(17);
      const write = all.find(t => t.name === 'tr8_submit_finance_notice')!;
      expect(write.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(all.filter(t => t.name.includes('finance') && t.name !== write.name).every(t => t.annotations?.readOnlyHint === true)).toBe(true);
      expect(write.inputSchema.required).toEqual(expect.arrayContaining(['request_id', 'expected_version', 'source', 'account_id']));
      const result = await client.callTool({ name: 'tr8_submit_finance_notice', arguments: notice });
      expect(result.isError).not.toBe(true);
      expect(dispatch).toHaveBeenCalledWith('finance_submit_notice', notice);
    } finally {
      await client.close();
    }
  });

  it.each([
    { ...notice, body: 'entire bank email' },
    { ...notice, owner_id: 'someone-else' },
    { ...notice, amount: 20.2 },
    { ...notice, amount: '20.2 + 10' },
    { ...notice, amount: '1e4' },
    { ...notice, amount: '1,200.00' },
    { ...notice, amount: '-20.20' },
    { ...notice, description: 'Tarjeta 4111 1111 1111 1111' },
    { ...notice, source: { ...notice.source, access_token: 'do-not-accept' } },
    { ...notice, source: { ...notice.source, bank_transaction_id: '1234567890123456' } },
  ])('rejects malformed or excess financial data before dispatch', async input => {
    const dispatch = vi.fn<McpDispatch>(async () => context);
    const client = await connect(dispatch, true);
    try {
      expect((await client.callTool({ name: 'tr8_submit_finance_notice', arguments: input })).isError).toBe(true);
      expect(dispatch.mock.calls.every(([action]) => action === 'context')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('does not turn a legacy write credential into financial permission and sanitizes denials', async () => {
    const dispatch = vi.fn(async (action: string) => {
      if (action === 'context') return { ...context, access: 'write' };
      throw new McpBackendError('PT403');
    });
    const client = await connect(dispatch, true);
    try {
      const result = await client.callTool({ name: 'tr8_list_finance_accounts', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('PT403');
      expect(JSON.stringify(result)).not.toContain(token);
    } finally {
      await client.close();
    }
  });
});

describe('financial RPC pinning', () => {
  it('never calls a financial RPC without the feature gate', async () => {
    const fetcher = vi.fn();
    const dispatch = createMcpDispatch(token, { url: 'https://qa.supabase.co', key: 'public', fetch: fetcher });
    await expect(dispatch('finance_submit_notice', notice)).rejects.toMatchObject({ code: 'PT403' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('pins financial actions to their narrow RPC without exposing a browser session', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'review', operation_id: null, version: '2' }));
    const dispatch = createMcpDispatch(token, { url: 'https://qa.supabase.co', key: 'public', fetch: fetcher, financeEnabled: true });
    await dispatch('finance_submit_notice', notice);
    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://qa.supabase.co/rest/v1/rpc/tr8_mcp_finance_dispatch'),
      expect.objectContaining({
        headers: { apikey: 'public', 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_token: token, p_action: 'finance_submit_notice', p_input: notice }),
        redirect: 'error',
        cache: 'no-store',
      }),
    );
    await expect(dispatch('finance_execute_sql', {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('returns a safe input failure without SQL diagnostics or email data', async () => {
    const dispatch = createMcpDispatch(token, {
      url: 'https://qa.supabase.co',
      key: 'public',
      financeEnabled: true,
      fetch: async () => Response.json({ code: 'PT400', message: 'SQL secret', detail: 'email text' }, { status: 400 }),
    });
    await expect(dispatch('finance_submit_notice', notice)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(dispatch('finance_submit_notice', notice)).rejects.not.toThrow('SQL secret');
  });
});
