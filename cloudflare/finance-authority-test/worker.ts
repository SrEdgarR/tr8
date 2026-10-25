/** 6B.5B synthetic service only. It is not a financial admission authority. */
import {
  JOURNAL_SCHEMA,
  JournalError,
  SyntheticLifecycleJournal,
  canonical,
  fail,
  opaque,
  type JournalSql,
  type LifecycleCommand,
  type LifecycleReceipt,
  type Row,
} from '../../server/finance-authority/journal-core';
import { parseStrictJson, requireClosedRecord } from '../../src/app/finance/compatibility/protocol';

export const SYNTHETIC_OWNER = '37848d70-989a-4f69-b124-0c959d8b49a6';
export const SYNTHETIC_VAULT = 'AAAAAAAAAAAAAAAAAAAAAA';
interface State {
  storage: { sql: { exec(query: string, ...values: string[]): { toArray(): Row[] } }; transactionSync<T>(work: () => T): T };
}
interface Environment {
  MODE: string;
  AUTHORITY_ID: string;
  ACCESS_TOKEN?: string;
  JOURNAL: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
}
const encode = (value: string) => new TextEncoder().encode(value);
const paths = ['/v1/bootstrap', '/v1/check', '/v1/prepare', '/v1/commit', '/v1/state'];
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
  });
}
async function authenticated(request: Request, env: Environment): Promise<boolean> {
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (env.MODE !== 'synthetic-only' || !env.ACCESS_TOKEN || !/^[a-f0-9]{64}$/.test(env.ACCESS_TOKEN) || !token) return false;
  const key = await crypto.subtle.importKey('raw', encode(env.ACCESS_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const expected = await crypto.subtle.sign('HMAC', key, encode(env.ACCESS_TOKEN));
  return crypto.subtle.verify('HMAC', key, expected, encode(token));
}
async function body(request: Request): Promise<unknown> {
  if (request.headers.get('Content-Type') !== 'application/json' || request.headers.has('Content-Encoding') || !request.body) fail('INVALID_INPUT');
  const reader = request.body.getReader();
  const bytes = new Uint8Array(4096);
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.length > bytes.length - size) {
        await reader.cancel();
        fail('INVALID_INPUT');
      }
      bytes.set(part.value, size);
      size += part.value.length;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)), { maxBytes: 4096 });
  } catch {
    return fail('INVALID_INPUT');
  }
}
function closed(value: unknown, keys: string[]) {
  try {
    return requireClosedRecord(value, keys);
  } catch {
    return fail('INVALID_INPUT');
  }
}
function input(value: unknown, keys: string[]) {
  const record = closed(value, ['nonce', ...keys]);
  if (typeof record.nonce !== 'string' || !opaque.test(record.nonce)) fail('INVALID_INPUT');
  return record;
}
function requireOwner(value: unknown) {
  if (value !== SYNTHETIC_OWNER) fail('DENIED');
}
function allowedRequest(request: Request) {
  const url = new URL(request.url);
  return url.protocol === 'https:' && request.method === 'POST' && !url.search && !request.headers.has('Origin') && paths.includes(url.pathname);
}

