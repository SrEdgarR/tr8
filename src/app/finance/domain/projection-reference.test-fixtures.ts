/** Test-only pinned-source reference before TR8's date sweep optimization. */
import { normalizeFinancialAccounts } from './accounts';
import { normalizeFinancialOperations } from './operations';
import type { CurrencyDefinition, FinancialAccountBalance, FinancialBalances } from './types';
import { requireDate, safeMinor } from './validation';
import { summarizeBalances } from './balances';

export function referenceFinancialBalances(
  accountInput: unknown,
  operationInput: unknown,
  asOf: string,
  currencies: readonly CurrencyDefinition[],
): FinancialBalances {
  const date = requireDate(asOf);
  const accounts = normalizeFinancialAccounts(accountInput, currencies);
  const operations = normalizeFinancialOperations(operationInput, accounts, currencies);
  if (accounts.some(({ openingDate }) => openingDate > date)) {
    throw new Error('No se puede calcular un saldo anterior a su punto de partida.');
  }
  const accountById = new Map(accounts.map(account => [account.id, account]));
  const balances = new Map(accounts.map(account => [account.id, BigInt(account.openingBalanceMinor)]));
  const applyDelta = (accountId: string, delta: bigint, operationDate: string): void => {
    const account = accountById.get(accountId)!;
    if (operationDate < account.openingDate || operationDate > date) return;
    balances.set(accountId, balances.get(accountId)! + (account.type === 'credit' ? -delta : delta));
  };
  for (const operation of operations) {
    const amount = BigInt(operation.amountMinor);
    if (operation.kind === 'income' || operation.kind === 'expense') {
      applyDelta(operation.accountId, operation.kind === 'income' ? amount : -amount, operation.date);
    } else if (operation.kind === 'refund') {
      applyDelta(operation.destinationAccountId, amount, operation.date);
    } else {
      applyDelta(operation.fromAccountId, -amount, operation.date);
      applyDelta(operation.toAccountId, amount, operation.date);
    }
  }
  const accountBalances: FinancialAccountBalance[] = accounts.map(account => {
    const balance = balances.get(account.id)!;
    return {
      accountId: account.id,
      type: account.type,
      currency: account.currency,
      balanceMinor: safeMinor(balance),
      ...(account.type === 'credit'
        ? {
            availableCreditMinor: safeMinor(maximumZero(BigInt(account.creditLimitMinor) - balance)),
          }
        : {}),
    };
  });
  return {
    date,
    accounts: accountBalances,
    currencies: summarizeBalances(accountBalances),
  };
}

function maximumZero(value: bigint): bigint {
  return value < BigInt(0) ? BigInt(0) : value;
}
import { requireRecord } from './validation';

export interface FinancialProjection {
  targetDate: string;
  current: FinancialBalances;
  projected: FinancialBalances;
  points: (FinancialBalances & { phase: 'actual' | 'projected' })[];
}

// Simulates explicitly supplied plans only; it never confirms or persists them.
export function referenceFinancialProjection(candidate: unknown, currencies: readonly CurrencyDefinition[]): FinancialProjection {
  const input = requireRecord(candidate);
  const today = requireDate(input.today);
  const targetDate = requireDate(input.targetDate);
  if (targetDate < today) throw new Error('La fecha de proyección no puede ser anterior a hoy.');
  const accounts = normalizeFinancialAccounts(input.accounts, currencies);
  const confirmed = normalizeFinancialOperations(input.confirmedOperations, accounts, currencies);
  const planned = normalizeFinancialOperations(input.plannedOperations, accounts, currencies);
  // A repeated identifier is ambiguous even if one entry falls outside the horizon.
  normalizeFinancialOperations([...confirmed, ...planned], accounts, currencies);
  const futurePlans = planned.filter(({ date }) => date > today && date <= targetDate);
  const projectedOperations = [...confirmed, ...futurePlans];
  const current = referenceFinancialBalances(accounts, confirmed, today, currencies);
  const points: FinancialProjection['points'] = [{ ...current, phase: 'actual' }];
  const dates = new Set(projectedOperations.filter(({ date }) => date > today && date <= targetDate).map(({ date }) => date));
  if (targetDate > today) dates.add(targetDate);
  let projected = current;
  for (const date of [...dates].sort()) {
    projected = referenceFinancialBalances(accounts, projectedOperations, date, currencies);
    points.push({ ...projected, phase: 'projected' });
  }
  return { targetDate, current, projected, points };
}
