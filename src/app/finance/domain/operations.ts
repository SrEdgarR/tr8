import { normalizeFinancialAccounts } from './accounts';
import type { CurrencyDefinition, FinancialAccount, FinancialOperation } from './types';
import { requireCurrency, requireCurrencyDefinitions, requireDate, requireMinor, requireRecord, requireText } from './validation';

/** Call on a normalized ledger operation. Both legs belong to one logical payment. */
export function operationDestinationAmount(operation: FinancialOperation): number {
  if (operation.kind !== 'card-payment') return operation.amountMinor;
  const crossCurrency = Object.hasOwn(operation, 'destinationCurrency') || Object.hasOwn(operation, 'destinationAmountMinor');
  if (!crossCurrency) return operation.amountMinor;
  if (typeof operation.destinationCurrency !== 'string' || operation.destinationCurrency === operation.currency)
    throw new Error('El pago entre monedas necesita una moneda de destino distinta.');
  return requireMinor(operation.destinationAmountMinor, true);
}

export function operationDestinationCurrency(operation: FinancialOperation): string {
  operationDestinationAmount(operation);
  return operation.kind === 'card-payment' ? (operation.destinationCurrency ?? operation.currency) : operation.currency;
}

export function isCrossCurrencyPayment(operation: FinancialOperation): boolean {
  return operation.kind === 'card-payment' && operation.destinationCurrency !== undefined;
}

export function normalizeFinancialOperation(
  candidate: unknown,
  accounts: readonly FinancialAccount[],
  currencies: readonly CurrencyDefinition[],
): FinancialOperation {
  const availableAccounts = normalizeFinancialAccounts(accounts, currencies);
  const input = requireRecord(candidate);
  const base = {
    id: requireText(input.id),
    currency: requireCurrency(input.currency, requireCurrencyDefinitions(currencies)),
    amountMinor: requireMinor(input.amountMinor, true),
    date: requireDate(input.date),
  };
  const getAccount = (id: unknown, currency = base.currency): FinancialAccount => {
    const normalizedId = requireText(id);
    const account = availableAccounts.find(item => item.id === normalizedId);
    if (!account) throw new Error('La operación hace referencia a una cuenta inexistente.');
    if (account.currency !== currency) {
      throw new Error('La operación y sus cuentas deben tener la misma moneda.');
    }
    return account;
  };

  const hasDestinationCurrency = Object.hasOwn(input, 'destinationCurrency');
  const hasDestinationAmount = Object.hasOwn(input, 'destinationAmountMinor');
  const crossCurrency = hasDestinationCurrency || hasDestinationAmount;
  if (crossCurrency && (input.kind !== 'card-payment' || !hasDestinationCurrency || !hasDestinationAmount))
    throw new Error('El pago entre monedas necesita la moneda y el importe abonado a la tarjeta.');
  const destinationCurrency = crossCurrency ? requireCurrency(input.destinationCurrency, requireCurrencyDefinitions(currencies)) : base.currency;
  const destinationAmountMinor = crossCurrency ? requireMinor(input.destinationAmountMinor, true) : base.amountMinor;
  if (crossCurrency && destinationCurrency === base.currency) throw new Error('Los importes separados solo corresponden a pagos entre monedas distintas.');

  if (input.kind === 'income' || input.kind === 'expense') {
    return {
      ...base,
      kind: input.kind,
      accountId: getAccount(input.accountId).id,
    };
  }
  if (input.kind === 'refund') {
    return {
      ...base,
      kind: 'refund',
      originalExpenseId: requireText(input.originalExpenseId),
      destinationAccountId: getAccount(input.destinationAccountId).id,
    };
  }
  if (input.kind !== 'transfer' && input.kind !== 'card-payment') {
    throw new Error('El tipo de operación financiera no es válido.');
  }
  const fromAccount = getAccount(input.fromAccountId);
  const toAccount = getAccount(input.toAccountId, destinationCurrency);
  if (fromAccount.id === toAccount.id) {
    throw new Error('El origen y el destino deben ser cuentas distintas.');
  }
  if (fromAccount.type === 'credit') {
    throw new Error('TR8 no admite avances de efectivo desde tarjetas.');
  }
  if ((input.kind === 'card-payment') !== (toAccount.type === 'credit')) {
    throw new Error('El destino debe corresponder al tipo de transferencia o pago.');
  }
  return {
    ...base,
    kind: input.kind,
    fromAccountId: fromAccount.id,
    toAccountId: toAccount.id,
    ...(crossCurrency ? { destinationCurrency, destinationAmountMinor } : {}),
  };
}

export function normalizeFinancialOperations(
  candidate: unknown,
  accounts: readonly FinancialAccount[],
  currencies: readonly CurrencyDefinition[],
): FinancialOperation[] {
  normalizeFinancialAccounts(accounts, currencies);
  if (!Array.isArray(candidate)) throw new Error('La lista de operaciones no es válida.');
  const operations = Array.from(candidate, operation => normalizeFinancialOperation(operation, accounts, currencies));
  if (new Set(operations.map(({ id }) => id)).size !== operations.length) {
    throw new Error('Las operaciones deben tener identificadores distintos.');
  }
  const byId = new Map(operations.map(operation => [operation.id, operation]));
  const refunded = new Map<string, bigint>();
  for (const operation of operations) {
    if (operation.kind !== 'refund') continue;
    const expense = byId.get(operation.originalExpenseId);
    if (!expense || expense.kind !== 'expense' || expense.currency !== operation.currency || operation.date < expense.date)
      throw new Error('El reembolso debe corresponder a una compra existente, de la misma moneda y con fecha válida.');
    const total = (refunded.get(expense.id) ?? BigInt(0)) + BigInt(operation.amountMinor);
    if (total > BigInt(expense.amountMinor)) throw new Error('El reembolso supera el importe restante de la compra.');
    refunded.set(expense.id, total);
  }
  return operations;
}
