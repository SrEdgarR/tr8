import { describe, expect, it } from 'vitest';
import { addAccount, addEntry, emptyFinancialSnapshot, upgradeSnapshot } from './workspace';
import { addPairedOperation, preparePairedOperation } from './connected-operations';
import { saveCreditCard } from './credit-card-workspace';
import { creditCardCycleStatus, type CreditCardAccount } from './credit-cards';
import { aggregateFinancialActivityByCurrency, calculateFinancialBalances } from './balances';
import { calculatePaymentAvailability } from './payment-availability';
import { addPlan, filterHistory, projectSnapshot, resolvePlan } from './plans';
import { deleteFinancialOperation, updateFinancialOperation } from './operation-edit';
import { parseFinancialPlaintext, serializeFinancialPlaintext, validateFinancialSnapshot } from './snapshot';
import { validateWorkspaceOperation } from './workspace-operations';
import { parseAmountMinor } from './money';
import type { FinancialSnapshot } from './workspace-types';

function fixture() {
  let snapshot = emptyFinancialSnapshot();
  for (const [id, type, currency, openingBalanceMinor] of [
    ['savings-dop', 'debit', 'DOP', 2000000],
    ['savings-usd', 'debit', 'USD', 50000],
    ['card-dop', 'credit', 'DOP', 500000],
    ['card-usd', 'credit', 'USD', 30000],
  ] as const)
    snapshot = addAccount(snapshot, {
      id,
      name: id,
      type,
      currency,
      openingBalanceMinor,
      openingDate: '2026-10-01',
      ...(type === 'credit' ? { creditLimitMinor: 1000000 } : {}),
    });
  return saveCreditCard(snapshot, {
    id: 'dual-card',
    name: 'Tarjeta de prueba',
    statementDay: 20,
    paymentDay: 2,
    asOfDate: '2026-10-26',
    balances: [
      { accountId: 'card-dop', currency: 'DOP', creditLimitMinor: 1000000, statementPendingMinor: 400000 },
      { accountId: 'card-usd', currency: 'USD', creditLimitMinor: 100000, statementPendingMinor: 20000 },
    ],
  });
}
const draft = (overrides: Record<string, unknown> = {}) => ({
  id: 'fx-payment',
  kind: 'card-payment',
  fromAccountId: 'savings-dop',
  toAccountId: 'card-usd',
  currency: 'DOP',
  amountMinor: 600000,
  destinationCurrency: 'USD',
  destinationAmountMinor: 10000,
  date: '2026-10-30',
  description: 'Pago del corte USD desde ahorros DOP',
  note: '',
  ...overrides,
});
function input(overrides: Record<string, unknown> = {}) {
  const { currency: _currency, ...value } = draft(overrides);
  void _currency;
  return value;
}
function cycle(snapshot: FinancialSnapshot, accountId = 'card-usd', asOf = '2026-10-30') {
  const account = snapshot.financialSpace.accounts.find(account => account.id === accountId) as CreditCardAccount;
  return creditCardCycleStatus(account, snapshot.financialSpace.operations, asOf);
}
function balances(snapshot: FinancialSnapshot, asOf = '2026-10-30') {
  const space = snapshot.financialSpace;
  return calculateFinancialBalances(space.accounts, space.operations, asOf, space.currencyDefinitions);
}
const savedOperation = (snapshot: FinancialSnapshot) => snapshot.financialSpace.operations.find(operation => operation.id === 'fx-payment')!;

