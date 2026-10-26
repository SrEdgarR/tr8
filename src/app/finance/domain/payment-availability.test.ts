import { describe, expect, it } from 'vitest';
import { calculatePaymentAvailability } from './payment-availability';
import type { CreditCardAccount } from './credit-cards';
import type { FinancialAccount, FinancialOperation } from './types';

const currencies = [
  { code: 'DOP', minorUnitDigits: 2 },
  { code: 'USD', minorUnitDigits: 2 },
];
function bank(currency = 'DOP'): FinancialAccount {
  return { id: `bank-${currency}`, name: `Bank ${currency}`, type: 'debit', currency, openingBalanceMinor: 100000, openingDate: '2026-10-01' };
}
function card(currency = 'DOP'): CreditCardAccount {
  return {
    id: `card-${currency}`,
    name: 'One physical card',
    type: 'credit',
    currency,
    openingBalanceMinor: 12500,
    openingDate: '2026-10-26',
    creditLimitMinor: 100000,
    creditCard: {
      id: 'physical-card',
      statementDay: 20,
      paymentDay: 2,
      baseline: { asOfDate: '2026-10-26', statementDate: '2026-10-20', statementDebtMinor: 10000, statementPaidMinor: 0, includedOperationIds: [] },
    },
  };
}
function payment(amountMinor: number, date = '2026-10-26', currency = 'DOP'): FinancialOperation {
  return { id: `payment-${currency}`, kind: 'card-payment', currency, date, amountMinor, fromAccountId: `bank-${currency}`, toAccountId: `card-${currency}` };
}

