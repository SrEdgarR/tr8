import { describe, expect, it, vi } from 'vitest';
import { CURRENCY_CATALOG } from './catalog';
import { projectFinancialBalances } from './projection';
import { referenceFinancialBalances, referenceFinancialProjection } from './projection-reference.test-fixtures';
import { calculateFinancialBalances } from './balances';
import * as normalization from './operations';
import type { FinancialAccount, FinancialOperation } from './types';

function corpus(seed: number) {
  const accounts: FinancialAccount[] = [
    { id: 'bank', name: 'Synthetic bank', type: 'debit', currency: 'BOB', openingBalanceMinor: 10000 + seed * 97, openingDate: '2026-01-01' },
    { id: 'cash', name: 'Synthetic cash', type: 'cash', currency: 'BOB', openingBalanceMinor: 1000 - seed * 173, openingDate: '2026-01-01' },
    {
      id: 'card',
      name: 'Synthetic card',
      type: 'credit',
      currency: 'BOB',
      openingBalanceMinor: seed % 2 === 0 ? -500 : 15000,
      openingDate: '2026-01-01',
      creditLimitMinor: 10000,
    },
    { id: 'usd', name: 'Synthetic USD', type: 'debit', currency: 'USD', openingBalanceMinor: 9000, openingDate: '2026-01-01' },
  ];
  if (seed % 3 === 0) accounts.reverse();
  const confirmedOperations: FinancialOperation[] = [
    { id: 'expense', kind: 'expense', accountId: 'card', currency: 'BOB', amountMinor: 1000, date: '2026-10-01' },
    { id: 'income', kind: 'income', accountId: 'usd', currency: 'USD', amountMinor: 53, date: '2026-10-02' },
    { id: 'transfer', kind: 'transfer', fromAccountId: 'bank', toAccountId: 'cash', currency: 'BOB', amountMinor: 150, date: '2026-10-03' },
    { id: 'payment', kind: 'card-payment', fromAccountId: 'bank', toAccountId: 'card', currency: 'BOB', amountMinor: 200, date: '2026-10-05' },
    {
      id: 'refund',
      kind: 'refund',
      originalExpenseId: 'expense',
      destinationAccountId: seed % 2 ? 'card' : 'cash',
      currency: 'BOB',
      amountMinor: 100,
      date: '2026-10-09',
    },
    { id: 'future-confirmed', kind: 'expense', accountId: 'bank', currency: 'BOB', amountMinor: 75, date: '2026-10-27' },
    { id: 'future-refund', kind: 'refund', originalExpenseId: 'expense', destinationAccountId: 'bank', currency: 'BOB', amountMinor: 125, date: '2026-10-28' },
    { id: 'outside-confirmed', kind: 'income', accountId: 'bank', currency: 'BOB', amountMinor: 5, date: '2027-01-01' },
  ];
  const plannedOperations: FinancialOperation[] = [
    { id: 'future-planned', kind: 'expense', accountId: 'card', currency: 'BOB', amountMinor: 300, date: '2026-10-29' },
    {
      id: 'future-planned-refund',
      kind: 'refund',
      originalExpenseId: 'future-planned',
      destinationAccountId: 'cash',
      currency: 'BOB',
      amountMinor: 100,
      date: '2026-10-30',
    },
    { id: 'future-planned-transfer', kind: 'transfer', fromAccountId: 'cash', toAccountId: 'bank', currency: 'BOB', amountMinor: 50, date: '2026-10-30' },
    { id: 'future-planned-payment', kind: 'card-payment', fromAccountId: 'bank', toAccountId: 'card', currency: 'BOB', amountMinor: 150, date: '2026-10-31' },
    { id: 'today', kind: 'expense', accountId: 'bank', currency: 'BOB', amountMinor: 500, date: '2026-10-25' },
    { id: 'overdue', kind: 'expense', accountId: 'bank', currency: 'BOB', amountMinor: 400, date: '2026-10-20' },
    { id: 'outside-planned', kind: 'expense', accountId: 'bank', currency: 'BOB', amountMinor: 100, date: '2027-01-02' },
  ];
  if (seed % 2) {
    confirmedOperations.reverse();
    plannedOperations.reverse();
  }
  return { accounts, confirmedOperations, plannedOperations, today: '2026-10-25', targetDate: '2026-11-02' };
}

