import { expect, it, vi } from 'vitest';
import { createMcpDispatch } from './backend';

it('sends the delegated token only to the pinned Supabase RPC using a public API key', async () => {
  const fetcher = vi.fn(async () => Response.json({ items: [], next_cursor: null }));
  const call = createMcpDispatch('tr8_mcp_secret', { url: 'https://example.supabase.co', key: 'public-key', fetch: fetcher });
  await expect(call('list_tasks', { limit: 5 })).resolves.toEqual({ items: [], next_cursor: null });
  expect(fetcher).toHaveBeenCalledWith(
    new URL('https://example.supabase.co/rest/v1/rpc/tr8_mcp_dispatch'),
    expect.objectContaining({
      redirect: 'error',
      body: JSON.stringify({ p_token: 'tr8_mcp_secret', p_action: 'list_tasks', p_input: { limit: 5 } }),
      headers: { apikey: 'public-key', 'Content-Type': 'application/json' },
    }),
  );
});
it.each(['PT401', 'PT403', 'PT404', 'PT409', 'PT429'])('preserves only the public error code %s', async code => {
  const call = createMcpDispatch('secret', {
    url: 'https://example.supabase.co',
    key: 'public-key',
    fetch: async () => Response.json({ code, message: 'private SQL', hint: 'secret' }, { status: 400 }),
  });
  await expect(call('context', {})).rejects.toMatchObject({ code });
  await expect(call('context', {})).rejects.not.toThrow('private SQL');
});
it('sanitizes network errors and database details', async () => {
  const call = createMcpDispatch('secret', {
    url: 'https://example.supabase.co',
    key: 'public-key',
    fetch: async () => {
      throw Error('private secret');
    },
  });
  await expect(call('context', {})).rejects.not.toThrow('private secret');
});
