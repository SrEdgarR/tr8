import { canonical, type LifecycleCommand } from '../../../server/finance-authority/journal-core.ts';
import { requireClosedRecord, validateEnvelope } from '../../../src/app/finance/compatibility/protocol.ts';
import {
  assertEvidence,
  createAuthorityClient,
  commandDigest,
  RESTORE_AUTHORITY,
  RESTORE_OWNER,
  RESTORE_VAULT,
  type AuthorityClient,
} from './authority-client.ts';
import { FinanceError, type FinanceActor, type FinanceRuntime } from './handler.ts';
import { createFinanceRuntime } from './runtime.ts';
export function coordinateFinance(raw: FinanceRuntime, authority: AuthorityClient, clock = Date.now): FinanceRuntime {
  const pins = { p_authority_id: RESTORE_AUTHORITY, p_case_id: authority.caseId };
  const live = (actor: FinanceActor) => {
    if (actor.id !== RESTORE_OWNER) throw new FinanceError('FINANCE_ACCESS_DENIED', 403);
    if (actor.expiresAt <= clock() / 1000) throw new FinanceError('AUTH_REQUIRED', 401);
  };
  const call = async (action: string, actor: FinanceActor, args: Record<string, unknown>) => {
    live(actor);
    const result = await raw.call(action, actor, { ...args, ...pins });
    live(actor);
    return result;
  };
  return {
    enabled: raw.enabled && authority.configured,
    origin: raw.origin,
    authenticate: raw.authenticate,
    syntheticRestore: true,
    async call(action, actor, args) {
      live(actor);
      if (action === 'reconcile') {
        const state = await authority.state();
        live(actor);
        if (state.operations.some(op => op.status === 'pending')) throw new FinanceError('RESTORE_QUARANTINED', 503);
        await call('repair', actor, { p_state: state });
        const after = await authority.state();
        live(actor);
        if (JSON.stringify(state) !== JSON.stringify(after)) throw new FinanceError('RESTORE_QUARANTINED', 503);
        if (args.p_release === true) await call('release', actor, { p_state: after });
        return { reconciled: true, epoch: state.epoch, quarantined: args.p_release !== true };
      }
      const before = await authority.state();
      live(actor);
      if (['reset', 'revoke', 'purge'].includes(action)) {
        if (before.purged || before.revokedSessions.includes(actor.session)) throw new FinanceError('FINANCE_ACCESS_DENIED', 403);
        const command: LifecycleCommand = {
          operationId: args.p_operation_id as string,
          ownerId: RESTORE_OWNER,
          expectedEpoch: args.p_expected_epoch as string,
          kind: action as LifecycleCommand['kind'],
          vaultId: action === 'revoke' ? null : (args.p_vault_id as string),
          targetSessionId: action === 'revoke' ? (args.p_target_session as string) : null,
        };
        const encoded = canonical(command),
          digest = await commandDigest(command);
        live(actor);
        const prior = before.operations.find(op => op.command.operationId === command.operationId);
        if (prior) {
          if (canonical(prior.command) !== encoded || (prior.status === 'committed' && prior.receipt.epoch !== before.epoch))
            throw new FinanceError('FINANCE_CONFLICT', 409);
        } else assertEvidence(before, actor.session, command.expectedEpoch);
        await call('authorize', actor, {});
        const receipt = await authority.prepare(command);
        live(actor);
        const result = requireClosedRecord(
          await call(action, actor, { ...args, p_journal_command: encoded, p_journal_digest: digest, p_journal_epoch: receipt.epoch }),
          ['operationId', 'epoch', 'retiredVaultId'],
        );
        if (
          result.operationId !== receipt.operationId ||
          result.epoch !== receipt.epoch ||
          result.retiredVaultId !== (action === 'revoke' ? null : RESTORE_VAULT)
        )
          throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
        await authority.commit(receipt);
        live(actor);
        return result;
      }
      if (!['read', 'put', 'receipt'].includes(action)) throw new FinanceError('INVALID_INPUT');
      assertEvidence(before, actor.session);
      const meta = requireClosedRecord(await call('metadata', actor, {}), ['epoch', 'vaultId', 'purged']);
      if (meta.purged !== false || (meta.vaultId !== null && meta.vaultId !== RESTORE_VAULT) || typeof meta.epoch !== 'string')
        throw new FinanceError('FINANCE_ACCESS_DENIED', 403);
      assertEvidence(before, actor.session, meta.epoch);
      const result = await call(action, actor, { ...args, p_fence_epoch: meta.epoch });
      const after = await authority.state();
      live(actor);
      assertEvidence(after, actor.session, meta.epoch);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new FinanceError('FINANCE_CONFLICT', 409);
      if (action === 'read') {
        const head = requireClosedRecord(result, ['envelope', 'epoch']);
        if (head.epoch !== meta.epoch) throw new FinanceError('FINANCE_CONFLICT', 409);
        if (head.envelope !== null) {
          const envelope = validateEnvelope(head.envelope);
          if (envelope.ownerId !== actor.id || envelope.vaultId !== RESTORE_VAULT) throw new FinanceError('FINANCE_ACCESS_DENIED', 403);
        }
      }
      return result;
    },
  };
}
export function createCoordinatedRuntime(get: (key: string) => string | undefined, fetcher: typeof fetch = fetch, clock = Date.now) {
  const raw = createFinanceRuntime(
    key => (key === 'TR8_FINANCE_TESTING_ENABLED' ? get('TR8_FINANCE_RESTORE_TESTING_ENABLED') : get(key)),
    fetcher,
    clock,
    'tr8_server_finance_coordinated',
  );
  return coordinateFinance(raw, createAuthorityClient(get, fetcher), clock);
}
