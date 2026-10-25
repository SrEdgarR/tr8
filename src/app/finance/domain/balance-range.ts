import type { FinancialAccount, FinancialOperation } from './types';
import { safeMinor } from './validation';

/** Validate every calendar-day closing balance, including dates hidden by later offsets. */
export function validateBalanceRange(accounts: readonly FinancialAccount[], operations: readonly FinancialOperation[]): void {
  const byId = new Map(accounts.map(account => [account.id, account]));
  const balances = new Map<string, bigint>();
  const events = [
    ...accounts.map(account => ({
      date: account.openingDate,
      changes: [[account.id, BigInt(account.openingBalanceMinor)]] as [string, bigint][],
    })),
    ...operations.map(operation => {
      const amount = BigInt(operation.amountMinor);
      const changes: [string, bigint][] =
        operation.kind === 'income' || operation.kind === 'expense'
          ? [[operation.accountId, operation.kind === 'income' ? amount : -amount]]
          : operation.kind === 'refund'
            ? [[operation.destinationAccountId, amount]]
            : [
                [operation.fromAccountId, -amount],
                [operation.toAccountId, amount],
              ];
      return {
        date: operation.date,
        changes: changes.map(([id, delta]) => [id, byId.get(id)!.type === 'credit' ? -delta : delta] as [string, bigint]),
      };
    }),
  ].sort((a, b) => a.date.localeCompare(b.date));
  for (let index = 0; index < events.length; index++) {
    for (const [id, delta] of events[index]!.changes) balances.set(id, (balances.get(id) ?? BigInt(0)) + delta);
    if (events[index + 1]?.date === events[index]!.date) continue;
    const currencies = new Map<string, { liquid: bigint; debt: bigint; credit: bigint }>();
    for (const [id, balance] of balances) {
      safeMinor(balance);
      const account = byId.get(id)!;
      const summary = currencies.get(account.currency) ?? {
        liquid: BigInt(0),
        debt: BigInt(0),
        credit: BigInt(0),
      };
      if (account.type === 'credit') {
        const available = BigInt(account.creditLimitMinor) - balance;
        const credit = available > BigInt(0) ? available : BigInt(0);
        safeMinor(credit);
        summary.debt += balance;
        summary.credit += credit;
      } else summary.liquid += balance;
      currencies.set(account.currency, summary);
    }
    for (const { liquid, debt, credit } of currencies.values()) for (const value of [liquid, debt, credit, liquid - debt, liquid + credit]) safeMinor(value);
  }
}
