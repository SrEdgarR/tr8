import { createFinancialAccount } from './accounts';
import { validateFinancialSnapshot } from './snapshot';
import { validateFinancialSpace } from './workspace-validation';
import { closedRecord, financialText } from './workspace-records';
import { requireDate, requireMinor, requireRecord } from './validation';
import { calculateFinancialBalances } from './balances';
import { cardCycleDates } from './credit-cards';
import type { FinancialSnapshot } from './workspace-types';
import { validateCreditCardGroups } from './credit-card-grouping';
export { creditCardGroups, validateCreditCardGroups } from './credit-card-grouping';
export interface CreditCardDraft {
  id?: string;
  name: string;
  bankName?: string;
  statementDay: number;
  paymentDay: number;
  asOfDate: string;
  balances: { accountId?: string; currency: string; creditLimitMinor: number; totalDebtMinor?: number; statementPendingMinor?: number }[];
}
export function saveCreditCard(snapshot: FinancialSnapshot, draft: CreditCardDraft): FinancialSnapshot {
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  const input = closedRecord(draft, [
    'name',
    'statementDay',
    'paymentDay',
    'asOfDate',
    'balances',
    ...(draft.id !== undefined ? ['id'] : []),
    ...(draft.bankName !== undefined ? ['bankName'] : []),
  ]);
  const name = financialText(input.name, 120),
    bankName = input.bankName === undefined ? undefined : financialText(input.bankName, 120),
    asOfDate = requireDate(input.asOfDate);
  const groupId = draft.id === undefined ? crypto.randomUUID() : financialText(draft.id, 128);
  const dates = cardCycleDates(asOfDate, draft.statementDay, draft.paymentDay);
  if (!Array.isArray(input.balances) || !input.balances.length || input.balances.length > space.currencyDefinitions.length)
    throw Error('Añade al menos una moneda a la tarjeta.');
  const current = calculateFinancialBalances(space.accounts, space.operations, asOfDate, space.currencyDefinitions);
  const currencies = new Set<string>(),
    accountIds = new Set<string>();
  const updated = input.balances.map(raw => {
    const r = requireRecord(raw);
    const row = closedRecord(r, [
      'currency',
      'creditLimitMinor',
      ...(r.accountId !== undefined ? ['accountId'] : []),
      ...(r.totalDebtMinor !== undefined ? ['totalDebtMinor'] : []),
      ...(r.statementPendingMinor !== undefined ? ['statementPendingMinor'] : []),
    ]);
    const currency = financialText(row.currency, 10);
    if (currencies.has(currency)) throw Error('Cada moneda solo puede aparecer una vez en la tarjeta.');
    currencies.add(currency);
    const previous = row.accountId === undefined ? undefined : space.accounts.find(a => a.id === row.accountId);
    if (row.accountId !== undefined && (!previous || previous.type !== 'credit')) throw Error('Selecciona un saldo de tarjeta existente.');
    if (previous && previous.type === 'credit' && (previous.currency !== currency || (previous.creditCard && previous.creditCard.id !== groupId)))
      throw Error('Ese saldo ya pertenece a otra tarjeta o utiliza otra moneda.');
    const id = previous?.id ?? crypto.randomUUID();
    if (accountIds.has(id)) throw Error('El saldo de tarjeta está duplicado.');
    accountIds.add(id);
    const limit = requireMinor(row.creditLimitMinor);
    if (limit < 0) throw Error('El límite no puede ser negativo.');
    const total = previous ? current.accounts.find(a => a.accountId === id)!.balanceMinor : requireMinor(row.totalDebtMinor);
    if (previous && row.totalDebtMinor !== undefined && row.totalDebtMinor !== total)
      throw Error('La deuda actual se calcula a partir del historial; no se sustituye al agrupar cuentas.');
    const pending = row.statementPendingMinor === undefined ? undefined : requireMinor(row.statementPendingMinor);
    if (pending !== undefined && (pending < 0 || pending > Math.max(0, total)))
      throw Error('El pendiente del corte debe estar entre cero y la deuda total actual.');
    const baseline =
      pending === undefined
        ? undefined
        : {
            asOfDate,
            statementDate: dates.lastStatementDate,
            statementDebtMinor: pending,
            statementPaidMinor: 0,
            includedOperationIds: space.operations.filter(o => o.date <= asOfDate).map(o => o.id),
          };
    return createFinancialAccount(
      {
        ...(previous ?? { id, currency, type: 'credit', openingDate: asOfDate, openingBalanceMinor: total }),
        name,
        ...(bankName ? { bankName } : {}),
        ...(bankName ? {} : { bankName: undefined }),
        creditLimitMinor: limit,
        creditCard: { id: groupId, statementDay: draft.statementDay, paymentDay: draft.paymentDay, ...(baseline ? { baseline } : {}) },
      },
      space.currencyDefinitions,
    );
  });
  for (const a of space.accounts)
    if (a.type === 'credit' && a.creditCard?.id === groupId && !accountIds.has(a.id)) throw Error('Conserva todos los saldos existentes de esta tarjeta.');
  const accounts = space.accounts.map(a => updated.find(n => n.id === a.id) ?? a);
  for (const a of updated) if (!space.accounts.some(old => old.id === a.id)) accounts.push(a);
  validateCreditCardGroups(accounts);
  return { schemaVersion: 1, financialSpace: validateFinancialSpace({ ...space, accounts }) };
}
