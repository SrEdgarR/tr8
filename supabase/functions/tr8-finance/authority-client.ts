/** Server-only, synthetic-only independent lifecycle evidence. No browser credential. */
import { canonical, epoch, opaque, uuid, type LifecycleCommand, type LifecycleReceipt } from '../../../server/finance-authority/journal-core.ts';
import { encodeBase64Url, parseStrictJson, requireClosedRecord } from '../../../src/app/finance/compatibility/protocol.ts';
import { FinanceError, readFinanceBytes } from './handler.ts';
export const RESTORE_OWNER = '37848d70-989a-4f69-b124-0c959d8b49a6';
export const RESTORE_VAULT = 'AAAAAAAAAAAAAAAAAAAAAA';
export const RESTORE_AUTHORITY = '9583b66a-a5f8-43e4-aaf6-6409f7502669';
export type RestoreCase = 'reset' | 'revoke' | 'purge';
export interface Evidence {
  ownerId: string;
  epoch: string;
  purged: boolean;
  retiredVaults: string[];
  revokedSessions: string[];
  operations: { command: LifecycleCommand; status: 'pending' | 'committed'; receipt: LifecycleReceipt }[];
}
export interface AuthorityClient {
  configured: boolean;
  caseId: RestoreCase;
  state(): Promise<Evidence>;
  prepare(command: LifecycleCommand): Promise<LifecycleReceipt>;
  commit(receipt: LifecycleReceipt): Promise<void>;
}
export async function commandDigest(command: LifecycleCommand) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(command)))))
    .map(n => n.toString(16).padStart(2, '0'))
    .join('');
}
const unavailable = () => new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
function list(value: unknown, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some(v => typeof v !== 'string' || !pattern.test(v)) || new Set(value).size !== value.length)
    throw unavailable();
  return [...value].sort();
}
export async function validateEvidence(candidate: unknown): Promise<Evidence> {
  try {
    const s = requireClosedRecord(candidate, ['ownerId', 'epoch', 'purged', 'retiredVaults', 'revokedSessions', 'operations']);
    if (s.ownerId !== RESTORE_OWNER || typeof s.purged !== 'boolean' || !Array.isArray(s.operations) || s.operations.length > 64) throw unavailable();
    epoch(s.epoch);
    const retired = list(s.retiredVaults, opaque),
      revoked = list(s.revokedSessions, uuid);
    const expectedRetired = new Set<string>(),
      expectedRevoked = new Set<string>(),
      seen = new Set<string>();
    let current = 1n,
      purged = false,
      pending = false;
    const operations: Evidence['operations'] = [];
    for (const item of s.operations) {
      const op = requireClosedRecord(item, ['command', 'status', 'receipt']);
      const command = JSON.parse(canonical(op.command as LifecycleCommand)) as LifecycleCommand;
      const receipt = requireClosedRecord(op.receipt, ['operationId', 'epoch', 'digest']) as LifecycleReceipt;
      if (
        pending ||
        purged ||
        command.ownerId !== RESTORE_OWNER ||
        seen.has(command.operationId) ||
        command.expectedEpoch !== String(current) ||
        !['pending', 'committed'].includes(op.status as string) ||
        receipt.operationId !== command.operationId ||
        receipt.epoch !== String(current + 1n) ||
        receipt.digest !== (await commandDigest(command))
      )
        throw unavailable();
      if (command.vaultId !== null && command.vaultId !== RESTORE_VAULT) throw unavailable();
      seen.add(command.operationId);
      pending = op.status === 'pending';
      if (!pending) {
        current++;
        if (command.kind === 'revoke') expectedRevoked.add(command.targetSessionId!);
        else expectedRetired.add(command.vaultId!);
        if (command.kind === 'purge') purged = true;
      }
      operations.push({ command, status: op.status as 'pending' | 'committed', receipt: { ...receipt } });
    }
    if (
      String(current) !== s.epoch ||
      purged !== s.purged ||
      JSON.stringify([...expectedRetired].sort()) !== JSON.stringify(retired) ||
      JSON.stringify([...expectedRevoked].sort()) !== JSON.stringify(revoked)
    )
      throw unavailable();
    return { ownerId: RESTORE_OWNER, epoch: String(current), purged, retiredVaults: retired, revokedSessions: revoked, operations };
  } catch {
    throw unavailable();
  }
}
export function assertEvidence(state: Evidence, sessionId: string, expectedEpoch?: string) {
  if (state.purged || state.retiredVaults.includes(RESTORE_VAULT) || state.revokedSessions.includes(sessionId))
    throw new FinanceError('FINANCE_ACCESS_DENIED', 403);
  if (state.operations.some(op => op.status === 'pending')) throw new FinanceError('RESTORE_QUARANTINED', 503);
  if (expectedEpoch !== undefined && state.epoch !== expectedEpoch) throw new FinanceError('FINANCE_CONFLICT', 409);
}
export function createAuthorityClient(get: (name: string) => string | undefined, fetcher: typeof fetch = fetch): AuthorityClient {
  const secret = get('TR8_FINANCE_AUTHORITY_SECRET') ?? '',
    caseId = get('TR8_FINANCE_RESTORE_CASE') as RestoreCase;
  const configured = get('TR8_FINANCE_AUTHORITY_ID') === RESTORE_AUTHORITY && ['reset', 'revoke', 'purge'].includes(caseId) && /^[a-f0-9]{64}$/.test(secret);
  async function call(action: string, payload: Record<string, unknown>) {
    if (!configured) throw unavailable();
    const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    try {
      const r = await fetcher(`https://tr8-authority-restore-test.sredgarpadilla.workers.dev/v1/cases/${caseId}/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, ...payload }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(await readFinanceBytes(r, 131072)), { maxBytes: 131072 }) as Record<
        string,
        unknown
      >;
      if (!r.ok) {
        if (value.caseId !== caseId || value.nonce !== nonce) throw unavailable();
        const error = requireClosedRecord(value.error, ['code']);
        if (['DENIED', 'CONFLICT', 'PENDING'].includes(String(error.code)))
          throw new FinanceError(error.code === 'DENIED' ? 'FINANCE_ACCESS_DENIED' : 'FINANCE_CONFLICT', error.code === 'DENIED' ? 403 : 409);
        throw unavailable();
      }
      if (value.nonce !== nonce || value.authorityId !== RESTORE_AUTHORITY || value.caseId !== caseId || r.headers.get('cache-control') !== 'no-store')
        throw unavailable();
      return value;
    } catch (error) {
      if (error instanceof FinanceError && ['DEPENDENCY_UNAVAILABLE', 'FINANCE_ACCESS_DENIED', 'FINANCE_CONFLICT'].includes(error.code)) throw error;
      throw unavailable();
    }
  }
  return {
    configured,
    caseId,
    state: async () => {
      const r = requireClosedRecord(await call('state', { ownerId: RESTORE_OWNER }), ['nonce', 'authorityId', 'caseId', 'state']);
      return validateEvidence(r.state);
    },
    prepare: async command => {
      const r = requireClosedRecord(await call('prepare', { command }), ['nonce', 'authorityId', 'caseId', 'receipt']);
      const receipt = requireClosedRecord(r.receipt, ['operationId', 'epoch', 'digest']) as LifecycleReceipt;
      if (
        receipt.operationId !== command.operationId ||
        receipt.epoch !== String(epoch(command.expectedEpoch) + 1n) ||
        receipt.digest !== (await commandDigest(command))
      )
        throw unavailable();
      return { ...receipt };
    },
    commit: async receipt => {
      const r = requireClosedRecord(await call('commit', { ownerId: RESTORE_OWNER, receipt }), ['nonce', 'authorityId', 'caseId', 'receipt']);
      const saved = requireClosedRecord(r.receipt, ['operationId', 'epoch', 'digest']);
      if (saved.operationId !== receipt.operationId || saved.epoch !== receipt.epoch || saved.digest !== receipt.digest) throw unavailable();
    },
  };
}
