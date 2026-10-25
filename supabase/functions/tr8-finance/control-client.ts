import { encodeBase64Url, parseStrictJson, requireClosedRecord } from '../../../src/app/finance/compatibility/protocol.ts';
import {
  controlState,
  controlCommand,
  sha256,
  stable,
  type ControlState,
  type ControlCommand,
  type ControlIntent,
} from '../../../server/finance-authority/vault-control.ts';
import { FinanceError, readFinanceBytes } from './handler.ts';
export const CONTROL_OWNER = '37848d70-989a-4f69-b124-0c959d8b49a6',
  CONTROL_AUTHORITY = 'c59d8b98-4cbf-4f74-a968-0c591a3d794a';
export const CONTROL_CASES = ['heads', 'revoke', 'logout', 'disable', 'delete', 'reset', 'resume', 'recovery'] as const;
export type ControlCase = (typeof CONTROL_CASES)[number];
export interface ControlAuthority {
  configured: boolean;
  caseId: ControlCase;
  view(): Promise<{ state: ControlState; pending: ControlIntent | null }>;
  operation(id: string): Promise<ControlIntent | null>;
  prepare(command: ControlCommand): Promise<ControlIntent>;
  commit(intent: ControlIntent): Promise<ControlState>;
}
const unavailable = () => new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
export async function controlIntent(input: unknown): Promise<ControlIntent> {
  try {
    const r = requireClosedRecord(input, ['command', 'digest', 'next', 'preparedAtMs', 'status']);
    const c = controlCommand(r.command),
      next = controlState(r.next);
    if (
      r.digest !== (await sha256(stable(c))) ||
      !['pending', 'committed'].includes(r.status as string) ||
      typeof r.preparedAtMs !== 'number' ||
      !Number.isSafeInteger(r.preparedAtMs) ||
      r.preparedAtMs < 0 ||
      next.ownerId !== c.ownerId ||
      next.sequence !== String(BigInt(c.expectedSequence) + 1n)
    )
      throw unavailable();
    return { command: c, digest: r.digest as string, next, preparedAtMs: r.preparedAtMs, status: r.status as ControlIntent['status'] };
  } catch {
    throw unavailable();
  }
}
export function createControlAuthority(get: (key: string) => string | undefined, fetcher: typeof fetch = fetch): ControlAuthority {
  const secret = get('TR8_VAULT_CONTROL_SECRET') ?? '',
    caseId = get('TR8_VAULT_CONTROL_CASE') as ControlCase;
  const configured = get('TR8_VAULT_CONTROL_AUTHORITY') === CONTROL_AUTHORITY && CONTROL_CASES.includes(caseId) && /^[a-f0-9]{64}$/.test(secret);
  async function call(path: string, payload: Record<string, unknown>, fields: string[]) {
    if (!configured) throw unavailable();
    const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    try {
      const r = await fetcher(`https://tr8-vault-control-test.sredgarpadilla.workers.dev/v1/cases/${caseId}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, ...payload }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      const data = requireClosedRecord(
        parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(await readFinanceBytes(r, 262144)), { maxBytes: 262144 }),
        r.ok ? ['nonce', 'authorityId', 'caseId', ...fields] : ['nonce', 'caseId', 'error'],
      );
      if (data.nonce !== nonce || data.caseId !== caseId || r.headers.get('Cache-Control') !== 'no-store') throw unavailable();
      if (!r.ok) {
        const e = requireClosedRecord(data.error, ['code']);
        if (e.code === 'DENIED') throw new FinanceError('FINANCE_ACCESS_DENIED', 403);
        if (e.code === 'CONFLICT') throw new FinanceError('FINANCE_CONFLICT', 409);
        throw unavailable();
      }
      if (data.authorityId !== CONTROL_AUTHORITY) throw unavailable();
      return data;
    } catch (error) {
      if (error instanceof FinanceError && [403, 409, 503].includes(error.status)) throw error;
      throw unavailable();
    }
  }
  return {
    configured,
    caseId,
    view: async () => {
      const r = await call('state', { ownerId: CONTROL_OWNER }, ['state', 'pending']);
      const state = controlState(r.state);
      if (state.ownerId !== CONTROL_OWNER) throw unavailable();
      const pending = r.pending === null ? null : await controlIntent(r.pending);
      if (pending && (pending.command.ownerId !== CONTROL_OWNER || pending.command.expectedSequence !== state.sequence || pending.status !== 'pending'))
        throw unavailable();
      return { state, pending };
    },
    operation: async id => {
      const r = await call('operation', { ownerId: CONTROL_OWNER, operationId: id }, ['intent']);
      if (r.intent === null) return null;
      const intent = await controlIntent(r.intent);
      if (intent.command.operationId !== id || intent.command.ownerId !== CONTROL_OWNER) throw unavailable();
      return intent;
    },
    prepare: async command => {
      const r = await call('prepare', { command }, ['intent']);
      const intent = await controlIntent(r.intent);
      if (stable(intent.command) !== stable(command)) throw unavailable();
      return intent;
    },
    commit: async intent => {
      const r = await call('commit', { ownerId: CONTROL_OWNER, operationId: intent.command.operationId, digest: intent.digest }, ['state']);
      const result = controlState(r.state);
      if (stable(result) !== stable(intent.next)) throw unavailable();
      return result;
    },
  };
}
