import { normalizeFinancialAccounts } from './accounts';
import { createNormalizedBalanceSweep } from './balances';
import { normalizeFinancialOperations } from './operations';
import type { CurrencyDefinition, FinancialBalances } from './types';
import { requireDate, requireRecord } from './validation';

export interface FinancialProjection {
  targetDate: string;
  current: FinancialBalances;
  projected: FinancialBalances;
  points: (FinancialBalances & { phase: 'actual' | 'projected' })[];
}

// Simulates explicitly supplied plans only; it never confirms or persists them.
export function projectFinancialBalances(candidate: unknown, currencies: readonly CurrencyDefinition[]): FinancialProjection {
  const input = requireRecord(candidate);
  const today = requireDate(input.today);
  const targetDate = requireDate(input.targetDate);
  if (targetDate < today) throw new Error('La fecha de proyección no puede ser anterior a hoy.');
  const accounts = normalizeFinancialAccounts(input.accounts, currencies);
  const confirmed = normalizeFinancialOperations(input.confirmedOperations, accounts, currencies);
  const planned = normalizeFinancialOperations(input.plannedOperations, accounts, currencies);
  // A repeated identifier is ambiguous even if one entry falls outside the horizon.
  const confirmedIds = new Set(confirmed.map(operation => operation.id));
  if (planned.some(operation => confirmedIds.has(operation.id))) throw new Error('Las operaciones deben tener identificadores distintos.');
  const futurePlans = planned.filter(({ date }) => date > today && date <= targetDate);
  const projectedOperations = [...confirmed, ...futurePlans];
  const state = createNormalizedBalanceSweep(accounts);
  for (const operation of confirmed) if (operation.date <= today) state.apply(operation);
  const current = state.at(today);
  const points: FinancialProjection['points'] = [{ ...current, phase: 'actual' }];
  const dates = new Set(projectedOperations.filter(({ date }) => date > today && date <= targetDate).map(({ date }) => date));
  if (targetDate > today) dates.add(targetDate);
  const futureOperations = projectedOperations
    .filter(operation => operation.date > today && operation.date <= targetDate)
    .sort((left, right) => left.date.localeCompare(right.date));
  let cursor = 0;
  let projected = current;
  for (const date of [...dates].sort()) {
    while (cursor < futureOperations.length && futureOperations[cursor].date <= date) state.apply(futureOperations[cursor++]);
    projected = state.at(date);
    points.push({ ...projected, phase: 'projected' });
  }
  return { targetDate, current, projected, points };
}
