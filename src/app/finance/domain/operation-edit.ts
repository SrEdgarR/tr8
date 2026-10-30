import type { FinancialOperation } from './types';
import type { FinancialSnapshot, WorkspaceOperation } from './workspace-types';
import { validateFinancialSnapshot } from './snapshot';
import { validateFinancialSpace } from './workspace-validation';
import { validateWorkspaceOperation } from './workspace-operations';
import { requireDate } from './validation';
import { operationDestinationCurrency } from './operations';

function touchesAccount(operation: FinancialOperation, accountId: string) {
  return 'accountId' in operation
    ? operation.accountId === accountId
    : operation.kind === 'refund'
      ? operation.destinationAccountId === accountId
      : operation.fromAccountId === accountId || operation.toAccountId === accountId;
}

function currentOperation(snapshot: FinancialSnapshot, previous: WorkspaceOperation) {
  const space = validateFinancialSnapshot(snapshot).financialSpace;
  const current = space.operations.find(operation => operation.id === previous.id);
  if (!current) throw Error('El movimiento ya no está disponible. Cierra esta ventana y actualiza tus finanzas.');
  if (JSON.stringify(current) !== JSON.stringify(previous)) throw Error('El movimiento cambió desde que abriste esta ventana. Ciérrala y vuelve a abrirlo.');
  return { space, current };
}

function capturedCards(snapshot: FinancialSnapshot, operation: WorkspaceOperation) {
  return snapshot.financialSpace.accounts.filter(
    account =>
      account.type === 'credit' &&
      account.creditCard?.baseline &&
      touchesAccount(operation, account.id) &&
      operation.date <= account.creditCard.baseline.asOfDate,
  );
}

export function operationChangeInfo(snapshot: FinancialSnapshot, previous: WorkspaceOperation) {
  const { space, current } = currentOperation(snapshot, previous);
  const refunds = space.operations.filter(operation => operation.kind === 'refund' && operation.originalExpenseId === current.id);
  const plans = (space.plans ?? []).filter(plan => plan.status === 'confirmed' && plan.resultOperationId === current.id);
  const cards = capturedCards(snapshot, current);
  return { operation: current, refunds, plans, captured: cards.length > 0, capturedCardNames: [...new Set(cards.map(account => account.name))] };
}

const capturedMessage =
  'Este movimiento está incluido en un saldo de corte capturado. Abre Configurar tarjeta y activa «Completar la deuda al corte después» antes de corregir sus importes, cuentas o fecha. Después vuelve a confirmar el pendiente del corte.';

function financialIdentity(operation: WorkspaceOperation) {
  return JSON.stringify(Object.entries(operation).filter(([key]) => !['description', 'note', 'category'].includes(key)));
}

/** Replace one logical movement; paired ledger effects and its confirmed plan commit together. */
export function updateFinancialOperation(snapshot: FinancialSnapshot, previous: WorkspaceOperation, candidate: unknown): FinancialSnapshot {
  const { space, current } = currentOperation(snapshot, previous);
  const next = validateWorkspaceOperation(candidate, space.accounts, space.currencyDefinitions, space.domainSchemaVersion);
  if (
    next.id !== current.id ||
    next.kind !== current.kind ||
    next.currency !== current.currency ||
    operationDestinationCurrency(next) !== operationDestinationCurrency(current)
  )
    throw Error('El ID, el tipo y la moneda del movimiento se conservan al editar.');
  if (financialIdentity(current) !== financialIdentity(next) && (capturedCards(snapshot, current).length || capturedCards(snapshot, next).length))
    throw Error(capturedMessage);
  return {
    schemaVersion: 1,
    financialSpace: validateFinancialSpace({
      ...space,
      operations: space.operations.map(operation => (operation.id === current.id ? next : operation)),
      ...(space.plans
        ? {
            plans: space.plans.map(plan =>
              plan.status === 'confirmed' && plan.resultOperationId === current.id
                ? { ...plan, operation: { ...next, date: plan.operation.date }, resolvedDate: next.date }
                : plan,
            ),
          }
        : {}),
    }),
  };
}

/** A single transfer/payment owns both effects, so deleting it cannot leave an orphaned leg. */
export function deleteFinancialOperation(snapshot: FinancialSnapshot, previous: WorkspaceOperation, cancellationDate: string): FinancialSnapshot {
  const { space, current } = currentOperation(snapshot, previous);
  const date = requireDate(cancellationDate);
  const info = operationChangeInfo(snapshot, current);
  if (info.refunds.length) throw Error('Este gasto tiene reembolsos vinculados. Elimina primero esos reembolsos para conservar un historial válido.');
  if (info.captured) throw Error(capturedMessage);
  return {
    schemaVersion: 1,
    financialSpace: validateFinancialSpace({
      ...space,
      operations: space.operations.filter(operation => operation.id !== current.id),
      // Captures include opaque IDs for unrelated accounts too. Remove only that
      // reference; the captured debt and statement split remain untouched.
      accounts: space.accounts.map(account =>
        account.type === 'credit' && account.creditCard?.baseline?.includedOperationIds?.includes(current.id)
          ? {
              ...account,
              creditCard: {
                ...account.creditCard,
                baseline: {
                  ...account.creditCard.baseline,
                  includedOperationIds: account.creditCard.baseline.includedOperationIds.filter(id => id !== current.id),
                },
              },
            }
          : account,
      ),
      ...(space.plans
        ? {
            plans: space.plans.map(plan =>
              plan.status === 'confirmed' && plan.resultOperationId === current.id
                ? { id: plan.id, operation: plan.operation, status: 'cancelled', resolvedDate: date }
                : plan,
            ),
          }
        : {}),
    }),
  };
}
