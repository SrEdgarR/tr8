import { normalizeFinancialAccounts } from './accounts';
import { catalogDefinitions } from './catalog';
import type { FinancialSpace } from './workspace-types';
import { closedRecord, financialText, collection } from './workspace-records';
import { validateWorkspaceOperations } from './workspace-operations';
import { validatePlans } from './plan-validation';
import { validatePlaintext as validateGenericPlaintext } from '../crypto/plaintext';
export { closedRecord, financialText } from './workspace-records';

export function validateFinancialSpace(candidate: unknown): FinancialSpace {
  // Bound and sanitize the whole JSON tree before expensive ledger validation.
  candidate = validateGenericPlaintext({ schemaVersion: 1, financialSpace: candidate }).financialSpace;
  const version = candidate && typeof candidate === 'object' ? Object.getOwnPropertyDescriptor(candidate, 'domainSchemaVersion')?.value : undefined;
  const space = closedRecord(candidate, [
    'domainSchemaVersion',
    'currencyCatalogVersion',
    'currencyDefinitions',
    'accounts',
    'operations',
    ...(version === 4 ? ['plans'] : []),
  ]);
  if (![2, 3, 4].includes(version) || typeof space.currencyCatalogVersion !== 'string') throw new Error('La versión del dominio financiero no es compatible.');
  const definitions = catalogDefinitions(space.currencyCatalogVersion);
  const actual = collection(space.currencyDefinitions, definitions.length);
  if (actual.length !== definitions.length) throw new Error('El catálogo no coincide con su versión.');
  for (const [index, definition] of definitions.entries()) {
    const entry = closedRecord(actual[index], ['code', 'minorUnitDigits']);
    if (entry.code !== definition.code || entry.minorUnitDigits !== definition.minorUnitDigits) throw new Error('El catálogo no coincide con su versión.');
  }
  const rawAccounts = collection(space.accounts, 1000);
  for (const value of rawAccounts) {
    const type = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'type')?.value : undefined;
    const account = closedRecord(value, [
      'id',
      'name',
      ...(Object.hasOwn(value as object, 'bankName') ? ['bankName'] : []),
      'currency',
      'openingBalanceMinor',
      'openingDate',
      'type',
      ...(type === 'credit' ? ['creditLimitMinor'] : []),
    ]);
    financialText(account.id, 128);
    financialText(account.name);
    if (account.bankName !== undefined) financialText(account.bankName, 120);
    if (String(account.id).trim() !== account.id || Object.is(account.openingBalanceMinor, -0)) throw new Error('La cuenta no es válida.');
  }
  const accounts = normalizeFinancialAccounts(rawAccounts, definitions);
  const operations = validateWorkspaceOperations(space.operations, accounts, definitions, version);
  return {
    domainSchemaVersion: version,
    currencyCatalogVersion: space.currencyCatalogVersion,
    currencyDefinitions: definitions.map(entry => ({ ...entry })),
    accounts,
    operations,
    ...(version === 4 ? { plans: validatePlans(space.plans, accounts, operations, definitions) } : {}),
  };
}
