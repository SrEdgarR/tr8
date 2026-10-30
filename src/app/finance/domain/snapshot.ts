import { isLocalDate } from './dates';
import { MAX_PLAINTEXT_BYTES, decodeUtf8, encodeUtf8, isWellFormedUnicode, parseStrictJson, requireClosedRecord, vaultError } from '../compatibility/protocol';
import { validatePlaintext as validateGenericPlaintext } from '../crypto/plaintext';
const MAX_ACCOUNTS = 1000;
const MAX_OPERATIONS = 10000;
const PROTOTYPE_CURRENCY_CATALOG_VERSION = 'pulso-p3-fixture-currencies-v1';
import type { FinancialAccount, FinancialOperation } from './types';
import type { FinancialSnapshot } from './workspace-types';
export interface LegacyFinancialSnapshot {
  schemaVersion: 1;
  financialSpace: {
    domainSchemaVersion: 1;
    currencyCatalogVersion: 'pulso-p3-fixture-currencies-v1';
    currencyDefinitions: { code: 'DOP' | 'USD'; minorUnitDigits: 2 }[];
    accounts: FinancialAccount[];
    operations: Exclude<FinancialOperation, { kind: 'refund' }>[];
  };
}
export type FinancialPlaintext = FinancialSnapshot | LegacyFinancialSnapshot;
import { validateFinancialSpace } from './workspace-validation';

function text(value: unknown, maximumBytes: number, identifier = false): string {
  if (
    typeof value !== 'string' ||
    !isWellFormedUnicode(value) ||
    !value.trim() ||
    encodeUtf8(value).length > maximumBytes ||
    (identifier && value.trim() !== value)
  )
    throw vaultError('INVALID_PLAINTEXT');
  return value;
}

function integer(value: unknown, minimum?: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || (minimum !== undefined && value < minimum))
    throw vaultError('INVALID_PLAINTEXT');
  return value;
}

function date(value: unknown): void {
  if (typeof value !== 'string' || !isLocalDate(value)) throw vaultError('INVALID_PLAINTEXT');
}

function denseArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1)
    throw vaultError('INVALID_PLAINTEXT');
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) throw vaultError('INVALID_PLAINTEXT');
  }
  return value;
}

