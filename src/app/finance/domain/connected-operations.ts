import type { FinancialSnapshot } from './workspace-types';
import { validateFinancialSnapshot } from './snapshot';
import { closedRecord, validateFinancialSpace } from './workspace-validation';
import { requireDate, safeMinor } from './validation';
import { validateWorkspaceOperation } from './workspace-operations';

function append(snapshot: FinancialSnapshot, operation: unknown): FinancialSnapshot {
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  return {
    schemaVersion: 1,
    financialSpace: validateFinancialSpace({
      ...space,
      operations: [...space.operations, operation],
    }),
  };
}

/** Validated paired intent, without a fictitious real transfer/payment. */
export function preparePairedOperation(snapshot: FinancialSnapshot, candidate: unknown) {
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  const input = closedRecord(candidate, ['id', 'kind', 'fromAccountId', 'toAccountId', 'amountMinor', 'date', 'description', 'note']);
  if (input.kind !== 'transfer' && input.kind !== 'card-payment') throw new Error('Selecciona una transferencia o un pago de tarjeta.');
  const from = space.accounts.find(account => account.id === input.fromAccountId);
  if (!from) throw new Error('Selecciona una cuenta de origen.');
  return validateWorkspaceOperation({ ...input, currency: from.currency }, space.accounts, space.currencyDefinitions, space.domainSchemaVersion);
}

export function addPairedOperation(snapshot: FinancialSnapshot, candidate: unknown): FinancialSnapshot {
  return append(snapshot, preparePairedOperation(snapshot, candidate));
}

export function addRefund(snapshot: FinancialSnapshot, candidate: unknown): FinancialSnapshot {
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  const input = closedRecord(candidate, ['id', 'originalExpenseId', 'destinationAccountId', 'amountMinor', 'date', 'description', 'note']);
  const expense = space.operations.find(operation => operation.id === input.originalExpenseId && operation.kind === 'expense');
  if (!expense) throw new Error('Selecciona una compra confirmada.');
  return append(snapshot, {
    ...input,
    kind: 'refund',
    currency: expense.currency,
  });
}

export function remainingRefundMinor(snapshot: FinancialSnapshot, expenseId: string): number {
  const result = refundableExpenses(snapshot).find(entry => entry.expense.id === expenseId);
  if (!result) throw new Error('La compra no existe.');
  return result.remainingMinor;
}

export function refundableExpenses(snapshot: FinancialSnapshot) {
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  const totals = new Map<string, bigint>();
  for (const operation of space.operations)
    if (operation.kind === 'refund')
      totals.set(operation.originalExpenseId, (totals.get(operation.originalExpenseId) ?? BigInt(0)) + BigInt(operation.amountMinor));
  return space.operations
    .filter(operation => operation.kind === 'expense')
    .map(expense => ({
      expense,
      remainingMinor: safeMinor(BigInt(expense.amountMinor) - (totals.get(expense.id) ?? BigInt(0))),
    }));
}

/** DEC-039: correction belongs to the purchase period, effective only as of the refund date. */
export function summarizeRefundPeriod(snapshot: FinancialSnapshot, from: string, to: string, asOf: string, accountId?: string) {
  requireDate(from);
  requireDate(to);
  requireDate(asOf);
  if (from > to) throw new Error('El período no es válido.');
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  if (accountId && !space.accounts.some(account => account.id === accountId)) throw new Error('La cuenta no existe.');
  const totals = new Map<string, { income: bigint; expense: bigint; refunded: bigint }>();
  const refunded = new Map<string, bigint>();
  for (const operation of space.operations) {
    if (operation.kind === 'refund' && operation.date <= asOf)
      refunded.set(operation.originalExpenseId, (refunded.get(operation.originalExpenseId) ?? BigInt(0)) + BigInt(operation.amountMinor));
  }
  for (const operation of space.operations) {
    if (
      !['income', 'expense'].includes(operation.kind) ||
      operation.date < from ||
      operation.date > to ||
      operation.date > asOf ||
      (accountId && (!('accountId' in operation) || operation.accountId !== accountId))
    )
      continue;
    const total = totals.get(operation.currency) ?? {
      income: BigInt(0),
      expense: BigInt(0),
      refunded: BigInt(0),
    };
    if (operation.kind === 'income') total.income += BigInt(operation.amountMinor);
    else {
      total.expense += BigInt(operation.amountMinor);
      total.refunded += refunded.get(operation.id) ?? BigInt(0);
    }
    totals.set(operation.currency, total);
  }
  return [...totals].map(([currency, total]) => ({
    currency,
    incomeMinor: safeMinor(total.income),
    grossExpenseMinor: safeMinor(total.expense),
    refundedMinor: safeMinor(total.refunded),
    netExpenseMinor: safeMinor(total.expense - total.refunded),
  }));
}
