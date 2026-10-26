import { it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { accountFinanceRecord, createAccountFinanceApi } from './account-api';
import { emptyFinancialSnapshot } from '../domain/workspace';
import { createClient } from '@supabase/supabase-js';

it('pins a pending financial save to the verified account even if the active Supabase account changes before fetch', async () => {
  const sent: string[] = [];
  const operation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let active = { access_token: 'synthetic-owner-token', user: { id: 'owner' } };
  const client = createClient('https://example.supabase.co', 'sb_publishable_test', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (_url, init) => {
        sent.push(new Headers(init?.headers).get('Authorization') ?? '');
        return new Response(JSON.stringify({ version: '1', snapshot: emptyFinancialSnapshot(), operationId: operation }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  });
  vi.spyOn(client.auth, 'getSession').mockImplementation(async () => ({ data: { session: active }, error: null }) as never);
  vi.spyOn(client.auth, 'getUser').mockImplementation(async () => {
    const verified = active.user;
    active = { access_token: 'synthetic-other-token', user: { id: 'other' } };
    return { data: { user: verified }, error: null } as never;
  });
  await expect(
    createAccountFinanceApi(client, 'owner').save({ snapshot: emptyFinancialSnapshot(), expectedVersion: '0', operationId: operation }),
  ).rejects.toThrow('sesión cambió');
  expect(sent).toEqual(['Bearer synthetic-owner-token']);
});
it('does not disclose a response after the authenticated account changes', async () => {
  const getUser = vi
    .fn()
    .mockResolvedValueOnce({ data: { user: { id: 'owner' } }, error: null })
    .mockResolvedValueOnce({ data: { user: { id: 'other' } }, error: null });
  const setHeader = vi.fn(async () => ({ data: { version: '0', snapshot: null, operationId: null }, error: null }));
  const rpc = vi.fn(() => ({ setHeader }));
  const getSession = vi.fn(async () => ({ data: { session: { access_token: 'synthetic-owner-token', user: { id: 'owner' } } }, error: null }));
  const api = createAccountFinanceApi({ auth: { getUser, getSession }, rpc } as unknown as SupabaseClient, 'owner');
  await expect(api.load()).rejects.toThrow('sesión cambió');
  expect(rpc).toHaveBeenCalledWith('tr8_account_finance', {});
});
it('rejects malformed financial records and mismatched save acknowledgments', async () => {
  expect(() => accountFinanceRecord({ version: '1', snapshot: emptyFinancialSnapshot(), operationId: null })).toThrow();
  const operation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'owner' } }, error: null })),
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'synthetic-owner-token', user: { id: 'owner' } } }, error: null })),
    },
    rpc: vi.fn(() => ({ setHeader: async () => ({ data: { version: '2', snapshot: emptyFinancialSnapshot(), operationId: operation }, error: null }) })),
  };
  await expect(
    createAccountFinanceApi(client as unknown as SupabaseClient, 'owner').save({
      snapshot: emptyFinancialSnapshot(),
      expectedVersion: '0',
      operationId: operation,
    }),
  ).rejects.toThrow('INVALID_FINANCE_RESPONSE');
});
