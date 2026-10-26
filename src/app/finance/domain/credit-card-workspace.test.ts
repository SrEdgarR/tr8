import { describe, expect, it } from 'vitest';
import { addAccount, addEntry, emptyFinancialSnapshot, prepareEntryOperation, updateAccount } from './workspace';
import { addPairedOperation } from './connected-operations';
import { addPlan } from './plans';
import { saveCreditCard } from './credit-card-workspace';
import { validateFinancialSnapshot } from './snapshot';

function creditAccount(snapshot: ReturnType<typeof emptyFinancialSnapshot>, id: string) {
  const account = snapshot.financialSpace.accounts.find(a => a.id === id);
  if (!account || account.type !== 'credit') throw new Error('Expected test credit account');
  return account;
}

const schedule = { name: 'Tarjeta QA', bankName: 'Banco QA', statementDay: 20, paymentDay: 2, asOfDate: '2026-10-26' };
function existing() {
  let snapshot = emptyFinancialSnapshot();
  for (const account of [
    { id: 'bank', name: 'Banco de pago', type: 'debit', currency: 'DOP', openingBalanceMinor: 100000, openingDate: '2026-10-01' },
    { id: 'card-dop', name: 'Anterior DOP', type: 'credit', currency: 'DOP', openingBalanceMinor: 25000, creditLimitMinor: 100000, openingDate: '2026-10-01' },
    { id: 'card-usd', name: 'Anterior USD', type: 'credit', currency: 'USD', openingBalanceMinor: 2000, creditLimitMinor: 10000, openingDate: '2026-10-01' },
  ])
    snapshot = addAccount(snapshot, account);
  snapshot = addEntry(snapshot, {
    id: 'bank-expense',
    kind: 'expense',
    accountId: 'bank',
    amountMinor: 100,
    date: '2026-10-25',
    description: 'QA',
    note: '',
    category: 'other',
  });
  snapshot = addPairedOperation(snapshot, {
    id: 'payment-today',
    kind: 'card-payment',
    fromAccountId: 'bank',
    toAccountId: 'card-dop',
    amountMinor: 1000,
    date: '2026-10-26',
    description: 'Pago ya incluido',
    note: '',
  });
  snapshot = addEntry(snapshot, {
    id: 'future-income',
    kind: 'income',
    accountId: 'bank',
    amountMinor: 100,
    date: '2026-10-27',
    description: 'QA futuro',
    note: '',
    category: 'other',
  });
  return addPlan(snapshot, {
    id: 'card-plan',
    operation: prepareEntryOperation(snapshot, {
      id: 'planned-card-expense',
      kind: 'expense',
      accountId: 'card-usd',
      amountMinor: 100,
      date: '2026-11-01',
      description: 'QA plan',
      note: '',
      category: 'other',
    }),
  });
}
const existingBalances = () => [
  { accountId: 'card-dop', currency: 'DOP', creditLimitMinor: 100000, statementPendingMinor: 15000 },
  { accountId: 'card-usd', currency: 'USD', creditLimitMinor: 10000, statementPendingMinor: 1000 },
];

