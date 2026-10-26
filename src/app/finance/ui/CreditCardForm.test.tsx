import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import CreditCardForm from './CreditCardForm';
import { addAccount, emptyFinancialSnapshot } from '../domain/workspace';
import { addPairedOperation } from '../domain/connected-operations';
import type { FinancialSnapshot } from '../domain/workspace-types';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T16:00:00-04:00'));
});
afterEach(() => vi.useRealTimers());

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function mount(snapshot = emptyFinancialSnapshot(), initialId?: string) {
  const onSave = vi.fn();
  render(
    <CreditCardForm
      snapshot={snapshot}
      initialAccount={snapshot.financialSpace.accounts.find(a => a.id === initialId)}
      busy={false}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  );
  return { onSave };
}
function saved(onSave: ReturnType<typeof vi.fn>): FinancialSnapshot {
  expect(onSave).toHaveBeenCalledTimes(1);
  return onSave.mock.calls[0][0] as FinancialSnapshot;
}

describe('credit card form', () => {
  it('creates one DOP and USD card with independent limits and outstanding statement amounts', () => {
    const h = mount();
    expect(screen.getByLabelText('Moneda 1')).toHaveValue('DOP');
    fill('Nombre de la tarjeta', 'Tarjeta multimoneda QA');
    fill('Banco (opcional)', 'Banco ficticio');
    fill('Día de corte', '20');
    fill('Día de pago programado', '2');
    expect(screen.getByText('2026-10-20', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('2026-11-02', { exact: true })).toBeInTheDocument();
    fill('Límite de crédito · DOP', '100000');
    fill('Deuda total actual · DOP', '2500,50');
    fill('Pendiente del corte 2026-10-20 · DOP', '1500.10');
    fireEvent.click(screen.getByRole('button', { name: 'Añadir otra moneda' }));
    expect(screen.getByLabelText('Moneda 2')).toHaveValue('USD');
    fill('Límite de crédito · USD', '1000');
    fill('Deuda total actual · USD', '120.25');
    fill('Pendiente del corte 2026-10-20 · USD', '80,05');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar tarjeta' }));
    const result = saved(h.onSave);
    expect(result.financialSpace.accounts).toHaveLength(2);
    const dop = result.financialSpace.accounts[0],
      usd = result.financialSpace.accounts[1];
    if (dop.type !== 'credit' || usd.type !== 'credit') throw Error('Expected credit accounts');
    expect(dop).toMatchObject({
      name: 'Tarjeta multimoneda QA',
      bankName: 'Banco ficticio',
      currency: 'DOP',
      creditLimitMinor: 10000000,
      openingBalanceMinor: 250050,
    });
    expect(usd).toMatchObject({ currency: 'USD', creditLimitMinor: 100000, openingBalanceMinor: 12025 });
    expect(dop.creditCard?.id).toBeTruthy();
    expect(usd.creditCard?.id).toBe(dop.creditCard?.id);
    expect(dop.creditCard).toMatchObject({
      statementDay: 20,
      paymentDay: 2,
      baseline: { statementDate: '2026-10-20', asOfDate: '2026-10-26', statementDebtMinor: 150010, statementPaidMinor: 0 },
    });
    expect(usd.creditCard?.baseline?.statementDebtMinor).toBe(8005);
    expect(result.financialSpace.operations).toEqual([]);
  });

  it('links legacy balances explicitly while keeping debt read-only, ids, opening points and movements', () => {
    let snapshot = emptyFinancialSnapshot();
    for (const account of [
      { id: 'bank', name: 'Banco de pago', type: 'debit', currency: 'DOP', openingBalanceMinor: 100000, openingDate: '2026-10-01' },
      {
        id: 'legacy-dop',
        name: 'Tarjeta anterior DOP',
        type: 'credit',
        currency: 'DOP',
        openingBalanceMinor: 25000,
        creditLimitMinor: 100000,
        openingDate: '2026-10-01',
      },
      {
        id: 'legacy-usd',
        name: 'Tarjeta anterior USD',
        type: 'credit',
        currency: 'USD',
        openingBalanceMinor: 1200,
        creditLimitMinor: 10000,
        openingDate: '2026-10-01',
      },
    ])
      snapshot = addAccount(snapshot, account);
    snapshot = addPairedOperation(snapshot, {
      id: 'paid-before',
      kind: 'card-payment',
      fromAccountId: 'bank',
      toAccountId: 'legacy-dop',
      amountMinor: 1000,
      date: '2026-10-25',
      description: 'Pago ya registrado',
      note: '',
    });
    const h = mount(snapshot, 'legacy-dop');
    expect(screen.getByLabelText('Deuda total actual · DOP')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Deuda total actual · DOP')).toHaveValue('240.00');
    fill('Vincular saldo existente', 'legacy-usd');
    expect(screen.getByLabelText('Moneda 2')).toBeDisabled();
    expect(screen.getByLabelText('Deuda total actual · USD')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Deuda total actual · USD')).toHaveValue('12.00');
    fill('Nombre de la tarjeta', 'Mi tarjeta agrupada');
    for (const currency of ['DOP', 'USD']) {
      const section = screen.getByRole('region', { name: `Saldo ${currency}` });
      fireEvent.click(within(section).getByRole('checkbox', { name: 'Completar la deuda al corte después' }));
    }
    fill('Pendiente del corte 2026-10-20 · DOP', '150');
    fill('Pendiente del corte 2026-10-20 · USD', '8');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar tarjeta' }));
    const result = saved(h.onSave);
    expect(result.financialSpace.accounts.map(a => a.id)).toEqual(['bank', 'legacy-dop', 'legacy-usd']);
    expect(result.financialSpace.accounts.map(a => a.openingBalanceMinor)).toEqual([100000, 25000, 1200]);
    expect(result.financialSpace.accounts.every(a => a.openingDate === '2026-10-01')).toBe(true);
    expect(result.financialSpace.operations).toEqual(snapshot.financialSpace.operations);
    expect(result.financialSpace.plans).toEqual(snapshot.financialSpace.plans);
    const dop = result.financialSpace.accounts[1],
      usd = result.financialSpace.accounts[2];
    if (dop.type !== 'credit' || usd.type !== 'credit') throw Error('Expected credit accounts');
    expect(dop.creditCard?.id).toBe(usd.creditCard?.id);
    expect(dop.creditCard?.baseline?.includedOperationIds).toContain('paid-before');
    expect(usd.creditCard?.baseline?.includedOperationIds).toContain('paid-before');
  });

  it('rejects a statement pending above total debt and more than two decimal places before saving', () => {
    const h = mount();
    fill('Nombre de la tarjeta', 'Tarjeta inválida QA');
    fill('Límite de crédito · DOP', '1000');
    fill('Deuda total actual · DOP', '100');
    fill('Pendiente del corte 2026-10-20 · DOP', '101');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar tarjeta' }));
    expect(h.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/pendiente del corte.*deuda total/i);
    fill('Pendiente del corte 2026-10-20 · DOP', '50');
    fill('Deuda total actual · DOP', '100.001');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar tarjeta' }));
    expect(h.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Esta moneda admite 2 decimales.');
  });
  it('requires an explicit statement amount or choosing to complete it later, without inferring paid', () => {
    const h = mount();
    fill('Nombre de la tarjeta', 'Captura pendiente QA');
    fill('Límite de crédito · DOP', '1000');
    fill('Deuda total actual · DOP', '100');
    const pending = screen.getByLabelText('Pendiente del corte 2026-10-20 · DOP');
    expect(pending).toHaveValue('');
    expect(pending).toBeRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar tarjeta' }));
    expect(h.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Completar la deuda al corte después' }));
    expect(pending).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar tarjeta' }));
    const account = saved(h.onSave).financialSpace.accounts[0];
    if (account.type !== 'credit') throw Error('Expected credit account');
    expect(account.creditCard?.baseline).toBeUndefined();
    expect(account.openingBalanceMinor).toBe(10000);
  });
});
