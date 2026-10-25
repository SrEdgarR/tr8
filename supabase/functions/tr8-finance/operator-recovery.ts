/** Private server/operator capability only. Never expose readReceipt to a browser. */
import { advance, stable } from '../../../server/finance-authority/vault-control.ts';
import { controlIntent, type ControlAuthority } from './control-client.ts';
import { FinanceError } from './handler.ts';
export async function finalizeNegativeIntent(authority: ControlAuthority, operationId: string, readReceipt: (id: string) => Promise<unknown>) {
  const before = await authority.view(),
    op = await authority.operation(operationId);
  if (!op || op.command.kind === 'put' || op.command.kind === 'enroll') throw new FinanceError('OPERATOR_RECOVERY_DENIED', 403);
  const stored = await readReceipt(operationId);
  if (stored === null) throw new FinanceError('RESTORE_QUARANTINED', 503);
  const receipt = await controlIntent(stored);
  if (stable(receipt) !== stable({ ...op, status: 'pending' })) throw new FinanceError('FINANCE_CONFLICT', 409);
  if (op.status === 'committed') {
    if (stable(before.state) !== stable(op.next)) throw new FinanceError('FINANCE_CONFLICT', 409);
    return { operationId, sequence: op.next.sequence };
  }
  if (before.pending?.digest !== op.digest || stable(advance(before.state, op.command, op.preparedAtMs)) !== stable(op.next))
    throw new FinanceError('RESTORE_QUARANTINED', 503);
  await authority.commit(op);
  return { operationId, sequence: op.next.sequence };
}
