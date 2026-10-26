import { validateFinancialSnapshot } from './snapshot';
import { validateFinancialSpace } from './workspace-validation';
import type { FinancialOperation } from './types';
import type { FinancialSnapshot, FinancialSpace } from './workspace-types';

export interface AccountRemoval {
  name: string;
  accountIds: string[];
  operationCount: number;
  planCount: number;
  canDelete: boolean;
}

/** A refund still depends on its original purchase, even if credited elsewhere. */
function referencesAccount(operation: FinancialOperation, accountIds: ReadonlySet<string>, operations: ReadonlyMap<string, FinancialOperation>): boolean {
  switch (operation.kind) {
    case 'income':
    case 'expense':
      return accountIds.has(operation.accountId);
    case 'transfer':
    case 'card-payment':
      return accountIds.has(operation.fromAccountId) || accountIds.has(operation.toAccountId);
    case 'refund': {
      const original = operations.get(operation.originalExpenseId);
      return accountIds.has(operation.destinationAccountId) || (original?.kind === 'expense' && accountIds.has(original.accountId));
    }
  }
}

function removalFromSpace(space: FinancialSpace, accountId: string): AccountRemoval {
  const selected = space.accounts.find(account => account.id === accountId);
  if (!selected) throw new Error('La cuenta ya no está disponible.');
  const cardId = selected.type === 'credit' ? selected.creditCard?.id : undefined;
  const accounts = cardId ? space.accounts.filter(account => account.type === 'credit' && account.creditCard?.id === cardId) : [selected];
  const accountIds = accounts.map(account => account.id);
  const ids = new Set(accountIds);
  const operations = new Map(space.operations.map(operation => [operation.id, operation]));
  const operationCount = space.operations.filter(operation => referencesAccount(operation, ids, operations)).length;
  // Resolved plans retain their references too; removing them would erase history.
  const planCount = (space.plans ?? []).filter(plan => referencesAccount(plan.operation, ids, operations)).length;
  return { name: selected.name, accountIds, operationCount, planCount, canDelete: operationCount === 0 && planCount === 0 };
}

/** Read-only preview: grouped card currency pockets form one deletion unit. */
export function getAccountRemoval(snapshot: FinancialSnapshot, accountId: string): AccountRemoval {
  return removalFromSpace(validateFinancialSnapshot(snapshot).financialSpace, accountId);
}

/** No cascade: historical movements and plans must never be erased by deletion. */
export function removeFinancialAccount(snapshot: FinancialSnapshot, accountId: string, confirmationName: string): FinancialSnapshot {
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  const removal = removalFromSpace(space, accountId);
  if (typeof confirmationName !== 'string' || confirmationName !== removal.name)
    throw new Error('Escribe el nombre exacto de la cuenta para confirmar la eliminación.');
  if (!removal.canDelete) throw new Error('Esta cuenta tiene movimientos o planes vinculados. No se puede eliminar sin perder su historial.');
  const ids = new Set(removal.accountIds);
  return {
    schemaVersion: 1,
    financialSpace: validateFinancialSpace({ ...space, accounts: space.accounts.filter(account => !ids.has(account.id)) }),
  };
}
