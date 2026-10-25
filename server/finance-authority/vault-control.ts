/** Independent opaque-head control. Stores hashes and security metadata, never vault bytes. */
import { epoch, fail, opaque, uuid, type JournalSql } from './journal-core.ts';
import { requireClosedRecord, validateEnvelope, type VaultEnvelope } from '../../src/app/finance/compatibility/protocol.ts';
export const CONTROL_PROTOCOL = 1;
const hex = /^[a-f0-9]{64}$/;
export function stable(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(k => JSON.stringify(k) + ':' + stable((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  return fail('INVALID_INPUT');
}
export async function sha256(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
}
export interface VaultHead {
  vaultId: string;
  revision: string;
  keyEpoch: string;
  credentialEpoch: string;
  operationId: string;
  digest: string;
  requestDigest: string;
}
export interface ControlState {
  ownerId: string;
  sequence: string;
  head: VaultHead | null;
  status: 'active' | 'disabled' | 'deleted';
  sessionEpoch: string;
  sessionCutoffMs: number;
  sessions: Record<string, string>;
  revokedSessions: string[];
  retiredVaults: string[];
}
export type ControlKind = 'put' | 'enroll' | 'revoke' | 'logout-all' | 'disable' | 'delete' | 'reset';
export interface ControlCommand {
  ownerId: string;
  operationId: string;
  expectedSequence: string;
  kind: ControlKind;
  expectedHead: VaultHead | null;
  head: VaultHead | null;
  actorSessionId: string;
  sessionCreatedAtMs: number;
  targetSessionId: string | null;
}
export interface ControlIntent {
  command: ControlCommand;
  digest: string;
  next: ControlState;
  preparedAtMs: number;
  status: 'pending' | 'committed';
}
export function head(value: unknown): VaultHead {
  const h = requireClosedRecord(value, ['vaultId', 'revision', 'keyEpoch', 'credentialEpoch', 'operationId', 'digest', 'requestDigest']);
  if (
    typeof h.vaultId !== 'string' ||
    !opaque.test(h.vaultId) ||
    typeof h.operationId !== 'string' ||
    !opaque.test(h.operationId) ||
    typeof h.digest !== 'string' ||
    !hex.test(h.digest) ||
    typeof h.requestDigest !== 'string' ||
    !hex.test(h.requestDigest)
  )
    fail('INVALID_INPUT');
  for (const key of ['revision', 'keyEpoch', 'credentialEpoch']) epoch(h[key]);
  return { ...h } as unknown as VaultHead;
}
export function controlState(value: unknown): ControlState {
  const s = requireClosedRecord(value, [
    'ownerId',
    'sequence',
    'head',
    'status',
    'sessionEpoch',
    'sessionCutoffMs',
    'sessions',
    'revokedSessions',
    'retiredVaults',
  ]);
  if (typeof s.ownerId !== 'string' || !uuid.test(s.ownerId)) fail('INVALID_INPUT');
  epoch(s.sequence);
  epoch(s.sessionEpoch);
  if (
    !['active', 'disabled', 'deleted'].includes(s.status as string) ||
    typeof s.sessionCutoffMs !== 'number' ||
    !Number.isSafeInteger(s.sessionCutoffMs) ||
    s.sessionCutoffMs < 0 ||
    !s.sessions ||
    Object.getPrototypeOf(s.sessions) !== Object.prototype
  )
    fail('INVALID_INPUT');
  const sessions = s.sessions as Record<string, string>;
  if (Object.keys(sessions).length > 256) fail('UNAVAILABLE');
  for (const [id, generation] of Object.entries(sessions)) {
    if (!uuid.test(id)) fail('INVALID_INPUT');
    epoch(generation);
    if (generation !== s.sessionEpoch) fail('INVALID_INPUT');
  }
  const list = (v: unknown, pattern: RegExp) => {
    if (!Array.isArray(v) || v.length > 4096 || new Set(v).size !== v.length || v.some(id => typeof id !== 'string' || !pattern.test(id)))
      return fail('INVALID_INPUT');
    return [...v].sort() as string[];
  };
  const revokedSessions = list(s.revokedSessions, uuid),
    retiredVaults = list(s.retiredVaults, opaque);
  if (revokedSessions.some(id => id in sessions)) fail('INVALID_INPUT');
  const current = s.head === null ? null : head(s.head);
  if (current && retiredVaults.includes(current.vaultId)) fail('INVALID_INPUT');
  return {
    ownerId: s.ownerId,
    sequence: s.sequence as string,
    head: current,
    status: s.status as ControlState['status'],
    sessionEpoch: s.sessionEpoch as string,
    sessionCutoffMs: s.sessionCutoffMs,
    sessions: { ...sessions },
    revokedSessions,
    retiredVaults,
  };
}
export function initialControlState(ownerId: string): ControlState {
  return controlState({
    ownerId,
    sequence: '1',
    head: null,
    status: 'active',
    sessionEpoch: '1',
    sessionCutoffMs: 0,
    sessions: {},
    revokedSessions: [],
    retiredVaults: [],
  });
}
export function controlCommand(value: unknown): ControlCommand {
  const c = requireClosedRecord(value, [
    'ownerId',
    'operationId',
    'expectedSequence',
    'kind',
    'expectedHead',
    'head',
    'actorSessionId',
    'sessionCreatedAtMs',
    'targetSessionId',
  ]);
  if (
    typeof c.ownerId !== 'string' ||
    !uuid.test(c.ownerId) ||
    typeof c.operationId !== 'string' ||
    !opaque.test(c.operationId) ||
    !['put', 'enroll', 'revoke', 'logout-all', 'disable', 'delete', 'reset'].includes(c.kind as string) ||
    typeof c.actorSessionId !== 'string' ||
    !uuid.test(c.actorSessionId) ||
    typeof c.sessionCreatedAtMs !== 'number' ||
    !Number.isSafeInteger(c.sessionCreatedAtMs) ||
    c.sessionCreatedAtMs < 0
  )
    fail('INVALID_INPUT');
  epoch(c.expectedSequence);
  const next = c.head === null ? null : head(c.head);
  if (c.kind === 'put' ? next === null || c.operationId !== next.operationId : next !== null) fail('INVALID_INPUT');
  if (c.kind === 'revoke' ? typeof c.targetSessionId !== 'string' || !uuid.test(c.targetSessionId) : c.targetSessionId !== null) fail('INVALID_INPUT');
  return {
    ownerId: c.ownerId,
    operationId: c.operationId,
    expectedSequence: c.expectedSequence as string,
    kind: c.kind as ControlKind,
    expectedHead: c.expectedHead === null ? null : head(c.expectedHead),
    head: next,
    actorSessionId: c.actorSessionId,
    sessionCreatedAtMs: c.sessionCreatedAtMs,
    targetSessionId: c.targetSessionId as string | null,
  };
}
export function assertControlAccess(state: ControlState, sessionId: string) {
  if (state.status !== 'active' || state.revokedSessions.includes(sessionId) || state.sessions[sessionId] !== state.sessionEpoch) fail('DENIED');
}
export function advance(state: ControlState, command: ControlCommand, nowMs = Date.now()): ControlState {
  if (state.ownerId !== command.ownerId || state.sequence !== command.expectedSequence || stable(state.head) !== stable(command.expectedHead)) fail('CONFLICT');
  if (state.status !== 'active') fail('DENIED');
  const result = structuredClone(state);
  if (command.kind === 'enroll') {
    if (
      state.revokedSessions.includes(command.actorSessionId) ||
      command.actorSessionId in state.sessions ||
      command.sessionCreatedAtMs <= state.sessionCutoffMs ||
      command.sessionCreatedAtMs > nowMs + 1000
    )
      fail('DENIED');
    result.sessions[command.actorSessionId] = state.sessionEpoch;
  } else {
    assertControlAccess(state, command.actorSessionId);
    const previous = state.head,
      next = command.head;
    if (command.kind === 'put') {
      if (!next || state.retiredVaults.includes(next.vaultId)) fail('DENIED');
      if (previous) {
        if (
          previous.vaultId !== next.vaultId ||
          epoch(next.revision) !== epoch(previous.revision) + 1n ||
          next.digest === previous.digest ||
          next.operationId === previous.operationId
        )
          fail('CONFLICT');
        for (const k of ['keyEpoch', 'credentialEpoch'] as const)
          if (epoch(next[k]) < epoch(previous[k]) || epoch(next[k]) > epoch(previous[k]) + 1n) fail('CONFLICT');
      } else if ([next.revision, next.keyEpoch, next.credentialEpoch].some(n => n !== '1')) fail('CONFLICT');
      result.head = next;
    } else if (command.kind === 'revoke') {
      if (!(command.targetSessionId! in state.sessions)) fail('DENIED');
      delete result.sessions[command.targetSessionId!];
      result.revokedSessions = [...new Set([...result.revokedSessions, command.targetSessionId!])].sort();
    } else {
      result.revokedSessions = [...new Set([...result.revokedSessions, ...Object.keys(result.sessions)])].sort();
      result.sessions = {};
      result.sessionEpoch = String(epoch(result.sessionEpoch) + 1n);
      epoch(result.sessionEpoch);
      result.sessionCutoffMs = Math.max(result.sessionCutoffMs, nowMs);
      if (command.kind === 'disable') result.status = 'disabled';
      if (command.kind === 'delete' || command.kind === 'reset') {
        if (result.head) result.retiredVaults = [...new Set([...result.retiredVaults, result.head.vaultId])].sort();
        result.head = null;
        if (command.kind === 'delete') result.status = 'deleted';
      }
    }
  }
  const sequence = epoch(state.sequence) + 1n;
  if (sequence > 9223372036854775807n) fail('CONFLICT');
  result.sequence = String(sequence);
  return controlState(result);
}
export async function envelopeHead(value: unknown, requestDigest: string): Promise<VaultHead> {
  const e = validateEnvelope(value);
  return head({
    vaultId: e.vaultId,
    revision: e.revision,
    keyEpoch: e.keyEpoch,
    credentialEpoch: e.credentialEpoch,
    operationId: e.operationId,
    digest: await sha256(stable(e)),
    requestDigest,
  });
}
export async function assertCurrentEnvelope(state: ControlState, envelope: VaultEnvelope | null) {
  if (state.head === null) {
    if (envelope !== null) fail('CONFLICT');
    return;
  }
  if (envelope === null || envelope.ownerId !== state.ownerId || stable(await envelopeHead(envelope, state.head.requestDigest)) !== stable(state.head))
    fail('CONFLICT');
}
export const CONTROL_SCHEMA = `CREATE TABLE control_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),authority_id TEXT NOT NULL,protocol INTEGER NOT NULL);
CREATE TABLE control_owners(owner_id TEXT PRIMARY KEY,state TEXT NOT NULL);
CREATE TABLE control_intents(operation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,command TEXT NOT NULL,digest TEXT NOT NULL,next_state TEXT NOT NULL,prepared_at_ms INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','committed')));
CREATE UNIQUE INDEX control_one_pending ON control_intents(owner_id) WHERE status='pending';`;
export class VaultControlJournal {
  constructor(
    private readonly sql: JournalSql,
    readonly authorityId: string,
  ) {
    const m = sql.get('SELECT * FROM control_meta WHERE singleton=1');
    if (!uuid.test(authorityId) || m?.authority_id !== authorityId || m.protocol !== CONTROL_PROTOCOL) fail('UNTRUSTED_AUTHORITY');
  }
  state(ownerId: string): ControlState {
    const row = this.sql.get('SELECT state FROM control_owners WHERE owner_id=?', ownerId);
    if (!row) fail('UNTRUSTED_AUTHORITY');
    return controlState(JSON.parse(String(row.state)));
  }
  operation(ownerId: string, operationId: string): ControlIntent | null {
    const row = this.sql.get('SELECT * FROM control_intents WHERE owner_id=? AND operation_id=?', ownerId, operationId);
    if (!row) return null;
    return {
      command: controlCommand(JSON.parse(String(row.command))),
      digest: String(row.digest),
      next: controlState(JSON.parse(String(row.next_state))),
      preparedAtMs: Number(row.prepared_at_ms),
      status: row.status as ControlIntent['status'],
    };
  }
  pending(ownerId: string): ControlIntent | null {
    const row = this.sql.get("SELECT operation_id FROM control_intents WHERE owner_id=? AND status='pending'", ownerId);
    return row ? this.operation(ownerId, String(row.operation_id)) : null;
  }
  prepare(value: unknown, digest: string, nowMs = Date.now()): ControlIntent {
    const command = controlCommand(value);
    if (!hex.test(digest)) fail('INVALID_INPUT');
    return this.sql.transaction(() => {
      const prior = this.operation(command.ownerId, command.operationId);
      if (prior) {
        if (stable(prior.command) !== stable(command) || prior.digest !== digest) fail('CONFLICT');
        return prior;
      }
      if (this.pending(command.ownerId)) fail('PENDING');
      const next = advance(this.state(command.ownerId), command, nowMs);
      this.sql.run(
        "INSERT INTO control_intents VALUES(?,?,?,?,?,?,'pending')",
        command.operationId,
        command.ownerId,
        stable(command),
        digest,
        stable(next),
        String(nowMs),
      );
      return { command, digest, next, preparedAtMs: nowMs, status: 'pending' };
    });
  }
  commit(ownerId: string, operationId: string, digest: string): ControlState {
    return this.sql.transaction(() => {
      const op = this.operation(ownerId, operationId);
      if (!op || op.digest !== digest) fail('CONFLICT');
      if (op.status === 'committed') return op.next;
      if (stable(advance(this.state(ownerId), op.command, op.preparedAtMs)) !== stable(op.next)) fail('CONFLICT');
      this.sql.run('UPDATE control_owners SET state=? WHERE owner_id=?', stable(op.next), ownerId);
      this.sql.run("UPDATE control_intents SET status='committed' WHERE operation_id=?", operationId);
      return op.next;
    });
  }
}
