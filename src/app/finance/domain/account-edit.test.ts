import { describe, expect, it } from 'vitest';
import { addAccount, addEntry, emptyFinancialSnapshot, updateAccount } from './workspace';
import { addPlan } from './plans';
import { prepareEntryOperation } from './workspace';
const draft = { name: 'Cuenta QA', type: 'debit', currency: 'DOP', openingBalanceMinor: 10000, openingDate: '2026-01-01' };
const initial = () => addAccount(emptyFinancialSnapshot(), { id: 'account', ...draft });
describe('account metadata edits', () => {
  it('preserves ids, balances, operations and plans, and persists optional bank metadata', () => {
    const snapshot = addEntry(initial(), {
      id: 'income',
      kind: 'income',
      accountId: 'account',
      amountMinor: 1200,
      date: '2026-01-02',
      description: 'QA',
      note: '',
      category: 'salary',
    });
    const updated = updateAccount(snapshot, 'account', { ...draft, name: 'Renombrada', bankName: 'Banco QA' });
    expect(updated.financialSpace.accounts[0]).toEqual({ id: 'account', ...draft, name: 'Renombrada', bankName: 'Banco QA' });
    expect(updated.financialSpace.operations).toEqual(snapshot.financialSpace.operations);
    expect(updated.financialSpace.plans).toEqual(snapshot.financialSpace.plans);
    expect(() => updateAccount(snapshot, 'account', { ...draft, currency: 'USD' })).toThrow(/moneda/);
    expect(() => updateAccount(snapshot, 'account', { ...draft, type: 'cash' })).toThrow(/tipo/);
  });
  it('protects pending plans, accepts bank removal and rejects invalid edits', () => {
    const snapshot = addPlan(initial(), {
      id: 'plan',
      operation: prepareEntryOperation(initial(), {
        id: 'entry',
        kind: 'expense',
        accountId: 'account',
        amountMinor: 100,
        date: '2027-01-01',
        description: 'QA',
        note: '',
        category: 'other',
      }),
    });
    expect(() => updateAccount(snapshot, 'account', { ...draft, currency: 'USD' })).toThrow();
    expect(() => updateAccount(initial(), 'missing', draft)).toThrow();
    expect(() => updateAccount(initial(), 'account', { ...draft, bankName: 'x'.repeat(121) })).toThrow();
    const bank = updateAccount(initial(), 'account', { ...draft, bankName: 'Banco QA' });
    expect(updateAccount(bank, 'account', draft).financialSpace.accounts[0]).not.toHaveProperty('bankName');
    expect(() => updateAccount(initial(), 'account', { ...draft, id: 'changed' })).toThrow();
  });
});
