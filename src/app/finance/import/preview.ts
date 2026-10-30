import { encodeUtf8, isWellFormedUnicode, requireClosedRecord, vaultError } from '../compatibility/protocol';
import { CURRENCY_CATALOG, CURRENCY_CATALOG_VERSION, catalogDefinitions } from '../domain/catalog';

export interface ImportPreview {
  sourceDomainSchemaVersion: 1 | 2 | 3 | 4 | 5;
  targetDomainSchemaVersion: 4 | 5;
  sourceCurrencyCatalogVersion: string;
  targetCurrencyCatalogVersion: string;
  requiresUpgrade: boolean;
  accounts: number;
  operations: number;
  plans: number;
  currencies: string[];
}

/** Bounded metadata only. This module deliberately imports no KDF, key or plaintext. */
export function validateImportPreview(candidate: unknown): ImportPreview {
  const record = requireClosedRecord(candidate, [
    'sourceDomainSchemaVersion',
    'targetDomainSchemaVersion',
    'sourceCurrencyCatalogVersion',
    'targetCurrencyCatalogVersion',
    'requiresUpgrade',
    'accounts',
    'operations',
    'plans',
    'currencies',
  ]);
  if (
    ![1, 2, 3, 4, 5].includes(record.sourceDomainSchemaVersion as number) ||
    record.targetDomainSchemaVersion !== (record.sourceDomainSchemaVersion === 5 ? 5 : 4)
  )
    throw vaultError('INVALID_FORMAT');
  for (const field of ['sourceCurrencyCatalogVersion', 'targetCurrencyCatalogVersion']) {
    const value = record[field];
    if (typeof value !== 'string' || !isWellFormedUnicode(value) || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw vaultError('INVALID_FORMAT');
  }
  if (record.targetCurrencyCatalogVersion !== CURRENCY_CATALOG_VERSION) throw vaultError('INVALID_FORMAT');
  if (record.sourceDomainSchemaVersion === 1 && record.sourceCurrencyCatalogVersion !== 'pulso-p3-fixture-currencies-v1') throw vaultError('INVALID_FORMAT');
  try {
    catalogDefinitions(record.sourceCurrencyCatalogVersion as string);
  } catch {
    throw vaultError('INVALID_FORMAT');
  }
  const expectedUpgrade =
    record.sourceDomainSchemaVersion !== record.targetDomainSchemaVersion || record.sourceCurrencyCatalogVersion !== record.targetCurrencyCatalogVersion;
  if (record.requiresUpgrade !== expectedUpgrade) throw vaultError('INVALID_FORMAT');
  for (const [field, maximum] of [
    ['accounts', 1000],
    ['operations', 10_000],
    ['plans', 10_000],
  ] as const) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 0 || value > maximum) throw vaultError('INVALID_FORMAT');
  }
  if (
    !Array.isArray(record.currencies) ||
    record.currencies.length > CURRENCY_CATALOG.length ||
    record.currencies.length > Number(record.accounts) ||
    Object.getPrototypeOf(record.currencies) !== Array.prototype ||
    Reflect.ownKeys(record.currencies).length !== record.currencies.length + 1
  )
    throw vaultError('INVALID_FORMAT');
  const currencies: string[] = [];
  for (let index = 0; index < record.currencies.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(record.currencies, String(index));
    const currency = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (typeof currency !== 'string' || !CURRENCY_CATALOG.some(definition => definition.code === currency) || currencies.includes(currency))
      throw vaultError('INVALID_FORMAT');
    currencies.push(currency);
  }
  const result = {
    sourceDomainSchemaVersion: record.sourceDomainSchemaVersion as ImportPreview['sourceDomainSchemaVersion'],
    targetDomainSchemaVersion: record.targetDomainSchemaVersion as ImportPreview['targetDomainSchemaVersion'],
    sourceCurrencyCatalogVersion: record.sourceCurrencyCatalogVersion as string,
    targetCurrencyCatalogVersion: record.targetCurrencyCatalogVersion as string,
    requiresUpgrade: expectedUpgrade,
    accounts: record.accounts as number,
    operations: record.operations as number,
    plans: record.plans as number,
    currencies,
  };
  if (encodeUtf8(JSON.stringify(result)).byteLength > 16_384) throw vaultError('SIZE_LIMIT');
  return result;
}