describe('date sweep preserves the pinned-source projection semantics', () => {
  for (let seed = 0; seed < 12; seed++) {
    it('matches the reference for signed credit/liquid balances, paired movements, refunds and horizon ' + seed, () => {
      const input = corpus(seed),
        before = structuredClone(input);
      for (const targetDate of ['2026-10-25', '2026-10-26', '2026-10-29', '2026-11-02']) {
        const data = { ...input, targetDate };
        expect(projectFinancialBalances(data, CURRENCY_CATALOG)).toEqual(referenceFinancialProjection(data, CURRENCY_CATALOG));
      }
      expect(input).toEqual(before);
    });
  }
  it('preserves per-account opening cutoffs of the low-level calculator', () => {
    const input = corpus(0);
    input.accounts = input.accounts.map(account => ({ ...account, openingDate: account.id === 'cash' ? '2026-10-04' : account.openingDate }));
    expect(calculateFinancialBalances(input.accounts, input.confirmedOperations, '2026-10-25', CURRENCY_CATALOG)).toEqual(
      referenceFinancialBalances(input.accounts, input.confirmedOperations, '2026-10-25', CURRENCY_CATALOG),
    );
    expect(projectFinancialBalances(input, CURRENCY_CATALOG)).toEqual(referenceFinancialProjection(input, CURRENCY_CATALOG));
  });
  it('preserves failures before filtering future data: duplicates, foreign currencies and separate refund ledgers', () => {
    const base = corpus(0);
    const duplicated = structuredClone(base);
    duplicated.plannedOperations.at(-1)!.id = 'outside-confirmed';
    const foreignCurrency = structuredClone(base);
    foreignCurrency.plannedOperations[2].currency = 'USD';
    const crossRefund = structuredClone(base);
    crossRefund.plannedOperations[1] = {
      ...crossRefund.plannedOperations[1],
      kind: 'refund',
      originalExpenseId: 'expense',
      destinationAccountId: 'bank',
    } as FinancialOperation;
    const beforeOpening = structuredClone(base);
    beforeOpening.accounts[0].openingDate = '2026-10-26';
    for (const input of [duplicated, foreignCurrency, crossRefund, beforeOpening, { ...base, targetDate: '2026-10-24' }]) {
      expect(() => referenceFinancialProjection(input, CURRENCY_CATALOG)).toThrow();
      expect(() => projectFinancialBalances(input, CURRENCY_CATALOG)).toThrow();
    }
  });
  it('checks daily closing overflow even if a later projected day compensates', () => {
    const input = {
      accounts: [
        { id: 'bank', name: 'Synthetic range', type: 'debit', currency: 'BOB', openingBalanceMinor: Number.MAX_SAFE_INTEGER - 1, openingDate: '2026-01-01' },
      ],
      confirmedOperations: [],
      plannedOperations: [
        { id: 'overflow', kind: 'income', accountId: 'bank', currency: 'BOB', amountMinor: 2, date: '2026-10-26' },
        { id: 'offset', kind: 'expense', accountId: 'bank', currency: 'BOB', amountMinor: 2, date: '2026-10-27' },
      ],
      today: '2026-10-25',
      targetDate: '2026-10-28',
    };
    expect(() => referenceFinancialProjection(input, CURRENCY_CATALOG)).toThrow();
    expect(() => projectFinancialBalances(input, CURRENCY_CATALOG)).toThrow();
    input.plannedOperations[1].date = '2026-10-26';
    expect(projectFinancialBalances(input, CURRENCY_CATALOG)).toEqual(referenceFinancialProjection(input, CURRENCY_CATALOG));
  });
  it('normalizes 1000 operations only twice rather than once for every date point', () => {
    const date = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
    const accounts: FinancialAccount[] = Array.from({ length: 10 }, (_, index) => ({
      id: 'a' + index,
      name: 'Synthetic ' + index,
      type: 'debit',
      currency: 'BOB',
      openingBalanceMinor: 100000,
      openingDate: '2020-01-01',
    }));
    const confirmedOperations = Array.from({ length: 500 }, (_, index) => ({
      id: 'real' + index,
      kind: 'income',
      accountId: 'a' + (index % 10),
      currency: 'BOB',
      amountMinor: 1,
      date: date(2020, 0, 2 + index),
    }));
    const plannedOperations = Array.from({ length: 500 }, (_, index) => ({
      id: 'plan' + index,
      kind: 'expense',
      accountId: 'a' + (index % 10),
      currency: 'BOB',
      amountMinor: 1,
      date: date(2026, 9, 26 + index),
    }));
    const input = { accounts, confirmedOperations, plannedOperations, today: '2026-10-25', targetDate: date(2026, 9, 26 + 499) };
    expect(new TextEncoder().encode(JSON.stringify(input)).length).toBeLessThan(1_048_576);
    const normalize = vi.spyOn(normalization, 'normalizeFinancialOperations');
    const result = projectFinancialBalances(input, CURRENCY_CATALOG);
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(result.points).toHaveLength(501);
    expect(result.current.currencies[0].netWorthMinor).toBe(1_000_500);
    expect(result.projected.currencies[0].netWorthMinor).toBe(1_000_000);
  });
});
