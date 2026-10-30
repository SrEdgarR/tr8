import { closedRecord, validateFinancialSpace } from './workspace-validation';
import { projectFinancialBalances } from './projection';
import { requireDate } from './validation';
import { summarizeBalances } from './balances';
import type { FinancialSnapshot } from './workspace-types';
import { validateFinancialSnapshot } from './snapshot';
import { isCrossCurrencyPayment, operationDestinationCurrency } from './operations';
import { validateWorkspaceOperation } from './workspace-operations';

export function addPlan(snapshot: FinancialSnapshot, candidate: unknown): FinancialSnapshot {
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  if (space.domainSchemaVersion < 4) throw new Error('Actualiza el dominio financiero antes de crear planes.');
  const input = closedRecord(candidate, ['id', 'operation']);
  const operation = validateWorkspaceOperation(input.operation, space.accounts, space.currencyDefinitions, 5);
  return {
    schemaVersion: 1,
    financialSpace: validateFinancialSpace({
      ...space,
      ...(isCrossCurrencyPayment(operation) ? { domainSchemaVersion: 5 } : {}),
      plans: [...space.plans!, { ...input, operation, status: 'pending' }],
    }),
  };
}

/** Plan state and its real movement are one immutable snapshot command. */
export function resolvePlan(snapshot: FinancialSnapshot, candidate: unknown): FinancialSnapshot {
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  if (space.domainSchemaVersion < 4) throw new Error('Actualiza el dominio financiero antes de resolver planes.');
  const type = candidate && typeof candidate === 'object' ? Object.getOwnPropertyDescriptor(candidate, 'type')?.value : undefined;
  if (!['keep', 'postpone', 'cancel', 'confirm'].includes(type)) throw new Error('La acción del plan no es válida.');
  const input = closedRecord(candidate, ['type', 'planId', ...(type !== 'keep' ? ['date'] : [])]);
  const plan = space.plans!.find(entry => entry.id === input.planId);
  if (!plan) throw new Error('El plan no existe.');
  const date = type !== 'keep' ? requireDate(input.date) : undefined;
  if ((type === 'confirm' && plan.status === 'confirmed') || (type === 'cancel' && plan.status === 'cancelled')) return snapshot;
  if (plan.status !== 'pending') throw new Error('Este plan ya está resuelto.');
  if (type === 'keep') return snapshot;
  const next =
    type === 'postpone'
      ? { ...plan, operation: { ...plan.operation, date: date! } }
      : type === 'cancel'
        ? { ...plan, status: 'cancelled', resolvedDate: date }
        : {
            ...plan,
            status: 'confirmed',
            resolvedDate: date,
            resultOperationId: plan.operation.id,
          };
  return {
    schemaVersion: 1,
    financialSpace: validateFinancialSpace({
      ...space,
      plans: space.plans!.map(entry => (entry.id === plan.id ? next : entry)),
      operations: type === 'confirm' ? [...space.operations, { ...plan.operation, date: date! }] : space.operations,
    }),
  };
}

export function projectSnapshot(snapshot: FinancialSnapshot, today: string, targetDate: string, accountId?: string) {
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  if (accountId && !space.accounts.some(account => account.id === accountId)) throw new Error('La cuenta no existe.');
  const projection = projectFinancialBalances(
    {
      accounts: space.accounts,
      confirmedOperations: space.operations,
      plannedOperations: (space.plans ?? []).filter(plan => plan.status === 'pending').map(plan => plan.operation),
      today,
      targetDate,
    },
    space.currencyDefinitions,
  );
  if (!accountId) return projection;
  const select = <T extends typeof projection.current>(point: T): T => {
    const accounts = point.accounts.filter(entry => entry.accountId === accountId);
    return { ...point, accounts, currencies: summarizeBalances(accounts) };
  };
  return {
    ...projection,
    current: select(projection.current),
    projected: select(projection.projected),
    points: projection.points.map(select),
  };
}

export function filterHistory(
  snapshot: FinancialSnapshot,
  filters: {
    currency?: string;
    accountId?: string;
    from?: string;
    to?: string;
  },
) {
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  if (filters.from) requireDate(filters.from);
  if (filters.to) requireDate(filters.to);
  if (filters.from && filters.to && filters.from > filters.to) throw new Error('El período no es válido.');
  if (filters.accountId && !space.accounts.some(account => account.id === filters.accountId)) throw new Error('La cuenta no existe.');
  if (filters.currency && !space.currencyDefinitions.some(currency => currency.code === filters.currency)) throw new Error('La moneda no existe.');
  return space.operations
    .filter(operation => {
      const accountIds =
        'accountId' in operation
          ? [operation.accountId]
          : operation.kind === 'refund'
            ? [operation.destinationAccountId]
            : [operation.fromAccountId, operation.toAccountId];
      return (
        (!filters.currency || operation.currency === filters.currency || operationDestinationCurrency(operation) === filters.currency) &&
        (!filters.accountId || accountIds.includes(filters.accountId)) &&
        (!filters.from || operation.date >= filters.from) &&
        (!filters.to || operation.date <= filters.to)
      );
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}
