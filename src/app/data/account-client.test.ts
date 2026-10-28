import type { SupabaseClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { createAccountDataClient } from './account-client';

it.each(['rpc', 'table', 'function', 'storage'])('binds %s requests to the verified owner and blocks later requests after an account change', async kind => {
  let session = { access_token: 'synthetic-owner-token', user: { id: 'owner' } };
  const getSession = vi.fn(async () => ({ data: { session }, error: null }));
  const getUser = vi.fn(async (token: string) => {
    expect(token).toBe('synthetic-owner-token');
    session = { access_token: 'synthetic-other-token', user: { id: 'other' } };
    return { data: { user: { id: 'owner' } }, error: null };
  });
  const transport = vi.fn(async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }));
  const data = createAccountDataClient(
    { auth: { getSession, getUser } } as unknown as SupabaseClient,
    'owner',
    { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_fixture' },
    transport,
  );
  const request = () => {
    if (kind === 'rpc') return data.rpc('synthetic_function', {});
    if (kind === 'table') return data.from('synthetic_table').select('*');
    if (kind === 'storage') return data.storage.from('synthetic-bucket').download('synthetic-file');
    return data.functions.invoke('synthetic_function', { body: {} });
  };
  const first = await request();
  expect(first.error).toBeNull();
  expect(transport).toHaveBeenCalledOnce();
  const [, init] = transport.mock.calls[0] as unknown as Parameters<typeof fetch>;
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-owner-token');
  const second = await request();
  expect(second.error).toBeTruthy();
  expect(transport).toHaveBeenCalledOnce();
  expect(getUser).toHaveBeenCalledOnce();
});