export class Tr8SyntheticAuthority {
  constructor(
    private readonly state: State,
    private readonly env: Environment,
  ) {}
  async fetch(request: Request): Promise<Response> {
    let nonce: string | undefined;
    try {
      if (!(await authenticated(request, this.env))) return response({ error: { code: 'AUTH_REQUIRED' } }, 401);
      if (!allowedRequest(request)) return response({ error: { code: 'CONTEXT_DENIED' } }, 403);
      const path = new URL(request.url).pathname;
      const raw = await body(request);
      const sql: JournalSql = {
        get: (query, ...args) => this.state.storage.sql.exec(query, ...args).toArray()[0],
        all: (query, ...args) => this.state.storage.sql.exec(query, ...args).toArray(),
        run: (query, ...args) => {
          this.state.storage.sql.exec(query, ...args);
        },
        transaction: work => this.state.storage.transactionSync(work),
      };
      if (path === '/v1/bootstrap') {
        const data = input(raw, ['authorityId', 'ownerId', 'vaultId']);
        nonce = data.nonce as string;
        requireOwner(data.ownerId);
        if (data.authorityId !== this.env.AUTHORITY_ID || data.vaultId !== SYNTHETIC_VAULT) fail('DENIED');
        this.state.storage.transactionSync(() => {
          const table = sql.get("SELECT name FROM sqlite_master WHERE type='table' AND name='authority'");
          if (table) {
            if (sql.get('SELECT authority_id FROM authority WHERE singleton=1')?.authority_id !== this.env.AUTHORITY_ID) fail('UNTRUSTED_AUTHORITY');
            return;
          }
          for (const statement of JOURNAL_SCHEMA.split(';').filter(s => s.trim())) this.state.storage.sql.exec(statement);
          sql.run('INSERT INTO authority VALUES(1,?)', this.env.AUTHORITY_ID);
          sql.run('INSERT INTO owners(owner_id,epoch) VALUES(?,?)', SYNTHETIC_OWNER, '1');
          sql.run('INSERT INTO vaults(vault_id,owner_id) VALUES(?,?)', SYNTHETIC_VAULT, SYNTHETIC_OWNER);
        });
        return response({ nonce, authorityId: this.env.AUTHORITY_ID, syntheticOnly: true });
      }
      const journal = new SyntheticLifecycleJournal(sql, this.env.AUTHORITY_ID);
      if (path === '/v1/state') {
        const data = input(raw, ['ownerId']);
        nonce = data.nonce as string;
        requireOwner(data.ownerId);
        return response({ nonce, authorityId: this.env.AUTHORITY_ID, state: journal.snapshot(SYNTHETIC_OWNER) });
      }
      if (path === '/v1/prepare') {
        const data = input(raw, ['command']);
        nonce = data.nonce as string;
        const command = JSON.parse(canonical(data.command as LifecycleCommand)) as LifecycleCommand;
        requireOwner(command.ownerId);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encode(canonical(command)))))
          .map(n => n.toString(16).padStart(2, '0'))
          .join('');
        return response({ nonce, authorityId: this.env.AUTHORITY_ID, receipt: journal.prepare(command, digest) });
      }
      if (path === '/v1/commit') {
        const data = input(raw, ['ownerId', 'receipt']);
        nonce = data.nonce as string;
        requireOwner(data.ownerId);
        const receipt = closed(data.receipt, ['operationId', 'epoch', 'digest']) as LifecycleReceipt;
        return response({ nonce, authorityId: this.env.AUTHORITY_ID, receipt: journal.commit(SYNTHETIC_OWNER, receipt) });
      }
      const data = input(raw, ['ownerId', 'sessionId', 'vaultId', 'epoch']);
      nonce = data.nonce as string;
      requireOwner(data.ownerId);
      journal.assertProjection({ ownerId: SYNTHETIC_OWNER, sessionId: data.sessionId as string, vaultId: data.vaultId as string, epoch: data.epoch as string });
      return response({ nonce, authorityId: this.env.AUTHORITY_ID, allowed: true, syntheticOnly: true });
    } catch (error) {
      const code = error instanceof JournalError ? error.code : 'UNAVAILABLE';
      const status =
        code === 'INVALID_INPUT' ? 400 : code === 'UNAVAILABLE' || code === 'UNTRUSTED_AUTHORITY' ? 503 : code === 'PENDING' || code === 'CONFLICT' ? 409 : 403;
      return response({ ...(nonce ? { nonce } : {}), error: { code } }, status);
    }
  }
}
export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    try {
      if (!(await authenticated(request, env))) return response({ error: { code: 'AUTH_REQUIRED' } }, 401);
      if (!allowedRequest(request)) return response({ error: { code: 'CONTEXT_DENIED' } }, 403);
      return await env.JOURNAL.get(env.JOURNAL.idFromName(env.AUTHORITY_ID)).fetch(request);
    } catch {
      return response({ error: { code: 'UNAVAILABLE' } }, 503);
    }
  },
};