describe('available cash after upcoming card payments', () => {
  it('subtracts the October closed statement, leaving November unbilled charges for a later payment', () => {
    const accounts = [bank(), card()];
    const before = structuredClone(accounts);
    expect(calculatePaymentAvailability(accounts, [], '2026-10-26', currencies)).toEqual([
      {
        currency: 'DOP',
        liquidMinor: 100000,
        creditDebtMinor: 12500,
        availableCreditMinor: 87500,
        netWorthMinor: 87500,
        availableCapacityMinor: 187500,
        nextPaymentMinor: 10000,
        unbilledDebtMinor: 2500,
        availableAfterPaymentMinor: 90000,
        missingAccountIds: [],
        needsReconciliation: false,
      },
    ]);
    expect(accounts).toEqual(before);
  });

  it('reduces both bank balance and remaining statement on payment, without subtracting the payment twice', () => {
    const result = calculatePaymentAvailability([bank(), card()], [payment(4000)], '2026-10-26', currencies)[0];
    expect(result).toMatchObject({
      liquidMinor: 96000,
      creditDebtMinor: 8500,
      nextPaymentMinor: 6000,
      unbilledDebtMinor: 2500,
      availableAfterPaymentMinor: 90000,
      netWorthMinor: 87500,
    });
    expect(calculatePaymentAvailability([bank(), card()], [payment(10000)], '2026-10-26', currencies)[0]).toMatchObject({
      liquidMinor: 90000,
      nextPaymentMinor: 0,
      unbilledDebtMinor: 2500,
      availableAfterPaymentMinor: 90000,
    });
  });

  it('keeps unpaid statements outstanding after their payment day and closes new consumption only on the next statement', () => {
    expect(calculatePaymentAvailability([bank(), card()], [], '2026-11-03', currencies)[0]).toMatchObject({
      nextPaymentMinor: 10000,
      unbilledDebtMinor: 2500,
      availableAfterPaymentMinor: 90000,
    });
    const charge: FinancialOperation = { id: 'new-charge', kind: 'expense', accountId: 'card-DOP', amountMinor: 1000, currency: 'DOP', date: '2026-11-19' };
    expect(calculatePaymentAvailability([bank(), card()], [charge], '2026-11-19', currencies)[0]).toMatchObject({
      nextPaymentMinor: 10000,
      unbilledDebtMinor: 3500,
      availableAfterPaymentMinor: 90000,
    });
    expect(calculatePaymentAvailability([bank(), card()], [charge], '2026-11-20', currencies)[0]).toMatchObject({
      nextPaymentMinor: 13500,
      unbilledDebtMinor: 0,
      availableAfterPaymentMinor: 86500,
    });
  });

  it('calculates DOP and USD pockets independently without converting or double-counting a shared card', () => {
    const usd = card('USD');
    usd.openingBalanceMinor = 2500;
    usd.creditCard.baseline!.statementDebtMinor = 1000;
    const result = calculatePaymentAvailability([bank(), bank('USD'), card(), usd], [payment(4000)], '2026-10-26', currencies);
    expect(result[0]).toMatchObject({ currency: 'DOP', nextPaymentMinor: 6000, availableAfterPaymentMinor: 90000, unbilledDebtMinor: 2500 });
    expect(result[1]).toMatchObject({ currency: 'USD', nextPaymentMinor: 1000, availableAfterPaymentMinor: 99000, unbilledDebtMinor: 1500 });
  });

  it('sums each card’s outstanding closed statements in the same currency', () => {
    const another = card();
    another.id = 'other-card';
    another.creditCard.id = 'other-physical-card';
    another.creditCard.baseline!.statementDebtMinor = 5000;
    expect(calculatePaymentAvailability([bank(), card(), another], [], '2026-10-26', currencies)[0]).toMatchObject({
      nextPaymentMinor: 15000,
      unbilledDebtMinor: 10000,
      availableAfterPaymentMinor: 85000,
    });
  });

  it('returns cash unchanged when there are no cards and supports an empty workspace', () => {
    expect(calculatePaymentAvailability([bank()], [], '2026-10-26', currencies)[0]).toMatchObject({
      nextPaymentMinor: 0,
      unbilledDebtMinor: 0,
      availableAfterPaymentMinor: 100000,
      missingAccountIds: [],
    });
    expect(calculatePaymentAvailability([], [], '2026-10-26', currencies)).toEqual([]);
  });

  it.each(['legacy', 'missing-baseline'] as const)('does not present a %s card as paid or replace its statement with total debt', mode => {
    const unknown = card();
    if (mode === 'legacy') delete (unknown as Extract<FinancialAccount, { type: 'credit' }>).creditCard;
    else delete unknown.creditCard.baseline;
    const result = calculatePaymentAvailability([bank(), unknown, bank('USD')], [], '2026-10-26', currencies);
    expect(result[0]).toMatchObject({
      netWorthMinor: 87500,
      nextPaymentMinor: null,
      unbilledDebtMinor: null,
      availableAfterPaymentMinor: null,
      missingAccountIds: ['card-DOP'],
      needsReconciliation: false,
    });
    expect(result[1]).toMatchObject({ currency: 'USD', nextPaymentMinor: 0, availableAfterPaymentMinor: 100000 });
  });

  it('does not infer a zero payment from an unknown card even if its current debt is zero', () => {
    const unknown = card();
    delete unknown.creditCard.baseline;
    unknown.openingBalanceMinor = 0;
    expect(calculatePaymentAvailability([bank(), unknown], [], '2026-10-26', currencies)[0]).toMatchObject({
      nextPaymentMinor: null,
      availableAfterPaymentMinor: null,
      missingAccountIds: ['card-DOP'],
    });
  });

  it('requires reconciliation after backdated records instead of publishing a partial currency total', () => {
    const old = card();
    old.openingDate = '2026-10-01';
    const result = calculatePaymentAvailability([bank(), old], [payment(1000, '2026-10-25')], '2026-10-26', currencies)[0];
    expect(result).toMatchObject({
      liquidMinor: 99000,
      netWorthMinor: 87500,
      nextPaymentMinor: null,
      unbilledDebtMinor: null,
      availableAfterPaymentMinor: null,
      missingAccountIds: ['card-DOP'],
      needsReconciliation: true,
    });
  });

  it('refunds an unbilled purchase without falsely reducing the outstanding closed statement', () => {
    const captured = card();
    captured.openingBalanceMinor = 11500;
    captured.creditCard.baseline!.includedOperationIds = ['new-purchase'];
    const operations: FinancialOperation[] = [
      { id: 'new-purchase', kind: 'expense', accountId: 'card-DOP', amountMinor: 1000, currency: 'DOP', date: '2026-10-26' },
      {
        id: 'returned-purchase',
        kind: 'refund',
        originalExpenseId: 'new-purchase',
        destinationAccountId: 'card-DOP',
        amountMinor: 1000,
        currency: 'DOP',
        date: '2026-10-27',
      },
    ];
    expect(calculatePaymentAvailability([bank(), captured], operations, '2026-10-27', currencies)[0]).toMatchObject({
      creditDebtMinor: 11500,
      nextPaymentMinor: 10000,
      unbilledDebtMinor: 1500,
      availableAfterPaymentMinor: 90000,
      needsReconciliation: false,
    });
  });

  it('keeps a negative available amount when the next payment exceeds liquid cash', () => {
    const poor = bank();
    poor.openingBalanceMinor = 1000;
    expect(calculatePaymentAvailability([poor, card()], [], '2026-10-26', currencies)[0].availableAfterPaymentMinor).toBe(-9000);
  });
});