describe('pago explícito del corte entre monedas', () => {
  it('prepara sin mutar ni subir versión; guarda ambas patas como un solo movimiento v5', () => {
    const before = fixture(),
      copy = structuredClone(before);
    expect(before.financialSpace.domainSchemaVersion).toBe(4);
    expect(preparePairedOperation(before, input())).toEqual(draft());
    expect(before).toEqual(copy);
    const after = addPairedOperation(before, input());
    expect(after.financialSpace.domainSchemaVersion).toBe(5);
    expect(after.financialSpace.operations).toEqual([draft()]);
    expect(after.financialSpace.accounts).toEqual(before.financialSpace.accounts);
    expect(after.financialSpace.plans).toEqual(before.financialSpace.plans);
    expect(balances(after).accounts.map(account => [account.accountId, account.balanceMinor])).toEqual([
      ['savings-dop', 1400000],
      ['savings-usd', 50000],
      ['card-dop', 500000],
      ['card-usd', 20000],
    ]);
  });

  it('aplica el importe USD al corte más antiguo; conserva el consumo abierto y la otra moneda de la tarjeta', () => {
    const before = fixture(),
      after = addPairedOperation(before, input());
    expect(cycle(after)).toMatchObject({
      totalDebtMinor: 20000,
      statementPendingMinor: 10000,
      unbilledDebtMinor: 10000,
      nextPaymentAmountMinor: 10000,
      paymentDate: '2026-11-02',
      paymentStatus: 'pending',
    });
    expect(cycle(after, 'card-dop')).toEqual(cycle(before, 'card-dop'));
    expect(balances(after).accounts.find(account => account.accountId === 'card-usd')?.availableCreditMinor).toBe(80000);
    const paid = addPairedOperation(before, input({ destinationAmountMinor: 20000, amountMinor: 1200000 }));
    expect(cycle(paid)).toMatchObject({ totalDebtMinor: 10000, statementPendingMinor: 0, unbilledDebtMinor: 10000, paymentStatus: 'paid' });
    expect(cycle(paid, 'card-usd', '2026-11-20')).toMatchObject({ statementPendingMinor: 10000, unbilledDebtMinor: 0, paymentDate: '2026-12-02' });
  });

  it('reduce el pago pendiente vencido sin marcar como pagada la deuda aún no abonada', () => {
    const after = addPairedOperation(fixture(), input({ date: '2026-11-04' }));
    expect(cycle(after, 'card-usd', '2026-11-04')).toMatchObject({ overdueMinor: 10000, paymentStatus: 'overdue', oldestUnpaidDueDate: '2026-11-02' });
  });

  it('no crea un gasto o ingreso adicional ni suma las monedas para estimar disponibilidad', () => {
    const after = addPairedOperation(fixture(), input()),
      space = after.financialSpace;
    expect(aggregateFinancialActivityByCurrency(space.accounts, space.operations, space.currencyDefinitions)).toEqual([]);
    const summaries = calculatePaymentAvailability(space.accounts, space.operations, '2026-10-30', space.currencyDefinitions);
    expect(summaries.find(summary => summary.currency === 'DOP')).toMatchObject({
      liquidMinor: 1400000,
      nextPaymentMinor: 400000,
      availableAfterPaymentMinor: 1000000,
    });
    expect(summaries.find(summary => summary.currency === 'USD')).toMatchObject({
      liquidMinor: 50000,
      nextPaymentMinor: 10000,
      availableAfterPaymentMinor: 40000,
      unbilledDebtMinor: 10000,
    });
  });

  it('conserva centavos explícitos sin recalcularlos mediante coma flotante ni inferir una tasa', () => {
    const after = addPairedOperation(fixture(), input({ amountMinor: parseAmountMinor('7345.67', 2), destinationAmountMinor: parseAmountMinor('123.45', 2) }));
    expect(savedOperation(after)).toMatchObject({ amountMinor: 734567, destinationAmountMinor: 12345 });
    expect(balances(after).accounts.find(account => account.accountId === 'card-usd')?.balanceMinor).toBe(17655);
    expect(cycle(after).statementPendingMinor).toBe(7655);
  });

  it('muestra un único pago al filtrar por cualquiera de sus monedas o cuentas', () => {
    const after = addPairedOperation(fixture(), input());
    for (const filters of [{ currency: 'DOP' }, { currency: 'USD' }, { accountId: 'savings-dop' }, { accountId: 'card-usd' }])
      expect(filterHistory(after, filters).map(operation => operation.id)).toEqual(['fx-payment']);
    expect(filterHistory(after, { currency: 'EUR' })).toEqual([]);
  });

  it.each([0, -1, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('rechaza abonos USD inválidos: %s', amount => {
    expect(() => addPairedOperation(fixture(), input({ destinationAmountMinor: amount }))).toThrow();
  });

  it('rechaza metadatos incompletos, cambio implícito y monedas o cuentas incompatibles', () => {
    const before = fixture();
    const missingCurrency = input();
    delete (missingCurrency as Record<string, unknown>).destinationCurrency;
    const missingAmount = input();
    delete (missingAmount as Record<string, unknown>).destinationAmountMinor;
    const noFx = input();
    delete (noFx as Record<string, unknown>).destinationCurrency;
    delete (noFx as Record<string, unknown>).destinationAmountMinor;
    for (const candidate of [
      missingCurrency,
      missingAmount,
      noFx,
      input({ destinationCurrency: 'DOP' }),
      input({ destinationCurrency: 'EUR' }),
      input({ destinationCurrency: 'USD', toAccountId: 'card-dop' }),
      input({ kind: 'transfer', toAccountId: 'savings-usd' }),
      input({ fromAccountId: 'card-dop' }),
      input({ toAccountId: 'savings-usd' }),
      input({ date: '2026-09-30' }),
    ])
      expect(() => addPairedOperation(before, candidate)).toThrow();
    expect(() => validateWorkspaceOperation(draft(), before.financialSpace.accounts, before.financialSpace.currencyDefinitions, 4)).toThrow(/versión 5/);
    expect(() => addPairedOperation(before, input({ destinationAmountMinor: Number.MAX_SAFE_INTEGER }))).toThrow();
  });

  it('mantiene pagos anteriores de una moneda sin reescribir su formato ni promover v4', () => {
    const original = input({ toAccountId: 'card-dop' });
    delete (original as Record<string, unknown>).destinationCurrency;
    delete (original as Record<string, unknown>).destinationAmountMinor;
    const after = addPairedOperation(fixture(), original);
    expect(after.financialSpace.domainSchemaVersion).toBe(4);
    expect(savedOperation(after)).not.toHaveProperty('destinationCurrency');
  });

  it('no permite que un cálculo directo del corte trate un importe DOP como USD si falta su abono explícito', () => {
    const before = fixture();
    const account = before.financialSpace.accounts.find(account => account.id === 'card-usd') as CreditCardAccount;
    const payment = preparePairedOperation(before, input());
    if (payment.kind !== 'card-payment') throw Error('Expected card payment');
    const partial = { ...payment };
    delete partial.destinationAmountMinor;
    expect(() => creditCardCycleStatus(account, [partial], '2026-10-30')).toThrow();
  });

  it('edita y elimina ambas patas de forma atómica, conservando movimientos y cuentas ajenos', () => {
    let before = fixture();
    before = addEntry(before, {
      id: 'other',
      kind: 'expense',
      accountId: 'savings-usd',
      amountMinor: 123,
      date: '2026-10-27',
      description: 'Otro gasto',
      category: 'other',
      note: '',
    });
    const after = addPairedOperation(before, input()),
      operation = savedOperation(after);
    const edited = updateFinancialOperation(after, operation, { ...operation, amountMinor: 900000, destinationAmountMinor: 15000 });
    expect(cycle(edited)).toMatchObject({ totalDebtMinor: 15000, statementPendingMinor: 5000, unbilledDebtMinor: 10000 });
    expect(balances(edited).accounts.find(account => account.accountId === 'savings-dop')?.balanceMinor).toBe(1100000);
    const removed = deleteFinancialOperation(edited, savedOperation(edited), '2026-10-30');
    expect(balances(removed)).toEqual(balances(before));
    expect(removed.financialSpace.operations).toEqual(before.financialSpace.operations);
    expect(removed.financialSpace.accounts).toEqual(before.financialSpace.accounts);
    expect(() => updateFinancialOperation(after, operation, { ...operation, destinationCurrency: 'DOP', toAccountId: 'card-dop' })).toThrow();
    expect(() => updateFinancialOperation(after, operation, { ...operation, amountMinor: 500, destinationAmountMinor: undefined })).toThrow();
  });

  it('mantiene las protecciones de corte capturado para corregir o eliminar un pago FX', () => {
    let after = addPairedOperation(fixture(), input());
    after = saveCreditCard(after, {
      id: 'dual-card',
      name: 'Tarjeta de prueba',
      statementDay: 20,
      paymentDay: 2,
      asOfDate: '2026-10-30',
      balances: [
        { accountId: 'card-dop', currency: 'DOP', creditLimitMinor: 1000000, statementPendingMinor: 400000 },
        { accountId: 'card-usd', currency: 'USD', creditLimitMinor: 100000, statementPendingMinor: 10000 },
      ],
    });
    const operation = savedOperation(after);
    expect(() => updateFinancialOperation(after, operation, { ...operation, destinationAmountMinor: 15000 })).toThrow(/saldo de corte/);
    expect(() => deleteFinancialOperation(after, operation, '2026-10-30')).toThrow(/saldo de corte/);
    expect(updateFinancialOperation(after, operation, { ...operation, note: 'Texto corregido' }).financialSpace.operations[0].note).toBe('Texto corregido');
  });

  it('simula y confirma planes FX una sola vez; su edición y eliminación siguen ligadas al plan', () => {
    const before = fixture(),
      operation = preparePairedOperation(before, input({ date: '2026-11-01' }));
    const planned = addPlan(before, { id: 'fx-plan', operation });
    expect(planned.financialSpace.domainSchemaVersion).toBe(5);
    expect(balances(planned)).toEqual(balances(before));
    const projected = projectSnapshot(planned, '2026-10-30', '2026-11-01');
    expect(projected.projected.accounts.find(account => account.accountId === 'card-usd')?.balanceMinor).toBe(20000);
    const confirmed = resolvePlan(planned, { type: 'confirm', planId: 'fx-plan', date: '2026-10-30' });
    expect(resolvePlan(confirmed, { type: 'confirm', planId: 'fx-plan', date: '2026-10-30' })).toBe(confirmed);
    const edited = updateFinancialOperation(confirmed, savedOperation(confirmed), { ...savedOperation(confirmed), destinationAmountMinor: 12345 });
    expect(edited.financialSpace.plans![0].operation).toMatchObject({ destinationAmountMinor: 12345 });
    const deleted = deleteFinancialOperation(edited, savedOperation(edited), '2026-10-30');
    expect(deleted.financialSpace.plans![0].status).toBe('cancelled');
    expect(balances(deleted)).toEqual(balances(before));
  });

  it('serializa y restaura v5 sin degradar ni perder los importes del pago', () => {
    const after = addPairedOperation(fixture(), input());
    expect(parseFinancialPlaintext(serializeFinancialPlaintext(after))).toEqual(after);
    expect(upgradeSnapshot(after)).toEqual(after);
    expect(validateFinancialSnapshot(after)).toEqual(after);
    const legacyTag = structuredClone(after);
    legacyTag.financialSpace.domainSchemaVersion = 4;
    expect(() => validateFinancialSnapshot(legacyTag)).toThrow();
  });
});
