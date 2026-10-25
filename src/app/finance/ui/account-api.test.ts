import { it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { accountFinanceRecord, createAccountFinanceApi } from './account-api';
import { emptyFinancialSnapshot } from '../domain/workspace';
it('does not disclose a response after the authenticated account changes', async () => {
  const getUser = vi
    .fn()
    .mockResolvedValueOnce({ data: { user: { id: 'owner' } }, error: null })
    .mockResolvedValueOnce({ data: { user: { id: 'other' } }, error: null });
  const rpc = vi.fn(async () => ({ data: { version: '0', snapshot: null, operationId: null }, error: null }));
  const api = createAccountFinanceApi({ auth: { getUser }, rpc } as unknown as SupabaseClient, 'owner');
  await expect(api.load()).rejects.toThrow('sesión cambió');
  expect(rpc).toHaveBeenCalledWith('tr8_account_finance', {});
});
it('rejects malformed financial records and mismatched save acknowledgments', async () => {
  expect(() => accountFinanceRecord({ version: '1', snapshot: emptyFinancialSnapshot(), operationId: null })).toThrow();
  const operation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const client = {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'owner' } }, error: null })) },
    rpc: vi.fn(async () => ({ data: { version: '2', snapshot: emptyFinancialSnapshot(), operationId: operation }, error: null })),
  };
  await expect(
    createAccountFinanceApi(client as unknown as SupabaseClient, 'owner').save({
      snapshot: emptyFinancialSnapshot(),
      expectedVersion: '0',
      operationId: operation,
    }),
  ).rejects.toThrow('INVALID_FINANCE_RESPONSE');
});
