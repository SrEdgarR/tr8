import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FinancialDashboard } from './FinancePage';
import PersonalFinancePage from './PersonalFinancePage';
import type { AccountFinanceApi, AccountFinanceRecord, AccountFinanceWrite } from './account-api';
import type { FinanceApi } from './api';
import { addAccount, addEntry, emptyFinancialSnapshot } from '../domain/workspace';
import { addPairedOperation } from '../domain/connected-operations';
import { calculateFinancialBalances } from '../domain/balances';
import { creditCardCycleStatus } from '../domain/credit-cards';
import { saveCreditCard } from '../domain/credit-card-workspace';
import type { FinancialSnapshot } from '../domain/workspace-types';

const paymentDate = '2026-10-30';
const description = 'Pago del corte en dólares desde ahorro en pesos';

function fixture() {
  let snapshot = emptyFinancialSnapshot();
  for (const [id, name, balance] of [
    ['savings', 'Ahorro DOP', 1000000],
    ['cash', 'Efectivo conservado', 20000],
  ] as const)
    snapshot = addAccount(snapshot, { id, name, type: 'debit', currency: 'DOP', openingBalanceMinor: balance, openingDate: '2026-01-01' });
  snapshot = addEntry(snapshot, {
    id: 'unrelated-expense',
    kind: 'expense',
    accountId: 'cash',
    amountMinor: 1000,
    date: '2026-10-25',
    description: 'Gasto conservado',
    category: 'food',
    note: 'No pertenece al pago de tarjeta',
  });
  return saveCreditCard(snapshot, {
    id: 'dual-card',
    name: 'Tarjeta QA',
    statementDay: 20,
    paymentDay: 2,
    asOfDate: '2026-10-26',
    balances: [
      { currency: 'DOP', creditLimitMinor: 1000000, totalDebtMinor: 100000, statementPendingMinor: 50000 },
      { currency: 'USD', creditLimitMinor: 100000, totalDebtMinor: 30000, statementPendingMinor: 20000 },
    ],
  });
}

function card(snapshot: FinancialSnapshot, currency: string) {
  const account = snapshot.financialSpace.accounts.find(account => account.type === 'credit' && account.currency === currency);
  if (!account || account.type !== 'credit' || !account.creditCard) throw Error('Missing fixture card');
  return { ...account, creditCard: account.creditCard };
}

function amounts(snapshot: FinancialSnapshot) {
  const space = snapshot.financialSpace;
  const balances = calculateFinancialBalances(space.accounts, space.operations, paymentDate, space.currencyDefinitions);
  return {
    savings: balances.accounts.find(account => account.accountId === 'savings')!.balanceMinor,
    cash: balances.accounts.find(account => account.accountId === 'cash')!.balanceMinor,
    dopCard: balances.accounts.find(account => account.accountId === card(snapshot, 'DOP').id)!.balanceMinor,
    usdCard: balances.accounts.find(account => account.accountId === card(snapshot, 'USD').id)!.balanceMinor,
    usdCycle: creditCardCycleStatus(card(snapshot, 'USD'), space.operations, paymentDate),
  };
}

function mountDashboard(initial: FinancialSnapshot) {
  const save = vi.fn();
  function Fixture() {
    const [snapshot, setSnapshot] = useState(initial);
    return (
      <FinancialDashboard
        snapshot={snapshot}
        finance={{
          busy: false,
          save: async next => {
            save(next);
            setSnapshot(next);
          },
        }}
        security={null}
      />
    );
  }
  render(<Fixture />);
  return save;
}

function fillPayment(snapshot: FinancialSnapshot) {
  fireEvent.click(screen.getByRole('button', { name: 'Nuevo movimiento' }));
  const dialog = screen.getByRole('dialog', { name: 'Nuevo movimiento' });
  const form = within(dialog);
  fireEvent.change(form.getByLabelText('Tipo de movimiento'), { target: { value: 'card-payment' } });
  fireEvent.change(form.getByLabelText('Cuenta de origen'), { target: { value: 'savings' } });
  expect(within(form.getByLabelText('Cuenta de destino')).getByRole('option', { name: /Tarjeta QA.*USD/ })).toBeInTheDocument();
  fireEvent.change(form.getByLabelText('Cuenta de destino'), { target: { value: card(snapshot, 'USD').id } });
  fireEvent.change(form.getByLabelText('Descripción'), { target: { value: description } });
  fireEvent.change(form.getByLabelText('Fecha del movimiento'), { target: { value: paymentDate } });
  return { dialog, form };
}

