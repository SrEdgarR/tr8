/** Independent current-state witness. A missing or divergent record never bootstraps itself. */
import { advance, controlState, stable, type ControlState, type ControlIntent } from '../../../server/finance-authority/vault-control.ts';
import { controlIntent, type ControlAuthority } from './control-client.ts';
import { requireClosedRecord } from '../../../src/app/finance/compatibility/protocol.ts';
import { FinanceError } from './handler.ts';
export interface WitnessRecord {
  protocol: 1;
  authorityId: string;
  ownerId: string;
  state: ControlState;
  pending: ControlIntent | null;
}
export interface WitnessStorage {
  read(): Promise<{ etag: string; record: unknown }>;
  compareSwap(etag: string, record: WitnessRecord): Promise<void>;
}
export async function witnessRecord(value: unknown, authorityId: string, ownerId: string): Promise<WitnessRecord> {
  try {
    const r = requireClosedRecord(value, ['protocol', 'authorityId', 'ownerId', 'state', 'pending']);
    const state = controlState(r.state);
    if (r.protocol !== 1 || r.authorityId !== authorityId || r.ownerId !== ownerId || state.ownerId !== ownerId) throw Error();
    const pending = r.pending === null ? null : await controlIntent(r.pending);
    if (pending && (pending.status !== 'pending' || stable(advance(state, pending.command, pending.preparedAtMs)) !== stable(pending.next))) throw Error();
    return { protocol: 1, authorityId, ownerId, state, pending };
  } catch {
    throw new FinanceError('AUTHORITY_DIVERGED', 503);
  }
}
export function witnessedAuthority(base: ControlAuthority, storage: WitnessStorage, authorityId: string, ownerId: string): ControlAuthority {
  const read = async () => {
    const r = await storage.read();
    if (!r.etag) throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
    return { etag: r.etag, record: await witnessRecord(r.record, authorityId, ownerId) };
  };
  async function pair() {
    const [cloud, witness] = await Promise.all([base.view(), read()]);
    if (stable(cloud.state) === stable(witness.record.state)) {
      if (cloud.pending && witness.record.pending && stable(cloud.pending) !== stable(witness.record.pending))
        throw new FinanceError('AUTHORITY_DIVERGED', 503);
      return { state: cloud.state, pending: cloud.pending ?? witness.record.pending, witness };
    }
    const p = witness.record.pending;
    if (p && cloud.pending === null && stable(cloud.state) === stable(p.next)) return { state: witness.record.state, pending: p, witness };
    throw new FinanceError('AUTHORITY_DIVERGED', 503);
  }
  async function prepared(intent: ControlIntent) {
    const current = await read();
    if (current.record.pending) {
      if (stable(current.record.pending) !== stable({ ...intent, status: 'pending' })) throw new FinanceError('AUTHORITY_DIVERGED', 503);
      return;
    }
    if (stable(current.record.state) === stable(intent.next)) return;
    if (stable(advance(current.record.state, intent.command, intent.preparedAtMs)) !== stable(intent.next)) throw new FinanceError('AUTHORITY_DIVERGED', 503);
    await storage.compareSwap(current.etag, { ...current.record, pending: { ...intent, status: 'pending' } });
  }
  return {
    ...base,
    view: async () => {
      const r = await pair();
      return { state: r.state, pending: r.pending };
    },
    operation: async id => {
      const op = await base.operation(id);
      if (!op) return null;
      const w = await read();
      return w.record.pending?.command.operationId === id ? { ...op, status: 'pending' } : op;
    },
    prepare: async command => {
      const intent = await base.prepare(command);
      await prepared(intent);
      return intent;
    },
    commit: async intent => {
      await prepared(intent);
      const next = await base.commit(intent);
      const current = await read();
      if (current.record.pending === null && stable(current.record.state) === stable(next)) return next;
      if (!current.record.pending || stable(current.record.pending) !== stable({ ...intent, status: 'pending' }) || stable(next) !== stable(intent.next))
        throw new FinanceError('AUTHORITY_DIVERGED', 503);
      await storage.compareSwap(current.etag, { ...current.record, state: next, pending: null });
      return next;
    },
  };
}
