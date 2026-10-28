import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import PersonalFinancePage from './PersonalFinancePage';
import { addAccount, emptyFinancialSnapshot } from '../domain/workspace';
import { saveCreditCard } from '../domain/credit-card-workspace';
import type { AccountFinanceApi } from './account-api';
import type { FinanceApi } from './api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function setup(withCard = false) {
  let original = addAccount(emptyFinancialSnapshot(), {
    id: 'synthetic-original-account',
    name: 'Cuenta original QA',
    type: 'debit',
    currency: 'DOP',
    openingBalanceMinor: 10000,
    openingDate: '2026-01-01',
  });
  if (withCard)
    original = saveCreditCard(original, {
      name: 'Tarjeta original QA',
      statementDay: 20,
      paymentDay: 2,
      asOfDate: '2026-01-01',
      balances: [
        { currency: 'DOP', creditLimitMinor: 100000, totalDebtMinor: 10000, statementPendingMinor: 5000 },
        { currency: 'USD', creditLimitMinor: 10000, totalDebtMinor: 1000, statementPendingMinor: 200 },
      ],
    });
  const updated = addAccount(original, {
    id: 'synthetic-new-account',
    name: 'Ahorro de otra sesión QA',
    type: 'debit',
    currency: 'DOP',
    openingBalanceMinor: 12345,
    openingDate: '2026-01-01',
  });
  const account: AccountFinanceApi = {
    ownerId: 'synthetic-owner',
    load: vi.fn().mockResolvedValueOnce({ snapshot: original, version: '0', operationId: null }).mockResolvedValue({
      snapshot: updated,
      version: '1',
      operationId: 'synthetic-write',
    }),
    save: vi.fn(),
  };
  const vault = {
    ownerId: 'synthetic-owner',
    enabled: false,
    syntheticOnly: false,
    head: vi.fn(),
    identity: vi.fn(),
    save: vi.fn(),
    reauthenticate: vi.fn(),
    subscribe: () => () => {},
  } satisfies FinanceApi;
  const onRefreshReady = vi.fn();
  render(<PersonalFinancePage accountApi={account} vaultApi={vault} onRefreshReady={onRefreshReady} />);
  await screen.findByRole('heading', { name: 'Disponibilidad por moneda' });
  fireEvent.click(screen.getByRole('button', { name: 'Seguridad' }));
  fireEvent.click(screen.getByText('Restaurar un respaldo JSON'));
  return { account, vault, original, onRefreshReady };
}

