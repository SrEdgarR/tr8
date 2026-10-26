import { describe, expect, it } from 'vitest';
import { cardCycleDates, creditCardCycleStatus, validateCreditCardMetadata, type CreditCardAccount, type CreditCardMetadata } from './credit-cards';
import type { FinancialOperation } from './types';

const metadata = (): CreditCardMetadata => ({
  id: 'one-physical-card',
  statementDay: 20,
  paymentDay: 2,
  baseline: { asOfDate: '2026-10-26', statementDate: '2026-10-20', statementDebtMinor: 10000, statementPaidMinor: 0, includedOperationIds: [] },
});
const account = (): CreditCardAccount => ({
  id: 'card-dop',
  name: 'Synthetic credit card',
  type: 'credit',
  currency: 'DOP',
  creditLimitMinor: 50000,
  openingBalanceMinor: 12500,
  openingDate: '2026-10-26',
  creditCard: metadata(),
});
const expense = (id: string, date: string, amountMinor: number, accountId = 'card-dop', currency = 'DOP'): FinancialOperation => ({
  id,
  date,
  amountMinor,
  accountId,
  currency,
  kind: 'expense',
});
const payment = (id: string, date: string, amountMinor: number, toAccountId = 'card-dop', currency = 'DOP'): FinancialOperation => ({
  id,
  date,
  amountMinor,
  fromAccountId: 'bank',
  toAccountId,
  currency,
  kind: 'card-payment',
});

describe('credit card statement dates', () => {
  it('places an October 20 statement payment on November 2, and the next statement payment on December 2', () => {
    expect(cardCycleDates('2026-10-26', 20, 2)).toEqual({
      lastStatementDate: '2026-10-20',
      nextStatementDate: '2026-11-20',
      paymentDate: '2026-11-02',
      nextPaymentDate: '2026-12-02',
    });
  });
  it('includes statement day and clamps calendar days at leap-year month ends', () => {
    expect(cardCycleDates('2028-02-29', 31, 2)).toEqual({
      lastStatementDate: '2028-02-29',
      nextStatementDate: '2028-03-31',
      paymentDate: '2028-03-02',
      nextPaymentDate: '2028-04-02',
    });
    expect(cardCycleDates('2027-02-28', 31, 31).paymentDate).toBe('2027-03-31');
    expect(cardCycleDates('2026-12-26', 20, 2).paymentDate).toBe('2027-01-02');
  });
  it('uses the previous statement before the configured closing day and rejects invalid days', () => {
    expect(cardCycleDates('2026-10-19', 20, 2).lastStatementDate).toBe('2026-09-20');
    expect(cardCycleDates('2026-10-20', 20, 2).lastStatementDate).toBe('2026-10-20');
    expect(() => cardCycleDates('2026-10-26', 0, 2)).toThrow();
    expect(() => cardCycleDates('2026-10-26', 20, 32)).toThrow();
  });
});

