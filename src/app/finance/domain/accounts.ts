import { validateCreditCardMetadata } from './credit-cards';
import type { CurrencyDefinition, FinancialAccount } from './types';
import { requireCurrency, requireCurrencyDefinitions, requireDate, requireMinor, requireRecord, requireText } from './validation';

export function createFinancialAccount(candidate: unknown, currencies: readonly CurrencyDefinition[]): FinancialAccount {
  const input = requireRecord(candidate);
  return normalizeFinancialAccount(
    {
      ...input,
      currency: input.currency === undefined ? 'DOP' : input.currency,
    },
    currencies,
  );
}

export function normalizeFinancialAccount(candidate: unknown, currencies: readonly CurrencyDefinition[]): FinancialAccount {
  const input = requireRecord(candidate);
  const base = {
    id: requireText(input.id),
    name: requireText(input.name),
    ...(input.bankName === undefined ? {} : { bankName: requireText(input.bankName) }),
    currency: requireCurrency(input.currency, requireCurrencyDefinitions(currencies)),
    openingBalanceMinor: requireMinor(input.openingBalanceMinor),
    openingDate: requireDate(input.openingDate),
  };
  if (input.type === 'debit' || input.type === 'cash') {
    return { ...base, type: input.type };
  }
  if (input.type === 'credit') {
    const creditLimitMinor = requireMinor(input.creditLimitMinor);
    if (creditLimitMinor < 0) throw new Error('El límite de crédito no puede ser negativo.');
    return {
      ...base,
      type: 'credit',
      creditLimitMinor,
      ...(input.creditCard === undefined ? {} : { creditCard: validateCreditCardMetadata(input.creditCard) }),
    };
  }
  throw new Error('Selecciona una cuenta de débito, efectivo o tarjeta.');
}

export function normalizeFinancialAccounts(candidate: unknown, currencies: readonly CurrencyDefinition[]): FinancialAccount[] {
  requireCurrencyDefinitions(currencies);
  if (!Array.isArray(candidate)) throw new Error('La lista de cuentas no es válida.');
  const accounts = Array.from(candidate, account => normalizeFinancialAccount(account, currencies));
  if (new Set(accounts.map(({ id }) => id)).size !== accounts.length) {
    throw new Error('Las cuentas deben tener identificadores distintos.');
  }
  return accounts;
}