describe('credit card workspace commands', () => {
  it('groups existing balances without changing account ids, opening points, operations, plans or its input', () => {
    const before = existing();
    const untouched = structuredClone(before);
    const after = saveCreditCard(before, { ...schedule, balances: existingBalances() });
    expect(before).toEqual(untouched);
    expect(after.financialSpace.accounts.map(a => a.id)).toEqual(before.financialSpace.accounts.map(a => a.id));
    expect(after.financialSpace.accounts[0]).toEqual(before.financialSpace.accounts[0]);
    for (const id of ['card-dop', 'card-usd']) {
      const previous = before.financialSpace.accounts.find(a => a.id === id)!;
      const account = after.financialSpace.accounts.find(a => a.id === id)!;
      expect(account.openingDate).toBe(previous.openingDate);
      expect(account.openingBalanceMinor).toBe(previous.openingBalanceMinor);
      expect(account.currency).toBe(previous.currency);
      expect(account.name).toBe(schedule.name);
      expect(account.bankName).toBe(schedule.bankName);
    }
    expect(after.financialSpace.operations).toEqual(before.financialSpace.operations);
    expect(after.financialSpace.plans).toEqual(before.financialSpace.plans);
    expect(validateFinancialSnapshot(after)).toEqual(after);
  });

  it('sets one card identity and one schedule while preserving independent per-currency limits', () => {
    const after = saveCreditCard(existing(), { ...schedule, balances: existingBalances() });
    const dop = creditAccount(after, 'card-dop');
    const usd = creditAccount(after, 'card-usd');
    expect(dop.creditCard?.id).toBeTruthy();
    expect(usd.creditCard?.id).toBe(dop.creditCard?.id);
    for (const account of [dop, usd]) expect(account.creditCard).toMatchObject({ statementDay: 20, paymentDay: 2 });
    expect(dop).toMatchObject({ currency: 'DOP', creditLimitMinor: 100000 });
    expect(usd).toMatchObject({ currency: 'USD', creditLimitMinor: 10000 });
  });

  it('captures already observed operations including today but excludes future movements from the baseline', () => {
    const after = saveCreditCard(existing(), { ...schedule, balances: existingBalances() });
    for (const account of after.financialSpace.accounts.filter(a => a.type === 'credit')) {
      expect(account.creditCard?.baseline?.asOfDate).toBe('2026-10-26');
      expect(account.creditCard?.baseline?.includedOperationIds).toEqual(['bank-expense', 'payment-today']);
      expect(account.creditCard?.baseline?.includedOperationIds).not.toContain('future-income');
    }
  });

  it('creates each new monetary balance with its declared current debt, never the statement debt twice', () => {
    const after = saveCreditCard(emptyFinancialSnapshot(), {
      ...schedule,
      balances: [
        { currency: 'DOP', creditLimitMinor: 100000, totalDebtMinor: 25000, statementPendingMinor: 10000 },
        { currency: 'USD', creditLimitMinor: 10000, totalDebtMinor: 1200, statementPendingMinor: 400 },
      ],
    });
    expect(after.financialSpace.accounts).toHaveLength(2);
    expect(new Set(after.financialSpace.accounts.map(a => a.id)).size).toBe(2);
    expect(after.financialSpace.accounts.map(a => a.openingBalanceMinor)).toEqual([25000, 1200]);
    expect(after.financialSpace.accounts.every(a => a.openingDate === '2026-10-26')).toBe(true);
    expect(after.financialSpace.operations).toEqual([]);
  });

  it('keeps an unknown statement as unknown instead of inventing that it has been paid', () => {
    const after = saveCreditCard(existing(), {
      ...schedule,
      balances: existingBalances().map(balance => ({ accountId: balance.accountId, currency: balance.currency, creditLimitMinor: balance.creditLimitMinor })),
    });
    for (const account of after.financialSpace.accounts.filter(a => a.type === 'credit')) expect(account.creditCard?.baseline).toBeUndefined();
  });

  it('rejects duplicate currencies, ordinary accounts and changing the currency of an existing balance', () => {
    expect(() =>
      saveCreditCard(existing(), { ...schedule, balances: [existingBalances()[0], { currency: 'DOP', creditLimitMinor: 10000, totalDebtMinor: 0 }] }),
    ).toThrow();
    expect(() => saveCreditCard(existing(), { ...schedule, balances: [{ accountId: 'bank', currency: 'DOP', creditLimitMinor: 10000 }] })).toThrow();
    expect(() => saveCreditCard(existing(), { ...schedule, balances: [{ accountId: 'card-dop', currency: 'USD', creditLimitMinor: 10000 }] })).toThrow();
  });

  it('requires total debt for a new balance and rejects invalid cycle dates', () => {
    expect(() => saveCreditCard(emptyFinancialSnapshot(), { ...schedule, balances: [{ currency: 'DOP', creditLimitMinor: 100000 }] })).toThrow();
    for (const statementDay of [0, 32, 1.5]) expect(() => saveCreditCard(existing(), { ...schedule, statementDay, balances: existingBalances() })).toThrow();
    for (const paymentDay of [0, 32, 1.5]) expect(() => saveCreditCard(existing(), { ...schedule, paymentDay, balances: existingBalances() })).toThrow();
  });

  it('does not remove an existing linked currency when editing a card', () => {
    const grouped = saveCreditCard(existing(), { ...schedule, balances: existingBalances() });
    const id = creditAccount(grouped, 'card-dop').creditCard!.id;
    expect(() => saveCreditCard(grouped, { ...schedule, id, balances: [existingBalances()[0]] })).toThrow();
  });
  it('does not strip a card link through the ordinary account editing command', () => {
    const grouped = saveCreditCard(existing(), { ...schedule, balances: existingBalances() });
    const a = creditAccount(grouped, 'card-dop');
    expect(() =>
      updateAccount(grouped, a.id, {
        name: 'Nombre aislado',
        type: a.type,
        currency: a.currency,
        bankName: a.bankName,
        openingBalanceMinor: a.openingBalanceMinor,
        openingDate: a.openingDate,
        creditLimitMinor: a.creditLimitMinor,
      }),
    ).toThrow();
  });
});
