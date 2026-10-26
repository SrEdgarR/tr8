import type { FinancialAccount, FinancialOperation } from './types';
import { closedRecord, collection, financialText } from './workspace-records';
import { requireDate, requireMinor, safeMinor } from './validation';

export interface CreditCardBaseline {
  asOfDate: string;
  statementDate: string;
  statementDebtMinor: number;
  statementPaidMinor: number;
  /** Ledger records already reflected in the captured statement balance. */
  includedOperationIds?: string[];
}

export interface CreditCardMetadata {
  id: string;
  statementDay: number;
  paymentDay: number;
  baseline?: CreditCardBaseline;
}

export type CreditCardAccount = Extract<FinancialAccount, { type: 'credit' }> & { creditCard: CreditCardMetadata };

export interface CreditCardCycleStatus {
  baselineKnown: boolean;
  needsReconciliation: boolean;
  totalDebtMinor: number;
  lastStatementDate: string;
  nextStatementDate: string;
  paymentDate: string;
  nextPaymentDate: string;
  statementPendingMinor: number | null;
  unbilledDebtMinor: number | null;
  overdueMinor: number | null;
  oldestUnpaidDueDate: string | null;
  nextPaymentAmountMinor: number | null;
  paymentStatus: 'unknown' | 'paid' | 'pending' | 'due-today' | 'overdue';
}

function day(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 31) throw new Error('El día debe estar entre 1 y 31.');
  return value;
}

function positiveMinor(value: unknown): number {
  const result = requireMinor(value);
  if (result < 0) throw new Error('La deuda y el importe pagado no pueden ser negativos.');
  return result;
}

function monthDate(year: number, month: number, requestedDay: number): string {
  const normalizedYear = year + Math.floor(month / 12);
  const normalizedMonth = ((month % 12) + 12) % 12;
  if (normalizedYear < 1 || normalizedYear > 9999) throw new Error('La fecha de la tarjeta está fuera del rango admitido.');
  const leap = normalizedYear % 4 === 0 && (normalizedYear % 100 !== 0 || normalizedYear % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][normalizedMonth];
  return `${String(normalizedYear).padStart(4, '0')}-${String(normalizedMonth + 1).padStart(2, '0')}-${String(Math.min(requestedDay, days)).padStart(2, '0')}`;
}

function parts(date: string): [number, number] {
  return [Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1];
}

/** The payment day is the first configured day strictly after the statement. */
function paymentAfter(statement: string, paymentDay: number): string {
  const [year, month] = parts(statement);
  const sameMonth = monthDate(year, month, paymentDay);
  return sameMonth > statement ? sameMonth : monthDate(year, month + 1, paymentDay);
}

/** Calendar dates only: no UTC conversions, implicit payments, holidays or FX. */
export function cardCycleDates(asOf: string, statementDay: number, paymentDay: number) {
  requireDate(asOf);
  day(statementDay);
  day(paymentDay);
  const [year, month] = parts(asOf);
  const thisMonth = monthDate(year, month, statementDay);
  const lastStatementDate = thisMonth <= asOf ? thisMonth : monthDate(year, month - 1, statementDay);
  const [statementYear, statementMonth] = parts(lastStatementDate);
  const nextStatementDate = monthDate(statementYear, statementMonth + 1, statementDay);
  return {
    lastStatementDate,
    nextStatementDate,
    paymentDate: paymentAfter(lastStatementDate, paymentDay),
    nextPaymentDate: paymentAfter(nextStatementDate, paymentDay),
  };
}

