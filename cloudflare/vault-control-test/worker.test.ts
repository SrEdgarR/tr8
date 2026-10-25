import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import worker, { Tr8VaultControl } from './worker';
import type { Row } from '../../server/finance-authority/journal-core';
const owner = '37848d70-989a-4f69-b124-0c959d8b49a6',
  authorityId = 'c59d8b98-4cbf-4f74-a968-0c591a3d794a',
  token = 'f'.repeat(64),
  nonce = 'AAAAAAAAAAAAAAAAAAAAAA';
let db: DatabaseSync, env: Parameters<typeof worker.fetch>[1];
function request(action: string, payload: unknown, extra: Record<string, string> = {}) {
  return new Request('https://synthetic.invalid/v1/cases/heads/' + action, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify({ nonce, ...(payload as object) }),
  });
}
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  const state = {
    storage: {
      sql: {
        exec: (q: string, ...a: string[]) => {
          const rows = db.prepare(q).all(...a) as Row[];
          return { toArray: () => rows };
        },
      },
      transactionSync: <T>(f: () => T) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const r = f();
          db.exec('COMMIT');
          return r;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
  };
  env = {
    MODE: 'synthetic-only',
    AUTHORITY_ID: authorityId,
    BOOTSTRAP_ENABLED: 'true',
    ACCESS_TOKEN: token,
    JOURNAL: { idFromName: n => n, get: () => ({ fetch: r => object.fetch(r) }) },
  };
  const object = new Tr8VaultControl(state, env);
});
afterEach(() => db.close());
describe('synthetic control Worker HTTP boundary', () => {
  it('does not allocate storage before service authentication', async () => {
    delete env.ACCESS_TOKEN;
    expect((await worker.fetch(request('state', { ownerId: owner }), env)).status).toBe(401);
    expect(db.prepare("select name from sqlite_master where type='table'").all()).toEqual([]);
  });
  it('rejects browsers and unknown routes before a journal is opened', async () => {
    expect((await worker.fetch(request('bootstrap', { ownerId: owner, authorityId }, { Origin: 'https://tr8.vercel.app' }), env)).status).toBe(403);
    expect((await worker.fetch(request('restore-everything', {}), env)).status).toBe(403);
  });
  it('never initializes missing state on a read', async () => {
    expect((await worker.fetch(request('state', { ownerId: owner }), env)).status).toBe(503);
    expect(db.prepare("select name from sqlite_master where type='table'").all()).toEqual([]);
  });
  it('requires an explicit one-time bootstrap and never overwrites existing facts', async () => {
    expect((await worker.fetch(request('bootstrap', { ownerId: owner, authorityId }), env)).status).toBe(200);
    expect((await worker.fetch(request('bootstrap', { ownerId: owner, authorityId }), env)).status).toBe(409);
    const r = await worker.fetch(request('state', { ownerId: owner }), env);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toMatchObject({ nonce, authorityId, caseId: 'heads', state: { sequence: '1', head: null, sessions: {} } });
  });
  it('denies bootstrap after provisioning even if the service credential is available', async () => {
    env.BOOTSTRAP_ENABLED = 'false';
    expect((await worker.fetch(request('bootstrap', { ownerId: owner, authorityId }), env)).status).toBe(403);
    expect(db.prepare("select name from sqlite_master where type='table'").all()).toEqual([]);
  });
  it('cannot bootstrap a real owner or another authority', async () => {
    expect((await worker.fetch(request('bootstrap', { ownerId: authorityId, authorityId }), env)).status).toBe(403);
    expect((await worker.fetch(request('bootstrap', { ownerId: owner, authorityId: owner }), env)).status).toBe(403);
  });
});
