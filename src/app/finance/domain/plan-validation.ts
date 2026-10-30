import { closedRecord, financialText, collection } from './workspace-records';
import { validateWorkspaceOperation } from './workspace-operations';
import { requireDate } from './validation';
import type { CurrencyDefinition, FinancialAccount } from './types';
import type { FinancialPlan, WorkspaceOperation } from './workspace-types';

export function validatePlans(
  candidate: unknown,
  accounts: FinancialAccount[],
  operations: WorkspaceOperation[],
  definitions: readonly CurrencyDefinition[],
  domainVersion = 4,
): FinancialPlan[] {
  const ids = new Set<string>(),
    reserved = new Set<string>();
  const byId = new Map(operations.map(operation => [operation.id, operation]));
  return collection(candidate, 10000).map(value => {
    const status = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'status')?.value : undefined;
    if (!['pending', 'confirmed', 'cancelled'].includes(status)) throw new Error('El estado del plan no es válido.');
    const input = closedRecord(value, [
      'id',
      'operation',
      'status',
      ...(status !== 'pending' ? ['resolvedDate'] : []),
      ...(status === 'confirmed' ? ['resultOperationId'] : []),
    ]);
    const id = financialText(input.id, 128);
    if (id.trim() !== id || ids.has(id)) throw new Error('El plan está duplicado o tiene un ID inválido.');
    ids.add(id);
    const operation = validateWorkspaceOperation(input.operation, accounts, definitions, domainVersion);
    if (operation!.kind === 'refund' || reserved.has(operation!.id)) throw new Error('El plan o su movimiento no es válido.');
    reserved.add(operation!.id);
    if (status !== 'confirmed' && byId.has(operation!.id)) throw new Error('El movimiento del plan ya existe.');
    if (status === 'pending') return { id, operation: operation!, status: 'pending' };
    const resolvedDate = requireDate(input.resolvedDate);
    if (status === 'cancelled') return { id, operation: operation!, status: 'cancelled', resolvedDate };
    const resultOperationId = financialText(input.resultOperationId, 128);
    const result = byId.get(resultOperationId);
    if (
      !result ||
      resultOperationId !== operation!.id ||
      result.date !== resolvedDate ||
      JSON.stringify({ ...operation, date: resolvedDate }) !== JSON.stringify(result)
    )
      throw new Error('El resultado confirmado no coincide con el plan.');
    return {
      id,
      operation: operation!,
      status: 'confirmed',
      resolvedDate,
      resultOperationId,
    };
  });
}