export function validateCreditCardMetadata(candidate: unknown): CreditCardMetadata {
  const hasBaseline = candidate && typeof candidate === 'object' && Object.hasOwn(candidate, 'baseline');
  const input = closedRecord(candidate, ['id', 'statementDay', 'paymentDay', ...(hasBaseline ? ['baseline'] : [])]);
  const result: CreditCardMetadata = {
    id: financialText(input.id, 128),
    statementDay: day(input.statementDay),
    paymentDay: day(input.paymentDay),
  };
  if (result.id !== result.id.trim()) throw new Error('La referencia de tarjeta no es válida.');
  if (hasBaseline) {
    const value = input.baseline;
    const hasIds = value && typeof value === 'object' && Object.hasOwn(value, 'includedOperationIds');
    const raw = closedRecord(value, ['asOfDate', 'statementDate', 'statementDebtMinor', 'statementPaidMinor', ...(hasIds ? ['includedOperationIds'] : [])]);
    const baseline: CreditCardBaseline = {
      asOfDate: requireDate(raw.asOfDate),
      statementDate: requireDate(raw.statementDate),
      statementDebtMinor: positiveMinor(raw.statementDebtMinor),
      statementPaidMinor: positiveMinor(raw.statementPaidMinor),
    };
    if (baseline.statementPaidMinor > baseline.statementDebtMinor) throw new Error('El pago del corte no puede superar su deuda.');
    if (baseline.statementDate !== cardCycleDates(baseline.asOfDate, result.statementDay, result.paymentDay).lastStatementDate)
      throw new Error('La deuda inicial debe corresponder al último corte.');
    if (hasIds) {
      baseline.includedOperationIds = collection(raw.includedOperationIds, 10000).map(value => {
        const id = financialText(value, 128);
        if (id !== id.trim()) throw new Error('La referencia de movimiento no es válida.');
        return id;
      });
      if (new Set(baseline.includedOperationIds).size !== baseline.includedOperationIds.length) throw new Error('La referencia de movimiento está duplicada.');
    }
    result.baseline = baseline;
  }
  return result;
}

function debtDelta(account: CreditCardAccount, operation: FinancialOperation): bigint | null {
  let direction: 1 | -1 | null = null;
  if ((operation.kind === 'income' || operation.kind === 'expense') && operation.accountId === account.id) direction = operation.kind === 'expense' ? 1 : -1;
  else if (operation.kind === 'refund' && operation.destinationAccountId === account.id) direction = -1;
  else if (operation.kind === 'transfer' || operation.kind === 'card-payment') {
    if (operation.toAccountId === account.id) direction = -1;
    else if (operation.fromAccountId === account.id) direction = 1;
  }
  if (direction === null) return null;
  if (operation.currency !== account.currency) throw new Error('Los movimientos de la tarjeta deben conservar su moneda.');
  requireDate(operation.date);
  const amount = requireMinor(operation.amountMinor);
  if (amount <= 0) throw new Error('El movimiento debe ser mayor que cero.');
  return BigInt(amount) * BigInt(direction);
}

/**
 * One currency pocket at a time. The existing ledger remains the source of total
 * debt; the captured bank statement supplies the historical split unavailable
 * from an opening balance created after that statement. Payments and credits
 * reduce the oldest unpaid statement before the unbilled balance. Advancing the
 * date only closes cycles; it never records or assumes a payment.
 */
