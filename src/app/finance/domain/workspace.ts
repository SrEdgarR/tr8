import { createFinancialAccount } from './accounts';
import { validateWorkspaceOperation } from './workspace-operations';
import { CURRENCY_CATALOG, CURRENCY_CATALOG_VERSION } from './catalog';
import { closedRecord, validateFinancialSpace } from './workspace-validation';
import { validateFinancialPlaintext as validatePlaintext, validateFinancialSnapshot } from './snapshot';
import type { FinancialSnapshot } from './workspace-types';

export function emptyFinancialSnapshot(): FinancialSnapshot {
  return {
    schemaVersion: 1,
    financialSpace: {
      domainSchemaVersion: 4,
      currencyCatalogVersion: CURRENCY_CATALOG_VERSION,
      currencyDefinitions: CURRENCY_CATALOG.map(entry => ({ ...entry })),
      accounts: [],
      operations: [],
      plans: [],
    },
  };
}

/** Local, explicit migration. It does not write remotely or drop unknown fields. */
export function upgradeSnapshot(candidate: unknown): FinancialSnapshot {
  const snapshot = validatePlaintext(candidate);
  if (snapshot.financialSpace.domainSchemaVersion === 4 && snapshot.financialSpace.currencyCatalogVersion === CURRENCY_CATALOG_VERSION)
    return snapshot as FinancialSnapshot;
  const old = snapshot.financialSpace;
  return {
    schemaVersion: 1,
    financialSpace: validateFinancialSpace({
      ...old,
      domainSchemaVersion: 4,
      plans: old.domainSchemaVersion === 4 ? old.plans : [],
      currencyCatalogVersion: CURRENCY_CATALOG_VERSION,
      currencyDefinitions: CURRENCY_CATALOG.map(entry => ({ ...entry })),
      operations:
        old.domainSchemaVersion !== 1
          ? old.operations
          : old.operations.map(operation => ({
              ...operation,
              description: 'Movimiento anterior',
              note: '',
              ...(['income', 'expense'].includes(operation.kind) ? { category: 'other' } : {}),
            })),
    }),
  };
}

export function addAccount(snapshot: FinancialSnapshot, candidate: unknown): FinancialSnapshot {
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  if (!candidate || typeof candidate !== 'object') throw new Error('La cuenta no es válida.');
  const keys = [
    'id',
    'name',
    ...(Object.hasOwn(candidate, 'bankName') ? ['bankName'] : []),
    'type',
    'openingBalanceMinor',
    'openingDate',
    ...(Object.hasOwn(candidate, 'currency') ? ['currency'] : []),
    ...(Object.getOwnPropertyDescriptor(candidate, 'type')?.value === 'credit' ? ['creditLimitMinor'] : []),
  ];
  const input = closedRecord(candidate, keys);
  const account = createFinancialAccount(input, space.currencyDefinitions);
  return {
    schemaVersion: 1,
    financialSpace: validateFinancialSpace({
      ...space,
      accounts: [...space.accounts, account],
    }),
  };
}

/** Validated movement intent; preparing it does not apply it to the ledger. */
export function prepareEntryOperation(snapshot: FinancialSnapshot, candidate: unknown) {
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  const input = closedRecord(candidate, ['id', 'kind', 'accountId', 'date', 'amountMinor', 'description', 'category', 'note']);
  if (input.kind !== 'income' && input.kind !== 'expense') throw new Error('Selecciona ingreso o gasto.');
  const account = space.accounts.find(item => item.id === input.accountId);
  if (!account) throw new Error('Selecciona una cuenta existente.');
  return validateWorkspaceOperation({ ...input, currency: account.currency }, space.accounts, space.currencyDefinitions, space.domainSchemaVersion);
}

export function addEntry(snapshot: FinancialSnapshot, candidate: unknown): FinancialSnapshot {
  const operation = prepareEntryOperation(snapshot, candidate);
  const space = snapshot.financialSpace;
  return {
    schemaVersion: 1,
    financialSpace: validateFinancialSpace({
      ...space,
      operations: [...space.operations, operation],
    }),
  };
}

/** Account identity and ledger references are preserved when editing metadata. */
export function accountHasActivity(snapshot: FinancialSnapshot, accountId: string): boolean {
  const space = snapshot.financialSpace;
  return [...space.operations, ...(space.plans ?? []).map(p => p.operation)].some(
    op =>
      ('accountId' in op && op.accountId === accountId) ||
      ('fromAccountId' in op && (op.fromAccountId === accountId || op.toAccountId === accountId)) ||
      ('destinationAccountId' in op && op.destinationAccountId === accountId),
  );
}
export function updateAccount(snapshot: FinancialSnapshot, accountId: string, candidate: unknown): FinancialSnapshot {
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  const previous = space.accounts.find(a => a.id === accountId);
  if (!previous) throw new Error('La cuenta ya no está disponible.');
  const input = closedRecord(candidate, [
    'name',
    'type',
    'currency',
    'openingBalanceMinor',
    'openingDate',
    ...(candidate && typeof candidate === 'object' && Object.hasOwn(candidate, 'bankName') ? ['bankName'] : []),
    ...(candidate && typeof candidate === 'object' && Object.getOwnPropertyDescriptor(candidate, 'type')?.value === 'credit' ? ['creditLimitMinor'] : []),
  ]);
  const account = createFinancialAccount({ ...input, id: accountId }, space.currencyDefinitions);
  if (accountHasActivity(snapshot, accountId) && (account.currency !== previous.currency || account.type !== previous.type))
    throw new Error('La moneda y el tipo se conservan cuando la cuenta tiene movimientos o planes.');
  return { schemaVersion: 1, financialSpace: validateFinancialSpace({ ...space, accounts: space.accounts.map(a => (a.id === accountId ? account : a)) }) };
}
