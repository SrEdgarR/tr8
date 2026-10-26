import { describe, expect, it } from 'vitest';
import { addAccount, addEntry, emptyFinancialSnapshot, prepareEntryOperation } from './workspace';
import { addPairedOperation, addRefund } from './connected-operations';
import { addPlan, resolvePlan } from './plans';
import { saveCreditCard } from './credit-card-workspace';
import { getAccountRemoval, removeFinancialAccount } from './account-removal';

function accounts() {
  let snapshot = emptyFinancialSnapshot();
  for (const account of [
    { id: 'bank', name: 'Banco QA', type: 'debit', currency: 'DOP', openingBalanceMinor: 10000, openingDate: '2026-01-01' },
    { id: 'cash', name: 'Efectivo QA', type: 'cash', currency: 'DOP', openingBalanceMinor: 2000, openingDate: '2026-01-01' },
    { id: 'card-dop', name: 'Tarjeta DOP QA', type: 'credit', currency: 'DOP', openingBalanceMinor: 1000, creditLimitMinor: 10000, openingDate: '2026-01-01' },
    { id: 'card-usd', name: 'Tarjeta USD QA', type: 'credit', currency: 'USD', openingBalanceMinor: 100, creditLimitMinor: 1000, openingDate: '2026-01-01' },
  ])
    snapshot = addAccount(snapshot, account);
  return snapshot;
}
function expense(snapshot = accounts()) {
  return addEntry(snapshot, {
    id: 'expense',
    kind: 'expense',
    accountId: 'bank',
    date: '2026-01-02',
    amountMinor: 100,
    description: 'Compra QA',
    category: 'other',
    note: '',
  });
}
function planned(snapshot = accounts()) {
  return addPlan(snapshot, {
    id: 'plan',
    operation: prepareEntryOperation(snapshot, {
      id: 'planned-expense',
      kind: 'expense',
      accountId: 'bank',
      date: '2026-02-01',
      amountMinor: 100,
      description: 'Plan QA',
      category: 'other',
      note: '',
    }),
  });
}
function grouped() {
  return saveCreditCard(accounts(), {
    name: 'Tarjeta QA',
    statementDay: 20,
    paymentDay: 2,
    asOfDate: '2026-10-26',
    balances: [
      { accountId: 'card-dop', currency: 'DOP', creditLimitMinor: 10000 },
      { accountId: 'card-usd', currency: 'USD', creditLimitMinor: 1000 },
    ],
  });
}

