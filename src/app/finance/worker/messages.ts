import { MAX_ENVELOPE_BYTES, requireClosedRecord, validateEpoch, type VaultErrorCode } from '../compatibility/protocol';

export interface WorkerIdentity {
  ownerId: string;
  sessionId: string;
  epoch: string;
}
export type VaultWorkerMethod =
  'probe' | 'create' | 'unlock' | 'custody' | 'confirm-custody' | 'read' | 'write' | 'recover' | 'rotate-password' | 'rotate-recovery' | 'rekey' | 'ack';
export interface VaultWorkerRequest {
  id: number;
  generation: number;
  identity: WorkerIdentity;
  method: VaultWorkerMethod;
  value: unknown;
}
export type VaultWorkerReply =
  | { id: number; generation: number; identity: WorkerIdentity; value: unknown }
  | { id: number; generation: number; identity: WorkerIdentity; error: VaultErrorCode };

export function workerIdentity(value: unknown): WorkerIdentity {
  const record = requireClosedRecord(value, ['ownerId', 'sessionId', 'epoch']);
  for (const key of ['ownerId', 'sessionId'])
    if (typeof record[key] !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(record[key])) throw new Error('INVALID_MESSAGE');
  return { ownerId: record.ownerId as string, sessionId: record.sessionId as string, epoch: validateEpoch(record.epoch) };
}
export function matchingWorkerIdentity(left: WorkerIdentity, right: WorkerIdentity): boolean {
  return left.ownerId === right.ownerId && left.sessionId === right.sessionId && left.epoch === right.epoch;
}
export function boundedWorkerValue(value: unknown): void {
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || new TextEncoder().encode(json).length > MAX_ENVELOPE_BYTES) throw new Error('INVALID_MESSAGE');
}
export function parseWorkerRequest(value: unknown): VaultWorkerRequest {
  const record = requireClosedRecord(value, ['id', 'generation', 'identity', 'method', 'value']);
  if (
    !Number.isSafeInteger(record.id) ||
    Number(record.id) < 1 ||
    !Number.isSafeInteger(record.generation) ||
    Number(record.generation) < 1 ||
    !['probe', 'create', 'unlock', 'custody', 'confirm-custody', 'read', 'write', 'recover', 'rotate-password', 'rotate-recovery', 'rekey', 'ack'].includes(
      record.method as string,
    )
  )
    throw new Error('INVALID_MESSAGE');
  boundedWorkerValue(record.value);
  return {
    id: Number(record.id),
    generation: Number(record.generation),
    identity: workerIdentity(record.identity),
    method: record.method as VaultWorkerMethod,
    value: record.value,
  };
}