it('invalidates a reviewed restore when a refresh loads a newer finance version', async () => {
  const h = await setup();
  const backup = new File([], 'synthetic-backup.json', { type: 'application/json' });
  Object.defineProperty(backup, 'text', { value: async () => JSON.stringify(h.original) });
  fireEvent.change(screen.getByLabelText('Archivo de finanzas JSON'), { target: { files: [backup] } });
  fireEvent.change(await screen.findByLabelText('Escribe REEMPLAZAR'), { target: { value: 'REEMPLAZAR' } });

  act(() => h.onRefreshReady.mock.calls.at(-1)![0]());
  await waitFor(() => expect(h.onRefreshReady.mock.calls.at(-1)![0]).toEqual(expect.any(Function)));

  fireEvent.click(screen.getByRole('button', { name: 'Seguridad' }));
  expect(screen.queryByLabelText('Escribe REEMPLAZAR')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Restaurar finanzas' })).not.toBeInTheDocument();
  expect(h.account.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Resumen' }));
  expect(screen.getByRole('heading', { name: 'Ahorro de otra sesión QA' })).toBeInTheDocument();
  expect(h.vault.head).not.toHaveBeenCalled();
});

it('discards a late backup file read that started before a newer finance version was loaded', async () => {
  const h = await setup();
  const reading = deferred<string>();
  const backup = new File([], 'synthetic-backup.json', { type: 'application/json' });
  Object.defineProperty(backup, 'text', { value: () => reading.promise });
  fireEvent.change(screen.getByLabelText('Archivo de finanzas JSON'), { target: { files: [backup] } });

  act(() => h.onRefreshReady.mock.calls.at(-1)![0]());
  await waitFor(() => expect(h.onRefreshReady.mock.calls.at(-1)![0]).toEqual(expect.any(Function)));
  await act(async () => reading.resolve(JSON.stringify(h.original)));

  fireEvent.click(screen.getByRole('button', { name: 'Seguridad' }));
  expect(screen.queryByLabelText('Escribe REEMPLAZAR')).not.toBeInTheDocument();
  expect(h.account.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Resumen' }));
  expect(screen.getByRole('heading', { name: 'Ahorro de otra sesión QA' })).toBeInTheDocument();
});

it.each([
  { label: 'account', trigger: 'Configurar cuenta Cuenta original QA', title: 'Configurar cuenta' },
  { label: 'card', trigger: 'Configurar tarjeta Tarjeta original QA', title: 'Configurar tarjeta' },
  { label: 'movement', trigger: 'Nuevo movimiento', title: 'Nuevo movimiento' },
])('discards a stale $label draft when a refresh loads another finance version', async ({ label, trigger, title }) => {
  const h = await setup(label === 'card');
  fireEvent.click(screen.getByRole('button', { name: 'Resumen' }));
  fireEvent.click(screen.getByRole('button', { name: trigger }));
  expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();

  act(() => h.onRefreshReady.mock.calls.at(-1)![0]());
  await screen.findByRole('heading', { name: 'Ahorro de otra sesión QA' });

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(h.account.save).not.toHaveBeenCalled();
});

it('preserves a draft when refreshing the same confirmed version', async () => {
  const h = await setup();
  vi.mocked(h.account.load).mockResolvedValue({ snapshot: h.original, version: '0', operationId: null });
  fireEvent.click(screen.getByRole('button', { name: 'Resumen' }));
  fireEvent.click(screen.getByRole('button', { name: 'Nuevo movimiento' }));
  fireEvent.change(screen.getByLabelText('Descripción'), { target: { value: 'Borrador conservado QA' } });

  act(() => h.onRefreshReady.mock.calls.at(-1)![0]());
  await waitFor(() => expect(h.onRefreshReady.mock.calls.at(-1)![0]).toEqual(expect.any(Function)));

  expect(screen.getByRole('dialog', { name: 'Nuevo movimiento' })).toBeInTheDocument();
  expect(screen.getByLabelText('Descripción')).toHaveValue('Borrador conservado QA');
  expect(h.account.save).not.toHaveBeenCalled();
});

it('restores a reviewed backup against its confirmed version without opening the optional vault', async () => {
  const h = await setup();
  vi.mocked(h.account.save).mockImplementation(async write => ({ snapshot: write.snapshot, version: '1', operationId: write.operationId }));
  const backup = new File([], 'synthetic-backup.json', { type: 'application/json' });
  const restored = emptyFinancialSnapshot();
  Object.defineProperty(backup, 'text', { value: async () => JSON.stringify(restored) });
  fireEvent.change(screen.getByLabelText('Archivo de finanzas JSON'), { target: { files: [backup] } });
  fireEvent.change(await screen.findByLabelText('Escribe REEMPLAZAR'), { target: { value: 'REEMPLAZAR' } });
  fireEvent.click(screen.getByRole('button', { name: 'Restaurar finanzas' }));
  await waitFor(() => expect(screen.queryByLabelText('Escribe REEMPLAZAR')).not.toBeInTheDocument());

  expect(h.account.save).toHaveBeenCalledExactlyOnceWith({ snapshot: restored, expectedVersion: '0', operationId: expect.any(String) });
  fireEvent.click(screen.getByRole('button', { name: 'Resumen' }));
  expect(screen.getByRole('heading', { name: 'Empieza con tu primera cuenta' })).toBeInTheDocument();
  expect(h.vault.head).not.toHaveBeenCalled();
  expect(h.vault.save).not.toHaveBeenCalled();
});
