import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import PaymentAvailabilitySummary from './PaymentAvailabilitySummary';
import { calculatePaymentAvailability } from '../domain/payment-availability';
import type { CurrencyDefinition, FinancialAccount, FinancialOperation } from '../domain/types';

const currencies: CurrencyDefinition[] = [{ code: 'DOP', minorUnitDigits: 2 }];
function accounts(): FinancialAccount[] {
  return [
    { id: 'bank', name: 'Ahorro', currency: 'DOP', type: 'debit', openingDate: '2026-10-26', openingBalanceMinor: 500000 },
    {
      id: 'card',
      name: 'Visa de prueba',
      currency: 'DOP',
      type: 'credit',
      openingDate: '2026-10-26',
      openingBalanceMinor: 125000,
      creditLimitMinor: 1000000,
      creditCard: {
        id: 'visa',
        statementDay: 20,
        paymentDay: 2,
        baseline: { asOfDate: '2026-10-26', statementDate: '2026-10-20', statementDebtMinor: 100000, statementPaidMinor: 0, includedOperationIds: [] },
      },
    },
  ];
}
function summaryProps(source: FinancialAccount[], operations: FinancialOperation[] = []) {
  return {
    accounts: source,
    summaries: calculatePaymentAvailability(source, operations, '2026-10-26', currencies),
    currencies,
    canEdit: true,
    onEdit: vi.fn(),
  };
}
function row(label: string) {
  return within(screen.getByRole('article', { name: 'Disponibilidad en DOP' })).getByText(label).nextElementSibling;
}

it('shows the closed statement as the next payment and keeps future consumption and net worth separate', () => {
  const source = accounts();
  const props = summaryProps(source);
  const view = render(<PaymentAvailabilitySummary {...props} />);
  expect(row('Disponible después del próximo pago')).toHaveTextContent('DOP 4.000,00');
  expect(row('Pendiente de cortes cerrados')).toHaveTextContent('DOP 1.000,00');
  expect(row('Consumo para el siguiente corte')).toHaveTextContent('DOP 250,00');
  expect(row('Patrimonio neto')).toHaveTextContent('DOP 3.750,00');
  const payment: FinancialOperation = {
    id: 'payment',
    kind: 'card-payment',
    fromAccountId: 'bank',
    toAccountId: 'card',
    currency: 'DOP',
    amountMinor: 40000,
    date: '2026-10-26',
  };
  view.rerender(<PaymentAvailabilitySummary {...summaryProps(source, [payment])} />);
  expect(row('Dinero en tus cuentas')).toHaveTextContent('DOP 4.600,00');
  expect(row('Pendiente de cortes cerrados')).toHaveTextContent('DOP 600,00');
  expect(row('Disponible después del próximo pago')).toHaveTextContent('DOP 4.000,00');
  expect(row('Patrimonio neto')).toHaveTextContent('DOP 3.750,00');
});

it('keeps an unknown statement visibly incomplete and opens its existing settings without mutating the account', () => {
  const source = accounts();
  const card = source[1];
  if (card.type !== 'credit') throw Error('invalid fixture');
  delete card.creditCard!.baseline;
  const original = structuredClone(source);
  const props = summaryProps(source);
  render(<PaymentAvailabilitySummary {...props} />);
  expect(row('Disponible después del próximo pago')).toHaveTextContent('Por completar');
  expect(row('Pendiente de cortes cerrados')).toHaveTextContent('Por completar');
  expect(row('Consumo para el siguiente corte')).toHaveTextContent('Por completar');
  expect(row('Patrimonio neto')).toHaveTextContent('DOP 3.750,00');
  fireEvent.click(screen.getByRole('button', { name: 'Completar corte de Visa de prueba en DOP' }));
  expect(props.onEdit).toHaveBeenCalledExactlyOnceWith(card);
  expect(source).toEqual(original);
});

it('respects read-only access when a statement needs to be completed', () => {
  const source = accounts();
  const card = source[1];
  if (card.type !== 'credit') throw Error('invalid fixture');
  delete card.creditCard;
  const props = summaryProps(source);
  render(<PaymentAvailabilitySummary {...props} canEdit={false} />);
  expect(screen.getByRole('button', { name: 'Completar corte de Visa de prueba en DOP' })).toBeDisabled();
  expect(props.onEdit).not.toHaveBeenCalled();
});
