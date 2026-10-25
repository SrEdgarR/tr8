import {
  assertOpaqueTransition,
  parseOpaquePut,
  requireClosedRecord,
  validateEnvelope,
  hashOpaqueRequest,
  type OpaquePut,
} from '../../../src/app/finance/compatibility/protocol.ts';
import {
  advance,
  assertControlAccess,
  assertCurrentEnvelope,
  controlState,
  envelopeHead,
  stable,
  type ControlCommand,
  type ControlIntent,
  type ControlState,
  type ControlKind,
} from '../../../server/finance-authority/vault-control.ts';
import { CONTROL_AUTHORITY, CONTROL_OWNER, type ControlAuthority } from './control-client.ts';
import { FinanceError, type FinanceActor, type FinanceRuntime } from './handler.ts';
export function controlCoordinator(
  raw: FinanceRuntime,
  authority: ControlAuthority,
  clock = Date.now,
  pins = { ownerId: CONTROL_OWNER, authorityId: CONTROL_AUTHORITY },
) {
  const live = (actor: FinanceActor) => {
    if (actor.id !== pins.ownerId) throw new FinanceError('FINANCE_ACCESS_DENIED', 403);
    if (actor.expiresAt <= clock() / 1000) throw new FinanceError('AUTH_REQUIRED', 401);
  };
  const call = async (action: string, actor: FinanceActor, args: Record<string, unknown> = {}) => {
    live(actor);
    const result = await raw.call(action, actor, { ...args, p_authority_id: pins.authorityId, p_case_id: authority.caseId });
    live(actor);
    return result;
  };
  const denyPending = (p: unknown) => {
    if (p) throw new FinanceError('RESTORE_QUARANTINED', 503);
  };
  const probe = async (actor: FinanceActor) => {
    const r = requireClosedRecord(await call('probe', actor), ['sessionCreatedAtMs']);
    if (typeof r.sessionCreatedAtMs !== 'number' || !Number.isSafeInteger(r.sessionCreatedAtMs)) throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
    return r.sessionCreatedAtMs;
  };
  async function checkedRead(actor: FinanceActor, state: ControlState) {
    const r = requireClosedRecord(await call('read', actor, { p_expected: state }), ['state', 'envelope']);
    if (stable(controlState(r.state)) !== stable(state)) throw new FinanceError('FINANCE_CONFLICT', 409);
    const e = r.envelope === null ? null : validateEnvelope(r.envelope);
    await assertCurrentEnvelope(state, e);
    return e;
  }
  async function finish(actor: FinanceActor, intent: ControlIntent, before: ControlState, put: OpaquePut | null, resume = false) {
    const result = await call('apply', actor, {
      p_expected: before,
      p_intent: intent,
      p_envelope: put?.envelope ?? null,
      p_expected_revision: put?.expectedRevision ?? null,
      p_resume: resume,
    });
    if (stable(result) !== stable(intent)) throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
    live(actor);
    await authority.commit(intent);
    live(actor);
    return { operationId: intent.command.operationId, sequence: intent.next.sequence };
  }
  async function resume(actor: FinanceActor, operationId: string, body?: string) {
    live(actor);
    const view = await authority.view();
    live(actor);
    const op = await authority.operation(operationId);
    if (!op) throw new FinanceError('NOT_FOUND', 404);
    if (body !== undefined) {
      if (op.command.kind !== 'put') throw new FinanceError('FINANCE_CONFLICT', 409);
      const supplied = parseOpaquePut(body);
      const h = await envelopeHead(supplied.envelope, await hashOpaqueRequest(new TextEncoder().encode(body)));
      if (stable(h) !== stable(op.command.head) || supplied.envelope.ownerId !== actor.id) throw new FinanceError('FINANCE_CONFLICT', 409);
    }
    const receipt = await call('operation', actor, { p_operation_id: operationId });
    if (receipt !== null) {
      if (stable(receipt) !== stable({ ...op, status: 'pending' })) throw new FinanceError('FINANCE_CONFLICT', 409);
      if (op.status === 'pending') await authority.commit(op);
      else if (stable(view.state) !== stable(op.next)) throw new FinanceError('FINANCE_CONFLICT', 409);
      return { operationId, sequence: op.next.sequence };
    }
    if (op.status === 'committed') throw new FinanceError('FINANCE_CONFLICT', 409);
    if (!view.pending || view.pending.digest !== op.digest || stable(advance(view.state, op.command, op.preparedAtMs)) !== stable(op.next))
      throw new FinanceError('RESTORE_QUARANTINED', 503);
    let put: OpaquePut | null = null;
    if (op.command.kind === 'put') {
      if (body === undefined) throw new FinanceError('ORIGINAL_ENVELOPE_REQUIRED', 409);
      put = parseOpaquePut(body);
      const h = await envelopeHead(put.envelope, await hashOpaqueRequest(new TextEncoder().encode(body)));
      if (stable(h) !== stable(op.command.head) || put.envelope.ownerId !== actor.id) throw new FinanceError('FINANCE_CONFLICT', 409);
    }
    await call('authorize', actor, {
      p_expected: view.state,
      p_command: op.command,
      p_envelope: put?.envelope ?? null,
      p_expected_revision: put?.expectedRevision ?? null,
      p_resume: true,
    });
    // Preparation can have stopped after the first independent authority.
    // Reestablish every durable witness before applying the SQL projection.
    await authority.prepare(op.command);
    return finish(actor, op, view.state, put, true);
  }
  return {
    enabled: raw.enabled && authority.configured,
    origin: raw.origin,
    authenticate: raw.authenticate,
    async read(actor: FinanceActor) {
      live(actor);
      const before = await authority.view();
      denyPending(before.pending);
      assertControlAccess(before.state, actor.session);
      const envelope = await checkedRead(actor, before.state);
      const after = await authority.view();
      live(actor);
      denyPending(after.pending);
      assertControlAccess(after.state, actor.session);
      if (stable(before.state) !== stable(after.state)) throw new FinanceError('FINANCE_CONFLICT', 409);
      return { state: after.state, envelope };
    },
    async put(actor: FinanceActor, body: string) {
      live(actor);
      const put = parseOpaquePut(body);
      if (put.envelope.ownerId !== actor.id) throw new FinanceError('FINANCE_ACCESS_DENIED', 403);
      const existing = await authority.operation(put.operationId);
      if (existing) return resume(actor, put.operationId, body);
      const before = await authority.view();
      denyPending(before.pending);
      assertControlAccess(before.state, actor.session);
      const current = await checkedRead(actor, before.state);
      assertOpaqueTransition(current, put);
      const command: ControlCommand = {
        ownerId: actor.id,
        operationId: put.operationId,
        expectedSequence: before.state.sequence,
        kind: 'put',
        expectedHead: before.state.head,
        head: await envelopeHead(put.envelope, await hashOpaqueRequest(new TextEncoder().encode(body))),
        actorSessionId: actor.session,
        sessionCreatedAtMs: await probe(actor),
        targetSessionId: null,
      };
      await call('authorize', actor, { p_expected: before.state, p_command: command, p_envelope: put.envelope, p_expected_revision: put.expectedRevision });
      const intent = await authority.prepare(command);
      if (stable(advance(before.state, command, intent.preparedAtMs)) !== stable(intent.next)) throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
      return finish(actor, intent, before.state, put);
    },
    async identity(actor: FinanceActor, kind: Exclude<ControlKind, 'put'>, operationId: string, expectedSequence: string, targetSessionId: string | null) {
      live(actor);
      const existing = await authority.operation(operationId);
      if (existing) {
        if (existing.command.kind !== kind || existing.command.targetSessionId !== targetSessionId || existing.command.expectedSequence !== expectedSequence)
          throw new FinanceError('FINANCE_CONFLICT', 409);
        return resume(actor, operationId);
      }
      const before = await authority.view();
      denyPending(before.pending);
      const command: ControlCommand = {
        ownerId: actor.id,
        operationId,
        expectedSequence,
        kind,
        expectedHead: before.state.head,
        head: null,
        actorSessionId: actor.session,
        sessionCreatedAtMs: await probe(actor),
        targetSessionId,
      };
      advance(before.state, command, clock());
      await call('authorize', actor, { p_expected: before.state, p_command: command });
      const intent = await authority.prepare(command);
      if (stable(advance(before.state, command, intent.preparedAtMs)) !== stable(intent.next)) throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
      return finish(actor, intent, before.state, null);
    },
    resume,
    async repair(actor: FinanceActor, envelope: unknown) {
      live(actor);
      const before = await authority.view();
      denyPending(before.pending);
      const e = envelope === null ? null : validateEnvelope(envelope);
      await assertCurrentEnvelope(before.state, e);
      const current = before.state.head ? await authority.operation(before.state.head.operationId) : null;
      const receipt = current?.status === 'committed' && stable(current.next) === stable(before.state) ? { ...current, status: 'pending' } : null;
      await call('repair', actor, { p_expected: before.state, p_envelope: e, p_intent: receipt });
      const after = await authority.view();
      live(actor);
      denyPending(after.pending);
      if (stable(after.state) !== stable(before.state)) throw new FinanceError('RESTORE_QUARANTINED', 503);
      return { repaired: true, sequence: after.state.sequence };
    },
  };
}
