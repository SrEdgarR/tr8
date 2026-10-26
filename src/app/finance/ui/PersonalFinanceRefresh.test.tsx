import { render, screen, act, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import PersonalFinancePage from './PersonalFinancePage';
import { emptyFinancialSnapshot } from '../domain/workspace';
import type { AccountFinanceApi, AccountFinanceRecord } from './account-api';
import type { FinanceApi } from './api';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}
it('registers an explicit finance refresh and waits for its own read instead of a projects refresh', async () => {
  const next = deferred<AccountFinanceRecord>();
  const original = { snapshot: emptyFinancialSnapshot(), version: '0', operationId: null };
  const account: AccountFinanceApi = {
    ownerId: 'owner',
    load: vi
      .fn()
      .mockResolvedValueOnce(original)
      .mockImplementationOnce(() => next.promise),
    save: vi.fn(),
  };
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
  const onSyncState = vi.fn(),
    onRefreshReady = vi.fn();
  const view = render(<PersonalFinancePage accountApi={account} vaultApi={vault} onSyncState={onSyncState} onRefreshReady={onRefreshReady} />);
  await screen.findByRole('heading', { name: 'Panorama financiero' });
  const refresh = onRefreshReady.mock.calls.at(-1)![0];
  expect(refresh).toEqual(expect.any(Function));
  act(() => refresh());
  expect(onSyncState).toHaveBeenLastCalledWith('checking');
  await waitFor(() => expect(onRefreshReady).toHaveBeenLastCalledWith(null));
  expect(account.load).toHaveBeenCalledTimes(2);
  await act(async () => next.resolve(original));
  expect(onSyncState).toHaveBeenLastCalledWith('synced');
  expect(onRefreshReady.mock.calls.at(-1)![0]).toEqual(expect.any(Function));
  view.unmount();
  expect(onRefreshReady).toHaveBeenLastCalledWith(null);
});

it('does not confirm a late read after the finance scope is unmounted', async () => {
  const load = deferred<AccountFinanceRecord>();
  const account: AccountFinanceApi = { ownerId: 'owner', load: vi.fn(() => load.promise), save: vi.fn() };
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
  const view = render(<PersonalFinancePage accountApi={account} vaultApi={vault} onSyncState={onSyncState} />);
  view.unmount();
  const calls = onSyncState.mock.calls.length;
  await act(async () => load.resolve({ snapshot: emptyFinancialSnapshot(), version: '0', operationId: null }));
  expect(onSyncState).toHaveBeenCalledTimes(calls);
  expect(onSyncState).not.toHaveBeenCalledWith('synced');
});
