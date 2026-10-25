import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import PersonalFinancePage from './PersonalFinancePage';
import type { AccountFinanceApi, AccountFinanceWrite } from './account-api';
import type { FinanceApi } from './api';
import { addAccount, emptyFinancialSnapshot } from '../domain/workspace';
function setup(snapshot = emptyFinancialSnapshot()) {
  const account: AccountFinanceApi = {
    ownerId: 'owner',
    load: vi.fn(async () => ({ snapshot, version: '0', operationId: null })),
    save: vi.fn(async (w: AccountFinanceWrite) => ({ snapshot: w.snapshot, version: '1', operationId: w.operationId })),
  };
  const vault: FinanceApi = {
    ownerId: 'owner',
    enabled: false,
    syntheticOnly: false,
    head: vi.fn(),
    identity: vi.fn(),
    save: vi.fn(),
    reauthenticate: vi.fn(),
    subscribe: () => () => {},
  };
  const view = render(<PersonalFinancePage accountApi={account} vaultApi={vault} />);
  return { account, vault, view };
}
describe('account finances by default', () => {
  it('opens the dashboard without asking for or contacting the encrypted vault', async () => {
    const h = setup();
    await screen.findByRole('heading', { name: 'Panorama financiero' });
    expect(screen.queryByLabelText('Contraseña privada')).not.toBeInTheDocument();
    expect(h.vault.head).not.toHaveBeenCalled();
    expect(h.account.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Bóveda opcional' }));
    await screen.findByText('En preparación');
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Finanzas' }));
    await screen.findByRole('heading', { name: 'Panorama financiero' });
  });
  it('retries the same financial write after an uncertain response and releases the modal', async () => {
    const h = setup();
    vi.mocked(h.account.save).mockRejectedValueOnce(Error('network'));
    await screen.findByRole('heading', { name: 'Panorama financiero' });
    fireEvent.click(screen.getByRole('button', { name: 'Nueva cuenta' }));
    expect(screen.getByLabelText('Moneda de la cuenta')).toHaveValue('DOP');
    fireEvent.change(screen.getByLabelText('Nombre de la cuenta'), { target: { value: 'Cuenta ficticia' } });
    fireEvent.change(screen.getByLabelText('Saldo inicial'), { target: { value: '100,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await screen.findByRole('heading', { name: 'Guardado por comprobar' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar guardado' }));
    await screen.findByRole('heading', { name: 'Cuenta ficticia' });
    const calls = vi.mocked(h.account.save).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toEqual(calls[0][0]);
    expect(h.vault.save).not.toHaveBeenCalled();
  });
  it('creates DOP accounts, records income and expense, and preserves the total through a transfer and reload', async () => {
    const h = setup();
    await screen.findByRole('heading', { name: 'Panorama financiero' });
    async function save() {
      fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }
    for (const [name, balance] of [
      ['Efectivo QA', '1000,50'],
      ['Banco QA', '200'],
    ]) {
      fireEvent.click(screen.getByRole('button', { name: 'Nueva cuenta' }));
      expect(screen.getByLabelText('Moneda de la cuenta')).toHaveValue('DOP');
      fireEvent.change(screen.getByLabelText('Nombre de la cuenta'), { target: { value: name } });
      fireEvent.change(screen.getByLabelText('Saldo inicial'), { target: { value: balance } });
      await save();
    }
    for (const [kind, description, amount] of [
      ['income', 'Ingreso QA', '500,25'],
      ['expense', 'Gasto QA', '125.10'],
      ['transfer', 'Transferencia QA', '300,05'],
    ]) {
      fireEvent.click(screen.getByRole('button', { name: 'Nuevo movimiento' }));
      fireEvent.change(screen.getByLabelText('Tipo de movimiento'), { target: { value: kind } });
      fireEvent.change(screen.getByLabelText('Descripción'), { target: { value: description } });
      fireEvent.change(screen.getByLabelText('Importe · DOP'), { target: { value: amount } });
      if (kind === 'income') expect(screen.getByLabelText('Cuenta de destino')).toBeInTheDocument();
      if (kind === 'transfer') {
        const snapshot = vi.mocked(h.account.save).mock.calls.at(-1)![0].snapshot;
        fireEvent.change(screen.getByLabelText('Cuenta de destino'), { target: { value: snapshot.financialSpace.accounts[1].id } });
      }
      await save();
    }
    const saved = vi.mocked(h.account.save).mock.calls.at(-1)![0];
    expect(saved.snapshot.financialSpace.accounts.map(a => a.currency)).toEqual(['DOP', 'DOP']);
    expect(saved.snapshot.financialSpace.operations.map(o => o.amountMinor)).toEqual([50025, 12510, 30005]);
    expect(h.account.save).toHaveBeenCalledTimes(5);
    vi.mocked(h.account.load).mockResolvedValue({ snapshot: saved.snapshot, version: '5', operationId: saved.operationId });
    h.view.unmount();
    render(<PersonalFinancePage accountApi={h.account} vaultApi={h.vault} />);
    const cash = await screen.findByRole('heading', { name: 'Efectivo QA' });
    expect(within(cash.closest('article')!).getByText('DOP 1.075,60')).toBeInTheDocument();
    expect(within(screen.getByRole('heading', { name: 'Banco QA' }).closest('article')!).getByText('DOP 500,05')).toBeInTheDocument();
    expect(screen.getAllByText('DOP 1.575,65')).toHaveLength(2);
    expect(h.vault.head).not.toHaveBeenCalled();
    expect(h.vault.save).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Contraseña privada')).not.toBeInTheDocument();
  });
  it('excludes credit origins and incompatible destinations and resets the destination when the source changes', async () => {
    let snapshot = emptyFinancialSnapshot();
    for (const [id, type, currency] of [
      ['card', 'credit', 'DOP'],
      ['cash', 'cash', 'DOP'],
      ['bank', 'debit', 'DOP'],
      ['usd', 'cash', 'USD'],
    ]) {
      snapshot = addAccount(snapshot, {
        id,
        name: id,
        type,
        currency,
        openingBalanceMinor: 0,
        openingDate: '2026-01-01',
        ...(type === 'credit' ? { creditLimitMinor: 10000 } : {}),
      });
    }
    setup(snapshot);
    await screen.findByRole('heading', { name: 'Panorama financiero' });
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo movimiento' }));
    fireEvent.change(screen.getByLabelText('Tipo de movimiento'), { target: { value: 'transfer' } });
    const origin = screen.getByLabelText('Cuenta de origen');
    expect(origin).toHaveValue('cash');
    expect(within(origin).queryByRole('option', { name: /card/ })).not.toBeInTheDocument();
    const destination = screen.getByLabelText('Cuenta de destino');
    expect(
      within(destination)
        .getAllByRole('option')
        .map(o => o.getAttribute('value')),
    ).toEqual(['', 'bank']);
    fireEvent.change(destination, { target: { value: 'bank' } });
    fireEvent.change(origin, { target: { value: 'bank' } });
    expect(screen.getByLabelText('Cuenta de destino')).toHaveValue('');
    expect(within(screen.getByLabelText('Cuenta de destino')).queryByRole('option', { name: 'bank' })).not.toBeInTheDocument();
  });
});
