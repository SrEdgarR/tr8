import { normalizeFinancialAccounts } from './accounts';
import { normalizeFinancialOperations } from './operations';
import type {
  CurrencyActivity,
  CurrencyDefinition,
  CurrencySummary,
  FinancialAccount,
  FinancialOperation,
  FinancialAccountBalance,
  FinancialBalances,
} from './types';
import { requireDate, safeMinor } from './validation';

/** Internal normalized-ledger accumulator. Public boundaries normalize first. */
export function createNormalizedBalanceSweep(accounts: readonly FinancialAccount[]) {
  const accountById = new Map(accounts.map(account => [account.id, account]));
  const balances = new Map(accounts.map(account => [account.id, BigInt(account.openingBalanceMinor)]));
  const applyDelta = (id: string, delta: bigint, date: string): void => {
    const account = accountById.get(id);
    if (!account) throw new Error('La cuenta no existe.');
    if (date < account.openingDate) return;
    balances.set(id, balances.get(id)! + (account.type === 'credit' ? -delta : delta));
  };
  return {
    apply(operation: FinancialOperation): void {
      const amount = BigInt(operation.amountMinor);
      if (operation.kind === 'income' || operation.kind === 'expense')
        applyDelta(operation.accountId, operation.kind === 'income' ? amount : -amount, operation.date);
      else if (operation.kind === 'refund') applyDelta(operation.destinationAccountId, amount, operation.date);
      else {
        applyDelta(operation.fromAccountId, -amount, operation.date);
        applyDelta(operation.toAccountId, amount, operation.date);
      }
    },
    at(date: string): FinancialBalances {
      requireDate(date);
      if (accounts.some(account => account.openingDate > date)) throw new Error('No se puede calcular un saldo anterior a su punto de partida.');
      const accountBalances: FinancialAccountBalance[] = accounts.map(account => {
        const balance = balances.get(account.id)!;
        return {
          accountId: account.id,
          type: account.type,
          currency: account.currency,
          balanceMinor: safeMinor(balance),
          ...(account.type === 'credit' ? { availableCreditMinor: safeMinor(maximumZero(BigInt(account.creditLimitMinor) - balance)) } : {}),
        };
      });
      return { date, accounts: accountBalances, currencies: summarizeBalances(accountBalances) };
    },
  };
}

export function calculateFinancialBalances(
  accountInput: unknown,
  operationInput: unknown,
  asOf: string,
  currencies: readonly CurrencyDefinition[],
): FinancialBalances {
  const date = requireDate(asOf);
  const accounts = normalizeFinancialAccounts(accountInput, currencies);
  const operations = normalizeFinancialOperations(operationInput, accounts, currencies);
  const state = createNormalizedBalanceSweep(accounts);
  for (const operation of operations) if (operation.date <= date) state.apply(operation);
  return state.at(date);
}

// Activity uses only the supplied operations; transfers/payments do not create income or expense.
export function aggregateFinancialActivityByCurrency(
  accountInput: unknown,
  operationInput: unknown,
  currencies: readonly CurrencyDefinition[],
): CurrencyActivity[] {
  const accounts = normalizeFinancialAccounts(accountInput, currencies);
  const operations = normalizeFinancialOperations(operationInput, accounts, currencies);
  const totals = new Map<string, { income: bigint; expense: bigint }>();
  for (const operation of operations) {
    if (operation.kind !== 'income' && operation.kind !== 'expense') continue;
    const total = totals.get(operation.currency) ?? {
      income: BigInt(0),
      expense: BigInt(0),
    };
    total[operation.kind] += BigInt(operation.amountMinor);
    totals.set(operation.currency, total);
  }
  return [...totals].map(([currency, total]) => ({
    currency,
    incomeMinor: safeMinor(total.income),
    expenseMinor: safeMinor(total.expense),
  }));
}

export function summarizeBalances(accounts: readonly FinancialAccountBalance[]): CurrencySummary[] {
  const totals = new Map<string, { liquid: bigint; debt: bigint; credit: bigint }>();
  for (const account of accounts) {
    const total = totals.get(account.currency) ?? {
      liquid: BigInt(0),
      debt: BigInt(0),
      credit: BigInt(0),
    };
    if (account.type === 'credit') {
      total.debt += BigInt(account.balanceMinor);
      total.credit += BigInt(account.availableCreditMinor!);
    } else {
      total.liquid += BigInt(account.balanceMinor);
    }
    totals.set(account.currency, total);
  }
  return [...totals].map(([currency, total]) => ({
    currency,
    liquidMinor: safeMinor(total.liquid),
    creditDebtMinor: safeMinor(total.debt),
    availableCreditMinor: safeMinor(total.credit),
    netWorthMinor: safeMinor(total.liquid - total.debt),
    availableCapacityMinor: safeMinor(total.liquid + total.credit),
  }));
}

function maximumZero(value: bigint): bigint {
  return value < BigInt(0) ? BigInt(0) : value;
}