export function creditCardCycleStatus(account: CreditCardAccount, operations: readonly FinancialOperation[], asOf: string): CreditCardCycleStatus {
  requireDate(asOf);
  requireDate(account.openingDate);
  if (account.type !== 'credit' || asOf < account.openingDate) throw new Error('La tarjeta no tiene un saldo inicial para esa fecha.');
  const metadata = validateCreditCardMetadata(account.creditCard);
  const related = operations.flatMap(operation => {
    const delta = debtDelta(account, operation);
    return delta === null ? [] : [{ operation, delta }];
  });
  const balance = (include: (operation: FinancialOperation) => boolean) =>
    related.reduce((total, entry) => total + (include(entry.operation) ? entry.delta : 0n), BigInt(requireMinor(account.openingBalanceMinor)));
  const totalDebtMinor = safeMinor(balance(operation => operation.date <= asOf));
  const dates = cardCycleDates(asOf, metadata.statementDay, metadata.paymentDay);
  const unknown = (needsReconciliation: boolean): CreditCardCycleStatus => ({
    ...dates,
    baselineKnown: false,
    needsReconciliation,
    totalDebtMinor,
    statementPendingMinor: null,
    unbilledDebtMinor: null,
    overdueMinor: null,
    oldestUnpaidDueDate: null,
    nextPaymentAmountMinor: null,
    paymentStatus: 'unknown',
  });
  const baseline = metadata.baseline;
  if (!baseline || asOf < baseline.asOfDate) return unknown(false);
  if (baseline.asOfDate < account.openingDate) return unknown(true);
  const included = baseline.includedOperationIds ? new Set(baseline.includedOperationIds) : null;
  const knownIds = new Set(operations.map(operation => operation.id));
  if (included && [...included].some(id => !knownIds.has(id))) return unknown(true);
  const includedAtCapture = (operation: FinancialOperation) => operation.date <= baseline.asOfDate && (included ? included.has(operation.id) : true);
  const newEntries = related.filter(entry => entry.operation.date <= asOf && !includedAtCapture(entry.operation));
  if (newEntries.some(entry => entry.operation.date < baseline.asOfDate)) return unknown(true);
  if (baseline.asOfDate === baseline.statementDate && newEntries.some(entry => entry.operation.date === baseline.statementDate && entry.delta > 0n))
    return unknown(true);
  const capturedBalance = balance(includedAtCapture);
  const initialPending = BigInt(baseline.statementDebtMinor) - BigInt(baseline.statementPaidMinor);
  if (initialPending > (capturedBalance > 0n ? capturedBalance : 0n)) return unknown(true);
  const statements: { statementDate: string; dueDate: string; remaining: bigint }[] = [];
  if (initialPending > 0n)
    statements.push({ statementDate: baseline.statementDate, dueDate: paymentAfter(baseline.statementDate, metadata.paymentDay), remaining: initialPending });
  let unbilled = capturedBalance - initialPending;
  const sorted = [...newEntries].sort((a, b) => a.operation.date.localeCompare(b.operation.date));
  const operationById = new Map(operations.map(operation => [operation.id, operation]));
  let index = 0;
  function applyThrough(date: string) {
    while (index < sorted.length && sorted[index].operation.date <= date) {
      const { operation, delta } = sorted[index++];
      if (delta >= 0n) unbilled += delta;
      else {
        let credit = -delta;
        // A return belongs to the purchase's cycle. Refunding a new unbilled
        // charge cannot quietly mark an older bank statement as paid.
        const original = operation.kind === 'refund' ? operationById.get(operation.originalExpenseId) : undefined;
        if (original?.kind === 'expense' && original.accountId === account.id) {
          const target = statements.find(statement => statement.statementDate >= original.date);
          if (!target) {
            unbilled -= credit;
            continue;
          }
          const amount = target.remaining < credit ? target.remaining : credit;
          target.remaining -= amount;
          credit -= amount;
        }
        for (const statement of statements) {
          const amount = statement.remaining < credit ? statement.remaining : credit;
          statement.remaining -= amount;
          credit -= amount;
          if (credit === 0n) break;
        }
        unbilled -= credit;
      }
    }
  }
  let nextCut = cardCycleDates(baseline.asOfDate, metadata.statementDay, metadata.paymentDay).nextStatementDate;
  while (nextCut <= asOf) {
    // All records on the statement date are included in that day's closing.
    applyThrough(nextCut);
    if (unbilled > 0n) {
      statements.push({ statementDate: nextCut, dueDate: paymentAfter(nextCut, metadata.paymentDay), remaining: unbilled });
      unbilled = 0n;
    }
    const [year, month] = parts(nextCut);
    nextCut = monthDate(year, month + 1, metadata.statementDay);
  }
  applyThrough(asOf);
  const pending = statements.filter(statement => statement.remaining > 0n);
  const statementPending = pending.reduce((sum, statement) => sum + statement.remaining, 0n);
  const overdue = pending.reduce((sum, statement) => sum + (statement.dueDate < asOf ? statement.remaining : 0n), 0n);
  if (statementPending + unbilled !== BigInt(totalDebtMinor)) throw new Error('La deuda de la tarjeta no coincide con sus movimientos.');
  return {
    ...dates,
    baselineKnown: true,
    needsReconciliation: false,
    totalDebtMinor,
    statementPendingMinor: safeMinor(statementPending),
    unbilledDebtMinor: safeMinor(unbilled > 0n ? unbilled : 0n),
    overdueMinor: safeMinor(overdue),
    oldestUnpaidDueDate: pending[0]?.dueDate ?? null,
    nextPaymentAmountMinor: safeMinor(statementPending),
    paymentStatus: overdue > 0n ? 'overdue' : pending.some(statement => statement.dueDate === asOf) ? 'due-today' : statementPending > 0n ? 'pending' : 'paid',
  };
}
