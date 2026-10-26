import type { FinancialAccount } from './types';
export function creditCardGroups(accounts: readonly FinancialAccount[]): FinancialAccount[][] {
  const result: FinancialAccount[][] = [],
    groups = new Map<string, FinancialAccount[]>();
  for (const account of accounts) {
    if (account.type !== 'credit' || !account.creditCard) {
      result.push([account]);
      continue;
    }
    let group = groups.get(account.creditCard.id);
    if (!group) {
      group = [];
      groups.set(account.creditCard.id, group);
      result.push(group);
    }
    group.push(account);
  }
  return result;
}
export function validateCreditCardGroups(accounts: readonly FinancialAccount[]): void {
  const seen = new Map<string, { statementDay: number; paymentDay: number; currencies: Set<string>; name: string; bankName?: string }>();
  for (const a of accounts)
    if (a.type === 'credit' && a.creditCard) {
      const meta = a.creditCard;
      const group = seen.get(meta.id);
      if (group) {
        if (
          group.statementDay !== meta.statementDay ||
          group.paymentDay !== meta.paymentDay ||
          group.currencies.has(a.currency) ||
          group.name !== a.name ||
          group.bankName !== a.bankName
        )
          throw Error('Los saldos de una tarjeta deben compartir nombre, banco y calendario, con una sola cuenta por moneda.');
        group.currencies.add(a.currency);
      } else
        seen.set(meta.id, {
          statementDay: meta.statementDay,
          paymentDay: meta.paymentDay,
          currencies: new Set([a.currency]),
          name: a.name,
          bankName: a.bankName,
        });
    }
}