function paidSnapshot() {
  const snapshot = fixture();
  return addPairedOperation(snapshot, {
    id: 'fx-payment',
    kind: 'card-payment',
    fromAccountId: 'savings',
    toAccountId: card(snapshot, 'USD').id,
    amountMinor: 600000,
    destinationCurrency: 'USD',
    destinationAmountMinor: 10000,
    date: paymentDate,
    description,
    note: 'Importes confirmados por el banco',
  });
}

describe('pago de tarjeta en otra moneda', () => {
  it('guarda un único pago con ambos importes, reintenta la misma escritura y conserva el corte y las demás cuentas al recargar', async () => {
    const original = fixture();
    let current: AccountFinanceRecord = { snapshot: original, version: '7', operationId: null };
    const accountApi: AccountFinanceApi = {
      ownerId: 'owner',
      load: vi.fn(async () => current),
      save: vi.fn(async (write: AccountFinanceWrite) => {
        current = { snapshot: write.snapshot, version: '8', operationId: write.operationId };
        return current;
      }),
    };
    const vaultApi: FinanceApi = {
      ownerId: 'owner',
      enabled: false,
      syntheticOnly: false,
      head: vi.fn(),
      identity: vi.fn(),
      save: vi.fn(),
      reauthenticate: vi.fn(),
      subscribe: () => () => {},
    };
    vi.mocked(accountApi.save).mockRejectedValueOnce(Error('NETWORK_UNCERTAIN'));
    const view = render(<PersonalFinancePage accountApi={accountApi} vaultApi={vaultApi} />);
    await screen.findByRole('heading', { name: 'Disponibilidad por moneda' });
    const { form } = fillPayment(original);
    fireEvent.change(form.getByLabelText('Importe debitado · DOP'), { target: { value: '6000,00' } });
    fireEvent.change(form.getByLabelText('Abono a la tarjeta · USD'), { target: { value: '100.00' } });
    fireEvent.click(form.getByRole('button', { name: 'Guardar' }));
    await screen.findByRole('heading', { name: 'Guardado por comprobar' });
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar guardado' }));
    await waitFor(() => expect(accountApi.save).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(accountApi.save).mock.calls;
    expect(calls[1][0]).toEqual(calls[0][0]);
    expect(calls[0][0].expectedVersion).toBe('7');
    expect(current.snapshot.financialSpace.operations).toHaveLength(2);
    expect(current.snapshot.financialSpace.operations[0]).toEqual(original.financialSpace.operations[0]);
    expect(current.snapshot.financialSpace.operations[1]).toMatchObject({
      kind: 'card-payment',
      currency: 'DOP',
      amountMinor: 600000,
      destinationCurrency: 'USD',
      destinationAmountMinor: 10000,
      toAccountId: card(original, 'USD').id,
    });
    expect(amounts(current.snapshot)).toMatchObject({
      savings: 400000,
      cash: 19000,
      dopCard: 100000,
      usdCard: 20000,
      usdCycle: { statementPendingMinor: 10000, unbilledDebtMinor: 10000 },
    });
    view.unmount();
    render(<PersonalFinancePage accountApi={accountApi} vaultApi={vaultApi} />);
    await screen.findByRole('heading', { name: 'Disponibilidad por moneda' });
    fireEvent.click(screen.getByRole('button', { name: 'Movimientos' }));
    expect(screen.getByRole('button', { name: `Editar movimiento ${description}` })).toBeInTheDocument();
    expect(screen.queryByLabelText('Contraseña privada')).not.toBeInTheDocument();
    expect(vaultApi.head).not.toHaveBeenCalled();
    expect(vaultApi.save).not.toHaveBeenCalled();
  });

  it('exige ambos importes y rechaza decimales incompatibles sin guardar ni cambiar otras operaciones', () => {
    const original = fixture();
    const save = mountDashboard(original);
    const { dialog, form } = fillPayment(original);
    const debit = form.getByLabelText('Importe debitado · DOP');
    const credit = form.getByLabelText('Abono a la tarjeta · USD');
    expect(debit).toBeRequired();
    expect(credit).toBeRequired();
    fireEvent.change(debit, { target: { value: '6000' } });
    fireEvent.click(form.getByRole('button', { name: 'Guardar' }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(credit, { target: { value: '100.001' } });
    fireEvent.submit(dialog.querySelector('form')!);
    expect(form.getByRole('alert')).toHaveTextContent('2 decimales');
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(credit, { target: { value: '0' } });
    fireEvent.submit(dialog.querySelector('form')!);
    expect(form.getByRole('alert')).toHaveTextContent('mayor que cero');
    expect(save).not.toHaveBeenCalled();
    expect(original.financialSpace.operations).toHaveLength(1);
  });

  it('edita los dos importes sin duplicar el pago y su eliminación confirmada revierte ambas monedas', async () => {
    const original = paidSnapshot();
    const save = mountDashboard(original);
    fireEvent.click(screen.getByRole('button', { name: 'Movimientos' }));
    fireEvent.click(screen.getByRole('button', { name: `Editar movimiento ${description}` }));
    const form = within(screen.getByRole('dialog', { name: 'Editar movimiento' }));
    expect(form.getByLabelText('Importe debitado · DOP')).toHaveValue('6000.00');
    expect(form.getByLabelText('Abono a la tarjeta · USD')).toHaveValue('100.00');
    fireEvent.change(form.getByLabelText('Importe debitado · DOP'), { target: { value: '9000,00' } });
    fireEvent.change(form.getByLabelText('Abono a la tarjeta · USD'), { target: { value: '150.00' } });
    fireEvent.click(form.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(save).toHaveBeenCalledTimes(1);
    const changed = save.mock.calls[0][0] as FinancialSnapshot;
    expect(changed.financialSpace.operations).toHaveLength(2);
    expect(changed.financialSpace.operations[1]).toMatchObject({ id: 'fx-payment', amountMinor: 900000, destinationAmountMinor: 15000 });
    expect(amounts(changed)).toMatchObject({
      savings: 100000,
      cash: 19000,
      dopCard: 100000,
      usdCard: 15000,
      usdCycle: { statementPendingMinor: 5000, unbilledDebtMinor: 10000 },
    });
    fireEvent.click(screen.getByRole('button', { name: `Eliminar movimiento ${description}` }));
    expect(screen.getByRole('button', { name: 'Eliminar movimiento definitivamente' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Escribe ELIMINAR para confirmar'), { target: { value: 'ELIMINAR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar movimiento definitivamente' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(save).toHaveBeenCalledTimes(2);
    const removed = save.mock.calls[1][0] as FinancialSnapshot;
    expect(removed.financialSpace.operations).toEqual([original.financialSpace.operations[0]]);
    expect(amounts(removed)).toMatchObject({
      savings: 1000000,
      cash: 19000,
      dopCard: 100000,
      usdCard: 30000,
      usdCycle: { statementPendingMinor: 20000, unbilledDebtMinor: 10000 },
    });
  });

  it('muestra el pago al filtrar por dólares, aunque el débito de origen sea en pesos', () => {
    mountDashboard(paidSnapshot());
    fireEvent.click(screen.getByRole('button', { name: 'Movimientos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Filtrar movimientos' }));
    fireEvent.change(screen.getByLabelText('Moneda'), { target: { value: 'USD' } });
    expect(screen.getByRole('button', { name: `Editar movimiento ${description}` })).toBeInTheDocument();
    expect(screen.queryByText('Gasto conservado')).not.toBeInTheDocument();
  });

  it('protege ambos importes si el pago ya está incluido en un corte capturado, pero permite corregir su texto', async () => {
    const paid = paidSnapshot();
    const original = saveCreditCard(paid, {
      id: 'dual-card',
      name: 'Tarjeta QA',
      statementDay: 20,
      paymentDay: 2,
      asOfDate: paymentDate,
      balances: [
        { accountId: card(paid, 'DOP').id, currency: 'DOP', creditLimitMinor: 1000000, statementPendingMinor: 50000 },
        { accountId: card(paid, 'USD').id, currency: 'USD', creditLimitMinor: 100000, statementPendingMinor: 10000 },
      ],
    });
    const save = mountDashboard(original);
    fireEvent.click(screen.getByRole('button', { name: 'Movimientos' }));
    fireEvent.click(screen.getByRole('button', { name: `Editar movimiento ${description}` }));
    const form = within(screen.getByRole('dialog', { name: 'Editar movimiento' }));
    expect(form.getByLabelText('Importe debitado · DOP')).toBeDisabled();
    expect(form.getByLabelText('Abono a la tarjeta · USD')).toBeDisabled();
    expect(form.getByLabelText('Fecha del movimiento')).toBeDisabled();
    fireEvent.change(form.getByLabelText('Descripción'), { target: { value: 'Referencia bancaria corregida' } });
    fireEvent.click(form.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const changed = save.mock.calls[0][0] as FinancialSnapshot;
    expect(changed.financialSpace.operations[1]).toEqual({ ...original.financialSpace.operations[1], description: 'Referencia bancaria corregida' });
    expect(changed.financialSpace.accounts).toEqual(original.financialSpace.accounts);
    expect(amounts(changed)).toEqual(amounts(original));
  });
});