export function validateFinancialPlaintext(candidate: unknown): FinancialPlaintext {
  try {
    const safe = validateGenericPlaintext(candidate);
    const root = requireClosedRecord(safe, ['schemaVersion', 'financialSpace']);
    if (root.schemaVersion !== 1) throw vaultError('UNSUPPORTED_FORMAT');
    if (
      root.financialSpace &&
      typeof root.financialSpace === 'object' &&
      [2, 3, 4, 5].includes(Object.getOwnPropertyDescriptor(root.financialSpace, 'domainSchemaVersion')?.value)
    ) {
      const space = validateFinancialSpace(root.financialSpace);
      const result = { schemaVersion: 1 as const, financialSpace: space };
      if (encodeUtf8(JSON.stringify(result)).length > MAX_PLAINTEXT_BYTES) throw vaultError('SIZE_LIMIT');
      return result;
    }
    const space = requireClosedRecord(root.financialSpace, ['domainSchemaVersion', 'currencyCatalogVersion', 'currencyDefinitions', 'accounts', 'operations']);
    if (space.domainSchemaVersion !== 1 || space.currencyCatalogVersion !== PROTOTYPE_CURRENCY_CATALOG_VERSION) throw vaultError('UNSUPPORTED_FORMAT');
    const currencies = new Set<string>();
    for (const value of denseArray(space.currencyDefinitions, 2)) {
      const definition = requireClosedRecord(value, ['code', 'minorUnitDigits']);
      if (!['DOP', 'USD'].includes(definition.code as string) || definition.minorUnitDigits !== 2 || currencies.has(definition.code as string))
        throw vaultError('INVALID_PLAINTEXT');
      currencies.add(definition.code as string);
    }
    if (currencies.size !== 2) throw vaultError('INVALID_PLAINTEXT');
    const accounts = new Map<string, Record<string, unknown>>();
    for (const value of denseArray(space.accounts, MAX_ACCOUNTS)) {
      if (typeof value !== 'object' || value === null) throw vaultError('INVALID_PLAINTEXT');
      const type = Object.getOwnPropertyDescriptor(value, 'type')?.value;
      const baseFields = ['id', 'name', 'currency', 'openingBalanceMinor', 'openingDate', 'type'];
      const account = requireClosedRecord(value, type === 'credit' ? [...baseFields, 'creditLimitMinor'] : baseFields);
      const id = text(account.id, 128, true);
      text(account.name, 1024);
      if (!currencies.has(account.currency as string) || !['debit', 'cash', 'credit'].includes(type) || accounts.has(id)) throw vaultError('INVALID_PLAINTEXT');
      integer(account.openingBalanceMinor);
      date(account.openingDate);
      if (type === 'credit') integer(account.creditLimitMinor, 0);
      accounts.set(id, account);
    }
    const operationIds = new Set<string>();
    for (const value of denseArray(space.operations, MAX_OPERATIONS)) {
      if (typeof value !== 'object' || value === null) throw vaultError('INVALID_PLAINTEXT');
      const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
      const baseFields = ['id', 'currency', 'amountMinor', 'date', 'kind'];
      const paired = kind === 'transfer' || kind === 'card-payment';
      const operation = requireClosedRecord(value, [...baseFields, ...(paired ? ['fromAccountId', 'toAccountId'] : ['accountId'])]);
      const id = text(operation.id, 128, true);
      if (operationIds.has(id) || !currencies.has(operation.currency as string)) throw vaultError('INVALID_PLAINTEXT');
      operationIds.add(id);
      integer(operation.amountMinor, 1);
      date(operation.date);
      const accountFor = (reference: unknown): Record<string, unknown> => {
        const account = accounts.get(text(reference, 128, true));
        if (!account || account.currency !== operation.currency) throw vaultError('INVALID_PLAINTEXT');
        return account;
      };
      if (kind === 'income' || kind === 'expense') accountFor(operation.accountId);
      else if (paired) {
        const from = accountFor(operation.fromAccountId);
        const to = accountFor(operation.toAccountId);
        if (from.id === to.id || from.type === 'credit' || (kind === 'card-payment') !== (to.type === 'credit')) throw vaultError('INVALID_PLAINTEXT');
      } else throw vaultError('INVALID_PLAINTEXT');
    }
    const json = JSON.stringify(root);
    if (encodeUtf8(json).length > MAX_PLAINTEXT_BYTES) throw vaultError('SIZE_LIMIT');
    return JSON.parse(json) as FinancialPlaintext;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'SIZE_LIMIT') throw error;
    throw vaultError('INVALID_PLAINTEXT');
  }
}

export function serializeFinancialPlaintext(candidate: unknown): Uint8Array<ArrayBuffer> {
  return encodeUtf8(JSON.stringify(validateFinancialPlaintext(candidate)));
}

export function parseFinancialPlaintext(bytes: Uint8Array): FinancialPlaintext {
  if (bytes.length > MAX_PLAINTEXT_BYTES) throw vaultError('INVALID_PLAINTEXT');
  try {
    return validateFinancialPlaintext(parseStrictJson(decodeUtf8(bytes), { maxBytes: MAX_PLAINTEXT_BYTES }));
  } catch {
    throw vaultError('INVALID_PLAINTEXT');
  }
}

/** Financial runtime profile: legacy v1 is only opened for explicit import/upgrade. */
export function validateFinancialSnapshot(candidate: unknown): FinancialSnapshot {
  const snapshot = validateFinancialPlaintext(candidate);
  if (snapshot.financialSpace.domainSchemaVersion === 1) throw vaultError('UNSUPPORTED_FORMAT');
  return snapshot as FinancialSnapshot;
}
