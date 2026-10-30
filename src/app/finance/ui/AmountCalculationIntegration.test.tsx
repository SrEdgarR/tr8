import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FinancialDashboard } from './FinancePage';
import { addAccount, emptyFinancialSnapshot } from '../domain/workspace';
import { saveCreditCard } from '../domain/credit-card-workspace';
import type { FinancialSnapshot } from '../domain/workspace-types';

function fixture(withCard = false) {
  const snapshot = addAccount(emptyFinancialSnapshot(), {
    id: 'savings',
    name: 'Ahorro calculado',
    type: 'debit',
    currency: 'DOP',
    openingBalanceMinor: 1000000,
    openingDate: '2026-01-01',
  });
  return withCard
    ? saveCreditCard(snapshot, {
        id: 'card',
        name: 'Tarjeta USD',
        statementDay: 20,
        paymentDay: 2,
        asOfDate: '2026-10-26',
        balances: [{ currency: 'USD', creditLimitMinor: 100000, totalDebtMinor: 30000, statementPendingMinor: 20000 }],
      })
    : snapshot;
}

function mount(snapshot = fixture()) {
  const save = vi.fn();
  function Fixture() {
    const [value, setValue] = useState(snapshot);
    return (
      <FinancialDashboard
        snapshot={value}
        security={null}
        finance={{
          busy: false,
          save: async next => {
            save(next);
            setValue(next);
          },
        }}
      />
    );
  }
  render(<Fixture />);
  return save;
}

async function calculate(user: ReturnType<typeof userEvent.setup>, input: HTMLElement, expression: string) {
  await user.click(input);
  await user.clear(input);
  await user.type(input, expression);
  await user.tab();
}

describe('cálculos en formularios de finanzas', () => {
  it('guarda un gasto con el resultado de Tab en FormData y centavos exactos, no con la expresión', async () => {
    const user = userEvent.setup();
    const save = mount();
    await user.click(screen.getByRole('button', { name: 'Nuevo movimiento' }));
    const form = within(screen.getByRole('dialog', { name: 'Nuevo movimiento' }));
    await user.type(form.getByLabelText('Descripción'), 'Gasto calculado');
    const amount = form.getByLabelText('Importe · DOP');
    await calculate(user, amount, '20.2 + 10');
    expect(amount).toHaveValue('30.20');
    expect(new FormData(amount.closest('form')!).get('amount')).toBe('30.20');
    expect(save).not.toHaveBeenCalled();
    await user.click(form.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const result = save.mock.calls[0][0] as FinancialSnapshot;
    expect(result.financialSpace.operations).toHaveLength(1);
    expect(result.financialSpace.operations[0]).toMatchObject({ kind: 'expense', amountMinor: 3020, currency: 'DOP', description: 'Gasto calculado' });
  });

  it('mantiene deshacer y rehacer independientes para el débito DOP y el abono USD antes de guardar el pago', async () => {
    const user = userEvent.setup();
    const initial = fixture(true),
      save = mount(initial);
    const cardId = initial.financialSpace.accounts.find(account => account.currency === 'USD')!.id;
    await user.click(screen.getByRole('button', { name: 'Nuevo movimiento' }));
    const form = within(screen.getByRole('dialog', { name: 'Nuevo movimiento' }));
    await user.selectOptions(form.getByLabelText('Tipo de movimiento'), 'card-payment');
    await user.selectOptions(form.getByLabelText('Cuenta de destino'), cardId);
    await user.type(form.getByLabelText('Descripción'), 'Pago calculado');
    const debit = form.getByLabelText('Importe debitado · DOP'),
      credit = form.getByLabelText('Abono a la tarjeta · USD');
    await calculate(user, debit, '3000 + 3000');
    await calculate(user, credit, '50 + 50');
    expect(debit).toHaveValue('6000.00');
    expect(credit).toHaveValue('100.00');
    await user.click(debit);
    await user.keyboard('{Control>}z{/Control}');
    expect(debit).toHaveValue('3000 + 3000');
    expect(credit).toHaveValue('100.00');
    await user.keyboard('{Control>}y{/Control}');
    await user.click(credit);
    await user.keyboard('{Control>}z{/Control}');
    expect(credit).toHaveValue('50 + 50');
    expect(debit).toHaveValue('6000.00');
    await user.keyboard('{Control>}y{/Control}');
    expect(save).not.toHaveBeenCalled();
    await user.click(form.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect((save.mock.calls[0][0] as FinancialSnapshot).financialSpace.operations[0]).toMatchObject({
      kind: 'card-payment',
      currency: 'DOP',
      amountMinor: 600000,
      destinationCurrency: 'USD',
      destinationAmountMinor: 10000,
    });
  });

  it('guarda el resultado del saldo inicial no controlado en una cuenta nueva', async () => {
    const user = userEvent.setup();
    const initial = fixture(),
      save = mount(initial);
    await user.click(screen.getByRole('button', { name: 'Nueva cuenta' }));
    const form = within(screen.getByRole('dialog', { name: 'Nueva cuenta' }));
    await user.type(form.getByLabelText('Nombre de la cuenta'), 'Cuenta con saldo calculado');
    const balance = form.getByLabelText('Saldo inicial');
    await calculate(user, balance, '20.2 + 10');
    expect(new FormData(balance.closest('form')!).get('amount')).toBe('30.20');
    await user.click(form.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const result = save.mock.calls[0][0] as FinancialSnapshot;
    expect(result.financialSpace.accounts.find(account => account.name === 'Cuenta con saldo calculado')).toMatchObject({
      currency: 'DOP',
      openingBalanceMinor: 3020,
    });
    expect(result.financialSpace.accounts.find(account => account.id === 'savings')).toEqual(initial.financialSpace.accounts[0]);
    expect(result.financialSpace.operations).toEqual([]);
  });

  it('aplica cálculos al límite, deuda y pendiente de corte de una tarjeta nueva', async () => {
    const user = userEvent.setup();
    const save = mount();
    await user.click(screen.getByRole('button', { name: 'Nueva cuenta' }));
    await user.selectOptions(screen.getByLabelText('Tipo de cuenta'), 'credit');
    const form = within(screen.getByRole('dialog'));
    await user.type(form.getByLabelText('Nombre de la tarjeta'), 'Tarjeta calculada');
    await calculate(user, form.getByLabelText('Límite de crédito · DOP'), '5000 * 2');
    await calculate(user, form.getByLabelText('Deuda total actual · DOP'), '100 + 50');
    await calculate(user, form.getByLabelText(/^Pendiente del corte .* · DOP$/), '100 - 20');
    expect(save).not.toHaveBeenCalled();
    await user.click(form.getByRole('button', { name: 'Guardar tarjeta' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const result = save.mock.calls[0][0] as FinancialSnapshot;
    const card = result.financialSpace.accounts.find(account => account.name === 'Tarjeta calculada');
    expect(card).toMatchObject({
      type: 'credit',
      creditLimitMinor: 1000000,
      openingBalanceMinor: 15000,
      creditCard: { baseline: { statementDebtMinor: 8000 } },
    });
    expect(result.financialSpace.operations).toEqual([]);
  });
});
