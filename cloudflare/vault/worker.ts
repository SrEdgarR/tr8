/** Personal vault journal. Pinned to one server-configured owner and deployment generation. */
import { authenticated, body } from '../finance-authority-test/worker';
import { JournalError, type JournalSql, type Row, fail } from '../../server/finance-authority/journal-core';
import {
  CONTROL_SCHEMA,
  CONTROL_PROTOCOL,
  VaultControlJournal,
  initialControlState,
  controlCommand,
  stable,
  sha256,
} from '../../server/finance-authority/vault-control';
import { requireClosedRecord } from '../../src/app/finance/compatibility/protocol';
interface Env {
  OWNER_ID: string;
  BOOTSTRAP_ENABLED?: string;
  MODE: string;
  AUTHORITY_ID: string;
  ACCESS_TOKEN?: string;
  JOURNAL: { idFromName(name: string): unknown; get(id: unknown): { fetch(r: Request): Promise<Response> } };
}
interface State {
  storage: { sql: { exec(query: string, ...args: string[]): { toArray(): Row[] } }; transactionSync<T>(f: () => T): T };
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
export class Tr8PersonalVault {
  constructor(
    private readonly state: State,
    private readonly env: Env,
  ) {}
  async fetch(request: Request) {
    const OWNER = this.env.OWNER_ID;
    let nonce: string | undefined;
    try {
      if (!(await authenticated(request, { ...this.env, MODE: 'synthetic-only' }))) return json({ error: { code: 'AUTH_REQUIRED' } }, 401);
      const path = new URL(request.url).pathname.split('/').pop();
      const fields =
        path === 'bootstrap'
          ? ['authorityId', 'ownerId']
          : path === 'prepare'
            ? ['command']
            : path === 'commit'
              ? ['ownerId', 'operationId', 'digest']
              : path === 'operation'
                ? ['ownerId', 'operationId']
                : ['ownerId'];
      const data = requireClosedRecord(await body(request), ['nonce', ...fields]);
      nonce = data.nonce as string;
      if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(nonce)) fail('INVALID_INPUT');
      const sql: JournalSql = {
        get: (q, ...a) => this.state.storage.sql.exec(q, ...a).toArray()[0],
        all: (q, ...a) => this.state.storage.sql.exec(q, ...a).toArray(),
        run: (q, ...a) => {
          this.state.storage.sql.exec(q, ...a);
        },
        transaction: f => this.state.storage.transactionSync(f),
      };
      if (path === 'bootstrap') {
        if (this.env.BOOTSTRAP_ENABLED !== 'true') fail('DENIED');
        if (data.authorityId !== this.env.AUTHORITY_ID || data.ownerId !== OWNER) fail('DENIED');
        sql.transaction(() => {
          if (sql.get("SELECT name FROM sqlite_master WHERE type='table' AND name='control_meta'")) fail('CONFLICT');
          for (const s of CONTROL_SCHEMA.split(';').filter(s => s.trim())) sql.run(s);
          sql.run('INSERT INTO control_meta VALUES(1,?,?)', this.env.AUTHORITY_ID, String(CONTROL_PROTOCOL));
          sql.run('INSERT INTO control_owners VALUES(?,?)', OWNER, stable(initialControlState(OWNER)));
        });
        return json({ nonce, authorityId: this.env.AUTHORITY_ID, bootstrapped: true });
      }
      const journal = new VaultControlJournal(sql, this.env.AUTHORITY_ID);
      if (path === 'prepare') {
        const command = controlCommand(data.command);
        if (command.ownerId !== OWNER) fail('DENIED');
        return json({ nonce, authorityId: this.env.AUTHORITY_ID, intent: journal.prepare(command, await sha256(stable(command))) });
      }
      if (data.ownerId !== OWNER) fail('DENIED');
      if (path === 'state')
        return sql.transaction(() => json({ nonce, authorityId: this.env.AUTHORITY_ID, state: journal.state(OWNER), pending: journal.pending(OWNER) }));
      if (path === 'operation') return json({ nonce, authorityId: this.env.AUTHORITY_ID, intent: journal.operation(OWNER, String(data.operationId)) });
      if (path === 'commit')
        return json({ nonce, authorityId: this.env.AUTHORITY_ID, state: journal.commit(OWNER, String(data.operationId), String(data.digest)) });
      fail('INVALID_INPUT');
    } catch (error) {
      const code = error instanceof JournalError ? error.code : 'UNAVAILABLE';
      return json({ ...(nonce ? { nonce } : {}), error: { code } }, code === 'DENIED' ? 403 : code === 'CONFLICT' || code === 'PENDING' ? 409 : 503);
    }
  }
}
export default {
  async fetch(request: Request, env: Env) {
    try {
      if (!['personal', 'staging'].includes(env.MODE) || !/^[a-f0-9-]{36}$/.test(env.OWNER_ID)) return json({ error: { code: 'DENIED' } }, 403);
      if (!(await authenticated(request, { ...env, MODE: 'synthetic-only' }))) return json({ error: { code: 'AUTH_REQUIRED' } }, 401);
      const u = new URL(request.url),
        route = /^\/v1\/cases\/(personal|staging)\/(bootstrap|state|operation|prepare|commit)$/.exec(u.pathname);
      if (!route || route[1] !== env.MODE || u.search || u.protocol !== 'https:' || request.method !== 'POST' || request.headers.has('Origin'))
        return json({ error: { code: 'DENIED' } }, 403);
      if (route[2] === 'bootstrap' && env.BOOTSTRAP_ENABLED !== 'true') return json({ error: { code: 'DENIED' } }, 403);
      const r = await env.JOURNAL.get(env.JOURNAL.idFromName(env.AUTHORITY_ID + '/' + route[1])).fetch(request);
      return Response.json({ ...(await r.json()), caseId: route[1] }, { status: r.status, headers: r.headers });
    } catch {
      return json({ error: { code: 'UNAVAILABLE' } }, 503);
    }
  },
};
