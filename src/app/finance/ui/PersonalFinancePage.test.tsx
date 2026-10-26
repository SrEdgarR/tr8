import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import PersonalFinancePage from './PersonalFinancePage';
import type { AccountFinanceApi, AccountFinanceWrite } from './account-api';
import type { FinanceApi } from './api';
import { saveCreditCard } from '../domain/credit-card-workspace';
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
    await screen.findByRole('heading', { name: 'Patrimonio por moneda' });
    expect(screen.queryByLabelText('Contraseña privada')).not.toBeInTheDocument();
    expect(h.vault.head).not.toHaveBeenCalled();
    expect(h.account.save).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Bóveda opcional' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Acceso con tu cuenta de TR8/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Seguridad' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abrir bóveda cifrada opcional' }));
    await screen.findByText('En preparación');
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Finanzas' }));
    await screen.findByRole('heading', { name: 'Patrimonio por moneda' });
  });
  it('retries the same financial write after an uncertain response and releases the modal', async () => {
    const h = setup();
    vi.mocked(h.account.save).mockRejectedValueOnce(Error('network'));
    await screen.findByRole('heading', { name: 'Patrimonio por moneda' });
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
    await screen.findByRole('heading', { name: 'Patrimonio por moneda' });
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
    await screen.findByRole('heading', { name: 'Patrimonio por moneda' });
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
  it('edits an existing account and optional bank without changing its identity or ledger', async () => {
    const snapshot = addAccount(emptyFinancialSnapshot(), {
      id: 'bank',
      name: 'Cuenta anterior',
      type: 'debit',
      currency: 'DOP',
      openingBalanceMinor: 12345,
      openingDate: '2026-01-01',
    });
    const h = setup(snapshot);
    await screen.findByRole('heading', { name: 'Cuenta anterior' });
    fireEvent.click(screen.getByRole('button', { name: 'Configurar cuenta Cuenta anterior' }));
    expect(screen.getByLabelText('Nombre de la cuenta')).toHaveValue('Cuenta anterior');
    expect(screen.getByLabelText('Saldo inicial')).toHaveValue('123.45');
    fireEvent.change(screen.getByLabelText('Nombre de la cuenta'), { target: { value: 'Mi ahorro' } });
    fireEvent.change(screen.getByLabelText('Banco (opcional)'), { target: { value: 'Banco ficticio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Mi ahorro' })).toBeInTheDocument();
    expect(screen.getByText('Banco ficticio')).toBeInTheDocument();
    const result = vi.mocked(h.account.save).mock.calls[0][0].snapshot;
    expect(result.financialSpace.accounts[0]).toEqual({ ...snapshot.financialSpace.accounts[0], name: 'Mi ahorro', bankName: 'Banco ficticio' });
    expect(result.financialSpace.operations).toEqual(snapshot.financialSpace.operations);
    expect(screen.getByRole('region', { name: 'Patrimonio por moneda' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Cuentas financieras' })).toBeInTheDocument();
  });
  it('shows a compact card and deletes only its confirmed currency group through account settings', async () => {
    let snapshot = addAccount(emptyFinancialSnapshot(), {
      id: 'bank-safe',
      name: 'Ahorro conservado',
      type: 'debit',
      currency: 'DOP',
      openingBalanceMinor: 100000,
      openingDate: '2026-01-01',
    });
    snapshot = saveCreditCard(snapshot, {
      name: 'Tarjeta de prueba',
      statementDay: 20,
      paymentDay: 2,
      asOfDate: '2026-01-01',
      balances: [
        { currency: 'DOP', creditLimitMinor: 100000, totalDebtMinor: 40000, statementPendingMinor: 30000 },
        { currency: 'USD', creditLimitMinor: 10000, totalDebtMinor: 5000, statementPendingMinor: 2000 },
      ],
    });
    const h = setup(snapshot);
    await screen.findByRole('heading', { name: 'Tarjeta de prueba' });
    expect(screen.queryByRole('heading', { name: 'Panorama financiero' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Saldos a fecha')).not.toBeInTheDocument();
    const toggle = screen.getByLabelText('Ver detalles de Tarjeta de prueba');
    const details = toggle.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getAllByText('Límite')[0]).not.toBeVisible();
    fireEvent.click(toggle);
    expect(details).toHaveAttribute('open');
    expect(within(details).getAllByText('Límite')[0]).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Configurar tarjeta Tarjeta de prueba' }));
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar tarjeta' }));
    const dialog = screen.getByRole('dialog', { name: 'Eliminar cuenta' });
    expect(within(dialog).getByRole('list', { name: 'Saldos que se eliminarán' })).toHaveTextContent('DOP');
    expect(h.account.save).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Tarjeta de prueba' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Eliminar cuenta definitivamente' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Tarjeta de prueba' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ahorro conservado' })).toBeInTheDocument();
    const saved = vi.mocked(h.account.save).mock.calls[0][0].snapshot;
    expect(saved.financialSpace.accounts).toEqual([snapshot.financialSpace.accounts[0]]);
    expect(saved.financialSpace.operations).toEqual(snapshot.financialSpace.operations);
  });
});
