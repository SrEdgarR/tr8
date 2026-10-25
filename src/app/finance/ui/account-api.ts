import type { SupabaseClient } from '@supabase/supabase-js';
import { requireClosedRecord, validateEpoch } from '../compatibility/protocol';
import { validateFinancialSnapshot } from '../domain/snapshot';
import { emptyFinancialSnapshot } from '../domain/workspace';
import type { FinancialSnapshot } from '../domain/workspace-types';
export interface AccountFinanceRecord {
  version: string;
  snapshot: FinancialSnapshot;
  operationId: string | null;
}
export interface AccountFinanceWrite {
  snapshot: FinancialSnapshot;
  expectedVersion: string;
  operationId: string;
}
export interface AccountFinanceApi {
  ownerId: string;
  load(): Promise<AccountFinanceRecord>;
  save(write: AccountFinanceWrite): Promise<AccountFinanceRecord>;
  subscribe?: (invalidate: () => void) => () => void;
}
export function accountFinanceRecord(value: unknown): AccountFinanceRecord {
  const r = requireClosedRecord(value, ['version', 'snapshot', 'operationId']);
  const version = r.version === '0' ? '0' : validateEpoch(r.version);
  if (
    (version === '0') !== (r.snapshot === null) ||
    (version === '0') !== (r.operationId === null) ||
    (r.operationId !== null && (typeof r.operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.operationId)))
  )
    throw Error('INVALID_FINANCE_RESPONSE');
  return {
    version,
    snapshot: r.snapshot === null ? emptyFinancialSnapshot() : validateFinancialSnapshot(r.snapshot),
    operationId: r.operationId as string | null,
  };
}
export function createAccountFinanceApi(client: SupabaseClient, ownerId: string): AccountFinanceApi {
  async function request(write?: AccountFinanceWrite) {
    const identity = await client.auth.getUser();
    if (identity.error || identity.data.user?.id !== ownerId) throw Error('Tu sesión cambió. Vuelve a iniciar sesión.');
    const { data, error } = await client.rpc(
      'tr8_account_finance',
      write ? { p_snapshot: validateFinancialSnapshot(write.snapshot), p_expected_version: write.expectedVersion, p_operation_id: write.operationId } : {},
    );
    if (error) throw error;
    const record = accountFinanceRecord(data);
    const again = await client.auth.getUser();
    if (again.error || again.data.user?.id !== ownerId) throw Error('Tu sesión cambió. Vuelve a iniciar sesión.');
    if (write && (record.operationId !== write.operationId || record.version !== String(BigInt(write.expectedVersion) + 1n)))
      throw Error('INVALID_FINANCE_RESPONSE');
    return record;
  }
  return {
    ownerId,
    load: () => request(),
    save: write => request(write),
    subscribe: invalidate => {
      const {
        data: { subscription },
      } = client.auth.onAuthStateChange((_event, session) => {
        if (!session || session.user.id !== ownerId) invalidate();
      });
      return () => subscription.unsubscribe();
    },
  };
}
