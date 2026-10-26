import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import worker, { Tr8SyntheticAuthority, SYNTHETIC_OWNER, SYNTHETIC_VAULT, body } from './worker';
import type { Row } from '../../server/finance-authority/journal-core';
const token = 'f'.repeat(64),
  authorityId = 'f629a76f-842c-4f8e-8557-b4b7fa4563b1',
  nonce = 'BBBBBBBBBBBBBBBBBBBBBA',
  session = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let db: DatabaseSync, env: Parameters<typeof worker.fetch>[1];
function request(path: string, data: unknown, headers: Record<string, string> = {}) {
  return new Request('https://synthetic.invalid' + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: typeof data === 'string' ? data : JSON.stringify(data),
  });
}
const bootstrap = () => worker.fetch(request('/v1/bootstrap', { nonce, authorityId, ownerId: SYNTHETIC_OWNER, vaultId: SYNTHETIC_VAULT }), env);
const check = (epoch = '1') =>
  worker.fetch(request('/v1/check', { nonce, ownerId: SYNTHETIC_OWNER, vaultId: SYNTHETIC_VAULT, sessionId: session, epoch }), env);
const command = (kind = 'reset') => ({
  operationId: nonce,
  ownerId: SYNTHETIC_OWNER,
  expectedEpoch: '1',
  kind,
  vaultId: kind === 'revoke' ? null : SYNTHETIC_VAULT,
  targetSessionId: kind === 'revoke' ? session : null,
});
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  const state = {
    storage: {
      sql: {
        exec: (query: string, ...args: string[]) => {
          const rows = db.prepare(query).all(...args) as Row[];
          return { toArray: () => rows };
        },
      },
      transactionSync: <T>(action: () => T): T => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = action();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    },
  };
  env = {
    MODE: 'synthetic-only',
    AUTHORITY_ID: authorityId,
    ACCESS_TOKEN: token,
    JOURNAL: { idFromName: () => authorityId, get: () => ({ fetch: r => object.fetch(r) }) },
  };
  const object = new Tr8SyntheticAuthority(state, env);
});
afterEach(() => db.close());
describe('Cloudflare synthetic Worker HTTP boundary with real SQLite adapter', () => {
  it('cancels a stalled body without waiting for its sender or touching SQLite', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const request = new Request('https://synthetic.invalid/v1/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: new ReadableStream<Uint8Array>({ cancel }),
        duplex: 'half',
      } as RequestInit);
      const pending = body(request).then(
        () => 'accepted',
        error => error.code,
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(await Promise.race([pending, Promise.resolve('still-reading')])).toBe('INVALID_INPUT');
      expect(cancel).toHaveBeenCalledOnce();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('requires a secret before allocating or reading a journal', async () => {
    delete env.ACCESS_TOKEN;
    expect((await bootstrap()).status).toBe(401);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
  });
  it('denies a wrong token and browser requests', async () => {
    expect((await worker.fetch(request('/v1/bootstrap', {}, { Authorization: `Bearer ${'0'.repeat(64)}` }), env)).status).toBe(401);
    expect((await worker.fetch(request('/v1/bootstrap', {}, { Origin: 'https://tr8.vercel.app' }), env)).status).toBe(403);
  });
  it('requires explicit bootstrap; opening/checking never auto-initializes', async () => {
    expect((await check()).status).toBe(503);
    expect((await bootstrap()).status).toBe(200);
    const result = await check();
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ nonce, authorityId, allowed: true, syntheticOnly: true });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(result.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('rejects real owners even when holding the service credential', async () => {
    const result = await worker.fetch(request('/v1/bootstrap', { nonce, authorityId, ownerId: session, vaultId: SYNTHETIC_VAULT }), env);
    expect(result.status).toBe(403);
  });
  it('rejects another authority or an arbitrary context at bootstrap', async () => {
    expect(
      (await worker.fetch(request('/v1/bootstrap', { nonce, authorityId: session, ownerId: SYNTHETIC_OWNER, vaultId: SYNTHETIC_VAULT }), env)).status,
    ).toBe(403);
  });
  it.each(['reset', 'revoke', 'purge'])('commits %s and never trusts a restored epoch or an old receipt', async kind => {
    await bootstrap();
    const pending = await worker.fetch(request('/v1/prepare', { nonce, command: command(kind) }), env);
    expect(pending.status).toBe(200);
    const receipt = (await pending.json()).receipt;
    expect((await check()).status).toBe(409);
    expect((await worker.fetch(request('/v1/commit', { nonce, ownerId: SYNTHETIC_OWNER, receipt }), env)).status).toBe(200);
    expect((await check()).status).toBe(403);
    await bootstrap();
    expect((await check()).status).toBe(403);
  });
  it('never accepts an altered confirmation or a different command under the same ID', async () => {
    await bootstrap();
    const receipt = (await (await worker.fetch(request('/v1/prepare', { nonce, command: command() }), env)).json()).receipt;
    expect((await worker.fetch(request('/v1/commit', { nonce, ownerId: SYNTHETIC_OWNER, receipt: { ...receipt, epoch: '3' } }), env)).status).toBe(409);
    expect((await worker.fetch(request('/v1/prepare', { nonce, command: command('purge') }), env)).status).toBe(409);
    expect((await check()).status).toBe(409);
  });
  it('bounds the streamed input before parsing', async () => {
    const result = await worker.fetch(request('/v1/bootstrap', 'x'.repeat(4097)), env);
    expect(result.status).toBe(400);
  });
  it('does not accept unknown input fields', async () => {
    const result = await worker.fetch(request('/v1/bootstrap', { nonce, authorityId, ownerId: SYNTHETIC_OWNER, vaultId: SYNTHETIC_VAULT, amount: 1 }), env);
    expect(result.ok).toBe(false);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
  });
});
