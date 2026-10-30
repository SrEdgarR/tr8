import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from './categories';
import { normalizeFinancialOperation, normalizeFinancialOperations } from './operations';
import { closedRecord, financialText, collection } from './workspace-records';
import { validateBalanceRange } from './balance-range';
import type { CurrencyDefinition, FinancialAccount } from './types';

export function validateWorkspaceOperation(value: unknown, accounts: FinancialAccount[], definitions: readonly CurrencyDefinition[], domainVersion: number) {
  const kind = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'kind')?.value : undefined;
  const categorized = kind === 'income' || kind === 'expense';
  const refund = kind === 'refund';
  const hasDestinationFields =
    !!value && typeof value === 'object' && (Object.hasOwn(value, 'destinationCurrency') || Object.hasOwn(value, 'destinationAmountMinor'));
  if (refund && domainVersion < 3) throw new Error('Los reembolsos requieren la versión 3 del dominio.');
  if (hasDestinationFields && (kind !== 'card-payment' || domainVersion < 5))
    throw new Error('Los pagos entre monedas requieren la versión 5 del dominio financiero.');
  const entry = closedRecord(value, [
    'id',
    'currency',
    'amountMinor',
    'date',
    'kind',
    'description',
    'note',
    ...(categorized ? ['accountId', 'category'] : refund ? ['originalExpenseId', 'destinationAccountId'] : ['fromAccountId', 'toAccountId']),
    ...(hasDestinationFields ? ['destinationCurrency', 'destinationAmountMinor'] : []),
  ]);
  const operation = normalizeFinancialOperation(entry, accounts, definitions);
  const referenceFields = categorized ? ['accountId'] : refund ? ['originalExpenseId', 'destinationAccountId'] : ['fromAccountId', 'toAccountId'];
  for (const key of referenceFields) {
    const id = financialText(entry[key], 128);
    if (id.trim() !== id) throw new Error('La referencia de cuenta o compra no es válida.');
  }
  financialText(operation.id, 128);
  if (operation.id !== entry.id) throw new Error('El movimiento está duplicado o tiene un ID inválido.');
  const category = categorized ? entry.category : undefined;
  const allowed = kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  if (categorized && !allowed.includes(category as never)) throw new Error('La categoría no corresponde al movimiento.');
  const accountIds = categorized ? [entry.accountId] : refund ? [entry.destinationAccountId] : [entry.fromAccountId, entry.toAccountId];
  if (accounts.some(account => accountIds.includes(account.id) && operation.date < account.openingDate))
    throw new Error('La fecha no puede ser anterior al saldo inicial de la cuenta.');
  return {
    ...operation,
    description: financialText(entry.description),
    note: financialText(entry.note, 1024, true),
    ...(categorized ? { category: category as never } : {}),
  };
}

export function validateWorkspaceOperations(
  candidate: unknown,
  accounts: FinancialAccount[],
  definitions: readonly CurrencyDefinition[],
  domainVersion: number,
) {
  const operations = collection(candidate, 10000).map(value => validateWorkspaceOperation(value, accounts, definitions, domainVersion));
  const ids = new Set<string>();
  for (const operation of operations) {
    if (ids.has(operation.id)) throw new Error('El movimiento está duplicado.');
    ids.add(operation.id);
  }
  normalizeFinancialOperations(operations, accounts, definitions);
  validateBalanceRange(accounts, operations);
  return operations;
}
