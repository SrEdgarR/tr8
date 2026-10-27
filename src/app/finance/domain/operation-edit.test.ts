import { describe, expect, it } from 'vitest';
import { addAccount, addEntry, emptyFinancialSnapshot, prepareEntryOperation } from './workspace';
import { addPairedOperation, addRefund } from './connected-operations';
import { calculateFinancialBalances } from './balances';
import { deleteFinancialOperation, operationChangeInfo, updateFinancialOperation } from './operation-edit';
import { addPlan, resolvePlan } from './plans';
import { saveCreditCard } from './credit-card-workspace';
import { creditCardCycleStatus, type CreditCardAccount } from './credit-cards';
import type { FinancialSnapshot } from './workspace-types';

function fixture() {
  let s = emptyFinancialSnapshot();
  for (const [id, type, currency, balance] of [
    ['cash', 'cash', 'DOP', 100000],
    ['bank', 'debit', 'DOP', 50000],
    ['card', 'credit', 'DOP', 10000],
    ['usd', 'cash', 'USD', 20000],
  ] as const)
    s = addAccount(s, {
      id,
      name: id,
      type,
      currency,
      openingBalanceMinor: balance,
      openingDate: '2026-10-01',
      ...(type === 'credit' ? { creditLimitMinor: 50000 } : {}),
    });
  s = addEntry(s, {
    id: 'income',
    kind: 'income',
    accountId: 'cash',
    date: '2026-10-26',
    amountMinor: 1000,
    description: 'Ingreso QA',
    category: 'salary',
    note: '',
  });
  s = addEntry(s, {
    id: 'expense',
    kind: 'expense',
    accountId: 'card',
    date: '2026-10-26',
    amountMinor: 2000,
    description: 'Gasto QA',
    category: 'food',
    note: '',
  });
  s = addPairedOperation(s, {
    id: 'transfer',
    kind: 'transfer',
    fromAccountId: 'cash',
    toAccountId: 'bank',
    date: '2026-10-27',
    amountMinor: 500,
    description: 'Transferencia QA',
    note: '',
  });
  s = addPairedOperation(s, {
    id: 'payment',
    kind: 'card-payment',
    fromAccountId: 'bank',
    toAccountId: 'card',
    date: '2026-10-27',
    amountMinor: 1000,
    description: 'Pago QA',
    note: '',
  });
  s = addRefund(s, {
    id: 'refund',
    originalExpenseId: 'expense',
    destinationAccountId: 'card',
    date: '2026-10-28',
    amountMinor: 200,
    description: 'Reembolso QA',
    note: '',
  });
  return s;
}
const get = (s: FinancialSnapshot, id: string) => s.financialSpace.operations.find(o => o.id === id)!;
const balances = (s: FinancialSnapshot) =>
  calculateFinancialBalances(s.financialSpace.accounts, s.financialSpace.operations, '2026-11-01', s.financialSpace.currencyDefinitions).accounts.map(a => [
    a.accountId,
    a.balanceMinor,
  ]);
const captured = () =>
  saveCreditCard(fixture(), {
    id: 'card-group',
    name: 'Tarjeta QA',
    statementDay: 20,
    paymentDay: 2,
    asOfDate: '2026-10-28',
    balances: [{ accountId: 'card', currency: 'DOP', creditLimitMinor: 50000, statementPendingMinor: 8000 }],
  });