describe('financial account removal', () => {
  it('previews and removes only an unlinked ordinary account without changing input or other history', () => {
    const before = planned(expense());
    const untouched = structuredClone(before);
    expect(getAccountRemoval(before, 'cash')).toEqual({ name: 'Efectivo QA', accountIds: ['cash'], operationCount: 0, planCount: 0, canDelete: true });
    const after = removeFinancialAccount(before, 'cash', 'Efectivo QA');
    expect(before).toEqual(untouched);
    expect(after.financialSpace.accounts).toEqual(before.financialSpace.accounts.filter(a => a.id !== 'cash'));
    expect(after.financialSpace.operations).toEqual(before.financialSpace.operations);
    expect(after.financialSpace.plans).toEqual(before.financialSpace.plans);
  });

  it('requires an exact current name and an existing id, including on repeated deletion', () => {
    const before = accounts();
    for (const confirmation of ['', 'Banco QA ', 'banco QA', 'Efectivo QA'])
      expect(() => removeFinancialAccount(before, 'bank', confirmation)).toThrow(/nombre exacto/);
    expect(() => getAccountRemoval(before, 'missing')).toThrow(/no está disponible/);
    expect(() => removeFinancialAccount(before, 'missing', 'Banco QA')).toThrow(/no está disponible/);
    const after = removeFinancialAccount(before, 'bank', 'Banco QA');
    expect(() => removeFinancialAccount(after, 'bank', 'Banco QA')).toThrow(/no está disponible/);
  });

  it('removes an entire grouped card from either currency without touching other accounts', () => {
    const before = grouped();
    for (const selected of ['card-dop', 'card-usd']) {
      expect(getAccountRemoval(before, selected)).toEqual({
        name: 'Tarjeta QA',
        accountIds: ['card-dop', 'card-usd'],
        operationCount: 0,
        planCount: 0,
        canDelete: true,
      });
      const after = removeFinancialAccount(before, selected, 'Tarjeta QA');
      expect(after.financialSpace.accounts).toEqual(before.financialSpace.accounts.filter(a => a.type !== 'credit'));
      expect(after.financialSpace.operations).toEqual(before.financialSpace.operations);
      expect(after.financialSpace.plans).toEqual(before.financialSpace.plans);
    }
    expect(getAccountRemoval(accounts(), 'card-dop').accountIds).toEqual(['card-dop']);
  });

  it('never cascades linked income or expense operations', () => {
    for (const kind of ['income', 'expense'] as const) {
      const before = addEntry(accounts(), {
        id: kind,
        kind,
        accountId: 'bank',
        date: '2026-01-02',
        amountMinor: 100,
        description: 'QA',
        category: 'other',
        note: '',
      });
      expect(getAccountRemoval(before, 'bank')).toMatchObject({ canDelete: false, operationCount: 1 });
      expect(() => removeFinancialAccount(before, 'bank', 'Banco QA')).toThrow(/historial/);
    }
  });

  it('protects both ends of transfers and card payments, including a whole credit group', () => {
    const transfer = addPairedOperation(accounts(), {
      id: 'transfer',
      kind: 'transfer',
      fromAccountId: 'bank',
      toAccountId: 'cash',
      date: '2026-01-02',
      amountMinor: 100,
      description: 'QA',
      note: '',
    });
    for (const id of ['bank', 'cash']) expect(getAccountRemoval(transfer, id)).toMatchObject({ canDelete: false, operationCount: 1 });
    const payment = addPairedOperation(grouped(), {
      id: 'payment',
      kind: 'card-payment',
      fromAccountId: 'bank',
      toAccountId: 'card-dop',
      date: '2026-10-26',
      amountMinor: 100,
      description: 'QA',
      note: '',
    });
    expect(getAccountRemoval(payment, 'bank').canDelete).toBe(false);
    expect(getAccountRemoval(payment, 'card-usd')).toMatchObject({ canDelete: false, operationCount: 1 });
    expect(() => removeFinancialAccount(payment, 'card-usd', 'Tarjeta QA')).toThrow(/historial/);
  });

  it('protects a refund destination and its original expense account independently', () => {
    const before = addRefund(expense(), {
      id: 'refund',
      originalExpenseId: 'expense',
      destinationAccountId: 'cash',
      date: '2026-01-03',
      amountMinor: 50,
      description: 'QA devolución',
      note: '',
    });
    expect(getAccountRemoval(before, 'bank')).toMatchObject({ operationCount: 2, canDelete: false });
    expect(getAccountRemoval(before, 'cash')).toMatchObject({ operationCount: 1, canDelete: false });
    expect(() => removeFinancialAccount(before, 'cash', 'Efectivo QA')).toThrow(/historial/);
  });

  it('protects pending, cancelled and confirmed plan references', () => {
    const pending = planned();
    const cancelled = resolvePlan(pending, { type: 'cancel', planId: 'plan', date: '2026-01-20' });
    const confirmed = resolvePlan(pending, { type: 'confirm', planId: 'plan', date: '2026-02-01' });
    for (const snapshot of [pending, cancelled, confirmed]) {
      expect(getAccountRemoval(snapshot, 'bank')).toMatchObject({ planCount: 1, canDelete: false });
      expect(() => removeFinancialAccount(snapshot, 'bank', 'Banco QA')).toThrow(/historial/);
    }
  });
});
