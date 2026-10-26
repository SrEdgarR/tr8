import { normalizeFinancialAccounts } from './accounts';
import { calculateFinancialBalances } from './balances';
import { creditCardCycleStatus } from './credit-cards';
import { normalizeFinancialOperations } from './operations';
import type { CurrencyDefinition, CurrencySummary } from './types';
import { safeMinor } from './validation';

export interface PaymentAvailability extends CurrencySummary {
  /** Outstanding closed statements, including past-due amounts. */
  nextPaymentMinor: number | null;
  /** Charges that have not yet reached a statement closing date. */
  unbilledDebtMinor: number | null;
  availableAfterPaymentMinor: number | null;
  missingAccountIds: string[];
  needsReconciliation: boolean;
}

/**
 * Cash remaining after currently billed card obligations, separately by
 * currency. This is a cash-planning figure; net worth still includes all debt.
 * Unknown statements invalidate the whole currency's planning figure rather
 * than silently treating an unconfigured card as paid.
 */
export function calculatePaymentAvailability(
  accountInput: unknown,
  operationInput: unknown,
  asOf: string,
  currencies: readonly CurrencyDefinition[],
): PaymentAvailability[] {
  const accounts = normalizeFinancialAccounts(accountInput, currencies);
  const operations = normalizeFinancialOperations(operationInput, accounts, currencies);
  const balances = calculateFinancialBalances(accounts, operations, asOf, currencies);
  const totals = new Map(
    balances.currencies.map(summary => [summary.currency, { payment: 0n, unbilled: 0n, missingAccountIds: [] as string[], needsReconciliation: false }]),
  );
  for (const account of accounts) {
    if (account.type !== 'credit') continue;
    const total = totals.get(account.currency)!;
    if (!account.creditCard) {
      total.missingAccountIds.push(account.id);
      continue;
    }
    const cycle = creditCardCycleStatus({ ...account, creditCard: account.creditCard }, operations, asOf);
    if (cycle.nextPaymentAmountMinor === null || cycle.unbilledDebtMinor === null) {
      total.missingAccountIds.push(account.id);
      total.needsReconciliation ||= cycle.needsReconciliation;
      continue;
    }
    total.payment += BigInt(cycle.nextPaymentAmountMinor);
    total.unbilled += BigInt(cycle.unbilledDebtMinor);
  }
  return balances.currencies.map(summary => {
    const total = totals.get(summary.currency)!;
    const known = total.missingAccountIds.length === 0;
    return {
      ...summary,
      nextPaymentMinor: known ? safeMinor(total.payment) : null,
      unbilledDebtMinor: known ? safeMinor(total.unbilled) : null,
      availableAfterPaymentMinor: known ? safeMinor(BigInt(summary.liquidMinor) - total.payment) : null,
      missingAccountIds: total.missingAccountIds,
      needsReconciliation: total.needsReconciliation,
    };
  });
}
