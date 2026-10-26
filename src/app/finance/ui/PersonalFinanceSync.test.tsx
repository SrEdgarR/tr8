import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import PersonalFinancePage from './PersonalFinancePage';
import { emptyFinancialSnapshot } from '../domain/workspace';
import type { AccountFinanceApi, AccountFinanceRecord, AccountFinanceWrite } from './account-api';
import type { FinanceApi } from './api';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}
it('reports confirmed normal finance reads and keeps uncertain writes pending until the exact retry is acknowledged', async () => {
  const load = deferred<AccountFinanceRecord>();
  const account: AccountFinanceApi = {
    ownerId: 'owner',
    load: vi.fn(() => load.promise),
    save: vi.fn(async (write: AccountFinanceWrite) => ({ snapshot: write.snapshot, version: '1', operationId: write.operationId })),
  };
  vi.mocked(account.save).mockRejectedValueOnce(Error('Network response unknown'));
  const vault = {
    ownerId: 'owner',
    enabled: false,
    syntheticOnly: false,
    head: vi.fn(),
    identity: vi.fn(),
    save: vi.fn(),
    reauthenticate: vi.fn(),
    subscribe: () => () => {},
  } satisfies FinanceApi;
  const onSyncState = vi.fn();
  render(<PersonalFinancePage accountApi={account} vaultApi={vault} onSyncState={onSyncState} />);
  expect(onSyncState).toHaveBeenLastCalledWith('checking');
  await act(async () => load.resolve({ snapshot: emptyFinancialSnapshot(), version: '0', operationId: null }));
  expect(onSyncState).toHaveBeenLastCalledWith('synced');
  fireEvent.click(screen.getByRole('button', { name: 'Nueva cuenta' }));
  fireEvent.change(screen.getByLabelText('Nombre de la cuenta'), { target: { value: 'Cuenta QA' } });
  fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
  await screen.findByRole('heading', { name: 'Guardado por comprobar' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(onSyncState).toHaveBeenLastCalledWith('pending');
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar guardado' }));
  await screen.findByRole('heading', { name: 'Cuenta QA' });
  expect(onSyncState.mock.calls.map(([state]) => state)).toEqual(['checking', 'synced', 'saving', 'pending', 'saving', 'synced']);
  expect(vi.mocked(account.save).mock.calls[1][0]).toEqual(vi.mocked(account.save).mock.calls[0][0]);
});