describe('credit card cycle accounting', () => {
  it('uses a bank statement captured after its date without asking for a pre-opening ledger balance', () => {
    const status = creditCardCycleStatus(account(), [], '2026-10-26');
    expect(status).toMatchObject({
      baselineKnown: true,
      totalDebtMinor: 12500,
      statementPendingMinor: 10000,
      unbilledDebtMinor: 2500,
      nextPaymentAmountMinor: 10000,
      paymentDate: '2026-11-02',
      overdueMinor: 0,
      paymentStatus: 'pending',
    });
  });
  it('keeps debt outstanding on and after payment day until an actual payment is recorded', () => {
    expect(creditCardCycleStatus(account(), [], '2026-11-02').paymentStatus).toBe('due-today');
    expect(creditCardCycleStatus(account(), [], '2026-11-03')).toMatchObject({
      statementPendingMinor: 10000,
      overdueMinor: 10000,
      oldestUnpaidDueDate: '2026-11-02',
      paymentStatus: 'overdue',
    });
  });
  it('distinguishes a new payment on the capture day from records already included in the statement', () => {
    const status = creditCardCycleStatus(account(), [payment('new-payment', '2026-10-26', 4000)], '2026-10-26');
    expect(status).toMatchObject({ totalDebtMinor: 8500, statementPendingMinor: 6000, unbilledDebtMinor: 2500 });
    const captured = account();
    captured.creditCard.baseline!.includedOperationIds = ['existing-payment'];
    captured.creditCard.baseline!.statementDebtMinor = 6000;
    const again = creditCardCycleStatus(captured, [payment('existing-payment', '2026-10-26', 4000)], '2026-10-26');
    expect(again).toMatchObject({ totalDebtMinor: 8500, statementPendingMinor: 6000, unbilledDebtMinor: 2500 });
  });
  it('allocates recorded payment to the oldest statement first and only then to unbilled charges', () => {
    const status = creditCardCycleStatus(account(), [payment('pay-all-cut', '2026-11-02', 11000)], '2026-11-02');
    expect(status).toMatchObject({ totalDebtMinor: 1500, statementPendingMinor: 0, unbilledDebtMinor: 1500, overdueMinor: 0, paymentStatus: 'paid' });
    const credit = creditCardCycleStatus(account(), [payment('overpay', '2026-11-02', 13000)], '2026-11-02');
    expect(credit).toMatchObject({ totalDebtMinor: -500, statementPendingMinor: 0, unbilledDebtMinor: 0, paymentStatus: 'paid' });
  });
  it('closes new expenses exactly once and keeps an older missed payment overdue across later statements', () => {
    const operations = [expense('new-charge', '2026-11-20', 1000)];
    expect(creditCardCycleStatus(account(), operations, '2026-11-19')).toMatchObject({
      totalDebtMinor: 12500,
      statementPendingMinor: 10000,
      unbilledDebtMinor: 2500,
    });
    expect(creditCardCycleStatus(account(), operations, '2026-11-20')).toMatchObject({
      totalDebtMinor: 13500,
      statementPendingMinor: 13500,
      unbilledDebtMinor: 0,
      overdueMinor: 10000,
      oldestUnpaidDueDate: '2026-11-02',
      paymentDate: '2026-12-02',
    });
    expect(creditCardCycleStatus(account(), operations, '2026-12-20').totalDebtMinor).toBe(13500);
  });
  it('keeps two currency pockets and their payments independent even with a shared physical card id', () => {
    const dop = account();
    const usd = account();
    usd.id = 'card-usd';
    usd.currency = 'USD';
    usd.creditLimitMinor = 200000;
    usd.openingBalanceMinor = 2500;
    usd.creditCard.baseline!.statementDebtMinor = 1000;
    const operations = [payment('pay-pesos', '2026-10-26', 5000), expense('dollar-charge', '2026-10-26', 100, 'card-usd', 'USD')];
    expect(creditCardCycleStatus(dop, operations, '2026-10-26')).toMatchObject({ totalDebtMinor: 7500, statementPendingMinor: 5000 });
    expect(creditCardCycleStatus(usd, operations, '2026-10-26')).toMatchObject({ totalDebtMinor: 2600, statementPendingMinor: 1000, unbilledDebtMinor: 1600 });
    expect(dop.creditCard.id).toBe(usd.creditCard.id);
    expect(dop.creditLimitMinor).toBe(50000);
    expect(usd.creditLimitMinor).toBe(200000);
  });
  it('does not apply a bank-account refund to a card and applies card credits without inferring payments', () => {
    const refunds: FinancialOperation[] = [
      {
        id: 'bank-refund',
        kind: 'refund',
        originalExpenseId: 'purchase',
        destinationAccountId: 'bank',
        currency: 'DOP',
        amountMinor: 1000,
        date: '2026-10-26',
      },
      {
        id: 'card-refund',
        kind: 'refund',
        originalExpenseId: 'purchase',
        destinationAccountId: 'card-dop',
        currency: 'DOP',
        amountMinor: 500,
        date: '2026-10-26',
      },
    ];
    expect(creditCardCycleStatus(account(), refunds, '2026-10-26')).toMatchObject({
      totalDebtMinor: 12000,
      statementPendingMinor: 9500,
      unbilledDebtMinor: 2500,
    });
  });
  it('keeps amounts unknown when no statement is supplied, and requests reconciliation for a new backdated record', () => {
    const unknown = account();
    delete unknown.creditCard.baseline;
    expect(creditCardCycleStatus(unknown, [], '2026-10-26')).toMatchObject({
      baselineKnown: false,
      totalDebtMinor: 12500,
      statementPendingMinor: null,
      unbilledDebtMinor: null,
      paymentStatus: 'unknown',
    });
    const old = account();
    old.openingDate = '2026-10-01';
    expect(creditCardCycleStatus(old, [payment('backdated', '2026-10-25', 1000)], '2026-10-26')).toMatchObject({
      baselineKnown: false,
      needsReconciliation: true,
      totalDebtMinor: 11500,
      statementPendingMinor: null,
    });
  });
  it('does not pretend an inconsistent opening capture is a known statement', () => {
    const inconsistent = account();
    inconsistent.creditCard.baseline!.statementDebtMinor = 13000;
    expect(creditCardCycleStatus(inconsistent, [], '2026-10-26')).toMatchObject({ baselineKnown: false, needsReconciliation: true, totalDebtMinor: 12500 });
  });
  it('asks to reconcile a new charge on an already captured statement date, but still applies a recorded payment', () => {
    const sameDay = account();
    sameDay.openingDate = '2026-10-20';
    sameDay.creditCard.baseline!.asOfDate = '2026-10-20';
    expect(creditCardCycleStatus(sameDay, [expense('cut-day', '2026-10-20', 100)], '2026-10-20')).toMatchObject({
      totalDebtMinor: 12600,
      baselineKnown: false,
      needsReconciliation: true,
      statementPendingMinor: null,
    });
    expect(creditCardCycleStatus(sameDay, [payment('cut-payment', '2026-10-20', 100)], '2026-10-20')).toMatchObject({
      totalDebtMinor: 12400,
      baselineKnown: true,
      statementPendingMinor: 9900,
    });
  });
  it('asks to reconcile a captured movement that disappeared from the supplied ledger', () => {
    const missing = account();
    missing.creditCard.baseline!.includedOperationIds = ['removed-record'];
    expect(creditCardCycleStatus(missing, [], '2026-10-26')).toMatchObject({ baselineKnown: false, needsReconciliation: true, totalDebtMinor: 12500 });
  });
  it('refunds a purchase after the last statement against unbilled debt without falsely paying the old statement', () => {
    const captured = account();
    captured.creditCard.baseline!.includedOperationIds = ['new-purchase'];
    const operations: FinancialOperation[] = [
      expense('new-purchase', '2026-10-26', 1000),
      {
        id: 'return',
        kind: 'refund',
        originalExpenseId: 'new-purchase',
        destinationAccountId: 'card-dop',
        currency: 'DOP',
        amountMinor: 1000,
        date: '2026-10-27',
      },
    ];
    expect(creditCardCycleStatus(captured, operations, '2026-10-27')).toMatchObject({
      totalDebtMinor: 12500,
      statementPendingMinor: 10000,
      unbilledDebtMinor: 2500,
      paymentStatus: 'pending',
    });
  });
});

describe('credit card metadata boundary', () => {
  it('keeps missing statement information optional and validates supplied captured record ids', () => {
    const without = metadata();
    delete without.baseline;
    expect(validateCreditCardMetadata(without)).toEqual(without);
    const duplicate = metadata();
    duplicate.baseline!.includedOperationIds = ['same', 'same'];
    expect(() => validateCreditCardMetadata(duplicate)).toThrow();
    const wrongCut = metadata();
    wrongCut.baseline!.statementDate = '2026-09-20';
    expect(() => validateCreditCardMetadata(wrongCut)).toThrow();
    const overpaid = metadata();
    overpaid.baseline!.statementPaidMinor = 10001;
    expect(() => validateCreditCardMetadata(overpaid)).toThrow();
  });
});