describe('edición y eliminación de movimientos', () => {
  it('edita ingreso y gasto sin cambiar identidad, apertura ni movimientos ajenos', () => {
    const original = fixture();
    const income = get(original, 'income');
    const edited = updateFinancialOperation(original, income, {
      ...income,
      amountMinor: 1700,
      accountId: 'bank',
      date: '2026-10-29',
      description: 'Ingreso corregido',
      category: 'freelance',
      note: 'Nota QA',
    });
    expect(get(edited, 'income')).toMatchObject({
      id: 'income',
      amountMinor: 1700,
      accountId: 'bank',
      category: 'freelance',
      description: 'Ingreso corregido',
    });
    expect(edited.financialSpace.accounts).toEqual(original.financialSpace.accounts);
    expect(edited.financialSpace.operations.filter(o => o.id !== 'income')).toEqual(original.financialSpace.operations.filter(o => o.id !== 'income'));
    expect(get(original, 'income')).toEqual(income);
    const expense = get(original, 'expense');
    const changed = updateFinancialOperation(original, expense, { ...expense, amountMinor: 3000 });
    expect(balances(changed)).toEqual([
      ['cash', 100500],
      ['bank', 49500],
      ['card', 11800],
      ['usd', 20000],
    ]);
  });
  it('edita y elimina una transferencia como una sola operación con sus dos efectos', () => {
    const original = fixture(),
      transfer = get(original, 'transfer');
    const edited = updateFinancialOperation(original, transfer, { ...transfer, amountMinor: 800 });
    expect(balances(edited)).toEqual([
      ['cash', 100200],
      ['bank', 49800],
      ['card', 10800],
      ['usd', 20000],
    ]);
    const removed = deleteFinancialOperation(original, transfer, '2026-10-29');
    expect(balances(removed)).toEqual([
      ['cash', 101000],
      ['bank', 49000],
      ['card', 10800],
      ['usd', 20000],
    ]);
    expect(removed.financialSpace.operations).toEqual(original.financialSpace.operations.filter(o => o.id !== 'transfer'));
  });
  it('recalcula ambas cuentas al corregir o retirar un pago de tarjeta', () => {
    const original = fixture(),
      payment = get(original, 'payment');
    expect(balances(updateFinancialOperation(original, payment, { ...payment, amountMinor: 2000 }))).toEqual([
      ['cash', 100500],
      ['bank', 48500],
      ['card', 9800],
      ['usd', 20000],
    ]);
    expect(balances(deleteFinancialOperation(original, payment, '2026-10-29'))).toEqual([
      ['cash', 100500],
      ['bank', 50500],
      ['card', 11800],
      ['usd', 20000],
    ]);
  });
  it('conserva referencias de reembolso y bloquea compras borradas, importes o fechas incompatibles', () => {
    const original = fixture(),
      expense = get(original, 'expense'),
      refund = get(original, 'refund');
    expect(() => deleteFinancialOperation(original, expense, '2026-10-29')).toThrow(/reembolsos vinculados/);
    expect(() => updateFinancialOperation(original, expense, { ...expense, amountMinor: 199 })).toThrow(/reembolso/);
    expect(() => updateFinancialOperation(original, expense, { ...expense, date: '2026-10-29' })).toThrow(/reembolso/);
    expect(() => updateFinancialOperation(original, refund, { ...refund, amountMinor: 2001 })).toThrow(/reembolso/);
    const changed = updateFinancialOperation(original, refund, { ...refund, amountMinor: 300 });
    expect(get(changed, 'refund')).toMatchObject({ originalExpenseId: 'expense', amountMinor: 300 });
    const withoutRefund = deleteFinancialOperation(original, refund, '2026-10-29');
    expect(deleteFinancialOperation(withoutRefund, get(withoutRefund, 'expense'), '2026-10-29').financialSpace.operations.map(o => o.id)).toEqual([
      'income',
      'transfer',
      'payment',
    ]);
  });
  it('actualiza atómicamente el plan confirmado y conserva su fecha programada original', () => {
    let original = fixture();
    original = addPlan(original, {
      id: 'plan',
      operation: prepareEntryOperation(original, {
        id: 'planned',
        kind: 'expense',
        accountId: 'cash',
        date: '2026-11-01',
        amountMinor: 400,
        description: 'Plan QA',
        category: 'other',
        note: '',
      }),
    });
    original = addPlan(original, {
      id: 'unrelated-plan',
      operation: prepareEntryOperation(original, {
        id: 'other-planned',
        kind: 'income',
        accountId: 'bank',
        date: '2026-11-02',
        amountMinor: 900,
        description: 'Plan conservado',
        category: 'salary',
        note: '',
      }),
    });
    original = resolvePlan(original, { type: 'confirm', planId: 'plan', date: '2026-10-28' });
    const planned = get(original, 'planned');
    const changed = updateFinancialOperation(original, planned, { ...planned, amountMinor: 600, date: '2026-10-29', note: 'corregido' });
    expect(changed.financialSpace.plans![0]).toMatchObject({
      id: 'plan',
      status: 'confirmed',
      resultOperationId: 'planned',
      resolvedDate: '2026-10-29',
      operation: { id: 'planned', date: '2026-11-01', amountMinor: 600, note: 'corregido' },
    });
    const removed = deleteFinancialOperation(original, planned, '2026-10-30');
    expect(removed.financialSpace.plans![0]).toEqual({
      id: 'plan',
      operation: original.financialSpace.plans![0].operation,
      status: 'cancelled',
      resolvedDate: '2026-10-30',
    });
    expect(removed.financialSpace.operations).toEqual(original.financialSpace.operations.filter(o => o.id !== 'planned'));
    expect(changed.financialSpace.plans![1]).toEqual(original.financialSpace.plans![1]);
    expect(removed.financialSpace.plans![1]).toEqual(original.financialSpace.plans![1]);
  });
  it('rechaza IDs, tipo, moneda, campos extras, cuentas incompatibles y fechas anteriores a apertura', () => {
    const original = fixture(),
      transfer = get(original, 'transfer'),
      income = get(original, 'income');
    for (const patch of [
      { id: 'new-id' },
      { kind: 'expense', accountId: 'cash' },
      { currency: 'USD', accountId: 'usd' },
      { amountMinor: 0 },
      { amountMinor: 1.5 },
      { extra: true },
      { date: '2026-09-30' },
    ])
      expect(() => updateFinancialOperation(original, income, { ...income, ...patch })).toThrow();
    expect(() => updateFinancialOperation(original, transfer, { ...transfer, toAccountId: 'cash' })).toThrow();
    expect(() => updateFinancialOperation(original, transfer, { ...transfer, toAccountId: 'card' })).toThrow();
    expect(() => updateFinancialOperation(original, transfer, { ...transfer, fromAccountId: 'card' })).toThrow();
  });
  it('rechaza editores o confirmaciones obsoletos sin sobrescribir el movimiento actual', () => {
    const original = fixture(),
      income = get(original, 'income');
    const updated = updateFinancialOperation(original, income, { ...income, description: 'Otro dispositivo' });
    expect(() => updateFinancialOperation(updated, income, { ...income, amountMinor: 500 })).toThrow(/cambió/);
    expect(() => deleteFinancialOperation(updated, income, '2026-10-29')).toThrow(/cambió/);
    const removed = deleteFinancialOperation(original, income, '2026-10-29');
    expect(() => deleteFinancialOperation(removed, income, '2026-10-29')).toThrow(/ya no/);
  });
  it('protege la captura de corte y permite correcciones de texto sin alterar deuda ni referencia', () => {
    const original = captured(),
      payment = get(original, 'payment');
    expect(operationChangeInfo(original, payment)).toMatchObject({ captured: true, capturedCardNames: ['Tarjeta QA'] });
    expect(() => deleteFinancialOperation(original, payment, '2026-10-29')).toThrow(/saldo de corte/);
    expect(() => updateFinancialOperation(original, payment, { ...payment, amountMinor: 1100 })).toThrow(/saldo de corte/);
    const edited = updateFinancialOperation(original, payment, { ...payment, description: 'Texto corregido' });
    expect(edited.financialSpace.accounts).toEqual(original.financialSpace.accounts);
    const account = edited.financialSpace.accounts.find(a => a.id === 'card') as CreditCardAccount;
    expect(creditCardCycleStatus(account, edited.financialSpace.operations, '2026-10-29')).toMatchObject({
      baselineKnown: true,
      statementPendingMinor: 8000,
      totalDebtMinor: 10800,
    });
  });
  it('retira referencias capturadas ajenas sin modificar la deuda ni los demás movimientos', () => {
    const original = captured(),
      income = get(original, 'income');
    const removed = deleteFinancialOperation(original, income, '2026-10-29');
    const before = original.financialSpace.accounts.find(a => a.id === 'card') as CreditCardAccount;
    const after = removed.financialSpace.accounts.find(a => a.id === 'card') as CreditCardAccount;
    expect(after.creditCard.baseline!.includedOperationIds).toEqual(before.creditCard.baseline!.includedOperationIds!.filter(id => id !== 'income'));
    expect(creditCardCycleStatus(after, removed.financialSpace.operations, '2026-10-29')).toEqual(
      creditCardCycleStatus(before, original.financialSpace.operations, '2026-10-29'),
    );
    expect(removed.financialSpace.operations).toEqual(original.financialSpace.operations.filter(o => o.id !== 'income'));
  });
  it('corrige pagos posteriores a captura y solicita reconciliar antes de llevarlos a la captura', () => {
    let original = addPairedOperation(captured(), {
      id: 'after',
      kind: 'card-payment',
      fromAccountId: 'bank',
      toAccountId: 'card',
      amountMinor: 1000,
      date: '2026-11-02',
      description: 'Pago siguiente',
      note: '',
    });
    const after = get(original, 'after');
    original = updateFinancialOperation(original, after, { ...after, amountMinor: 1500 });
    const card = original.financialSpace.accounts.find(a => a.id === 'card') as CreditCardAccount;
    expect(creditCardCycleStatus(card, original.financialSpace.operations, '2026-11-02')).toMatchObject({
      baselineKnown: true,
      statementPendingMinor: 6500,
      totalDebtMinor: 9300,
    });
    expect(() => updateFinancialOperation(original, get(original, 'after'), { ...get(original, 'after'), date: '2026-10-28' })).toThrow(/saldo de corte/);
    expect(
      creditCardCycleStatus(card, deleteFinancialOperation(original, get(original, 'after'), '2026-11-03').financialSpace.operations, '2026-11-02'),
    ).toMatchObject({ statementPendingMinor: 8000, totalDebtMinor: 10800 });
  });
});
