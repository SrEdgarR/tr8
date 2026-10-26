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

it.each([
  ['PT401', 'PT401'],
  ['PT403', 'PT403'],
  ['PT404', 'PT404'],
  ['PT409', 'PT409'],
  ['PT429', 'PT429'],
  ['42501', 'PT403'],
  ['22023', 'INVALID_INPUT'],
  ['23514', 'INVALID_INPUT'],
  ['XX000', 'UNAVAILABLE'],
])('recognizes a committed RPC error envelope without exposing its diagnostic: %s', async (code, expected) => {
  const call = createMcpDispatch('secret', {
    url: 'https://example.supabase.co',
    key: 'public-key',
    fetch: async () => Response.json({ _tr8_mcp_error: { code, message: 'private secret' } }),
  });
  await expect(call('context', {})).rejects.toMatchObject({ code: expected });
  await expect(call('context', {})).rejects.not.toThrow('private secret');
});

it.each([
  { _tr8_mcp_error: null },
  { _tr8_mcp_error: 'PT403' },
  { _tr8_mcp_error: { code: 403 } },
  { _tr8_mcp_error: { code: 'PT403', message: { secret: 'private secret' } } },
  { _tr8_mcp_error: { code: 'PT403', details: 'private secret' } },
  { _tr8_mcp_error: { code: 'PT403' }, items: [{ id: 'untrusted' }] },
])('fails closed when an RPC error envelope is malformed', async payload => {
  const call = createMcpDispatch('secret', {
    url: 'https://example.supabase.co',
    key: 'public-key',
    fetch: async () => Response.json(payload),
  });
  await expect(call('list_tasks', {})).rejects.toMatchObject({ code: 'UNAVAILABLE' });
});
