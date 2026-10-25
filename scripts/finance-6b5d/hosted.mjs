/** Synthetic acceptance operator. Run with Node 24 --experimental-transform-types. */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stable, sha256, envelopeHead } from '../../server/finance-authority/vault-control.ts';
import { signRecoveryCheckpoint, keyFingerprint, assessAuthorityRecovery } from '../../server/finance-authority/recovery.ts';
const [phase, privateDir, fixturePath, caseId = 'heads'] = process.argv.slice(2),
  root = fileURLToPath(new URL('../../', import.meta.url));
function outside(p) {
  if (!p || !isAbsolute(p)) throw Error('Absolute private path required');
  const r = relative(root, resolve(p));
  if (!r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep))) throw Error('Private material must remain outside Git');
}
outside(privateDir);
outside(fixturePath);
await mkdir(privateDir, { recursive: true });
const owner = '37848d70-989a-4f69-b124-0c959d8b49a6',
  authorityId = 'c59d8b98-4cbf-4f74-a968-0c591a3d794a';
const cases = ['heads', 'revoke', 'logout', 'disable', 'delete', 'reset', 'resume', 'recovery'];
if (!cases.includes(caseId)) throw Error('Wrong case');
const url = 'https://kajcbwlnqcwcpbtqyieo.supabase.co',
  origin = 'http://127.0.0.1:5174',
  edge = url + '/functions/v1/tr8-vault-control-test',
  cf = 'https://tr8-vault-control-test.sredgarpadilla.workers.dev/v1/cases/';
const file = name => resolve(privateDir, name),
  id = () => randomBytes(16).toString('base64url');
if (phase === 'init') {
  const secret = randomBytes(32).toString('hex');
  await writeFile(file('cf-secret.json'), JSON.stringify({ ACCESS_TOKEN: secret }), { flag: 'wx', mode: 0o600 });
  await writeFile(file('cf-close.json'), JSON.stringify({ ACCESS_TOKEN: null }), { flag: 'wx', mode: 0o600 });
  await writeFile(
    file('edge.env'),
    `TR8_VAULT_CONTROL_TESTING_ENABLED=true\nTR8_VAULT_CONTROL_AUTHORITY=${authorityId}\nTR8_VAULT_CONTROL_CASE=${caseId}\nTR8_VAULT_CONTROL_SECRET=${secret}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(file('edge-closed.env'), 'TR8_VAULT_CONTROL_TESTING_ENABLED=false\nTR8_VAULT_CONTROL_SECRET=closed\n', { flag: 'wx', mode: 0o600 });
  console.log('Synthetic private configuration prepared');
  process.exit(0);
}
const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
if (fixtures.url !== url || fixtures.users.owner.id !== owner || !fixtures.users.owner.email.endsWith('@example.test')) throw Error('Wrong isolated fixture');
const secret = JSON.parse(await readFile(file('cf-secret.json'), 'utf8')).ACCESS_TOKEN,
  checks = [];
async function checked(label, r, status) {
  const d = await r.json();
  if (!(Array.isArray(status) ? status.includes(r.status) : r.status === status))
    throw Error(`${label}: expected ${status}, got ${r.status} (${d.error?.code ?? d.code ?? 'unknown'})`);
  checks.push({ label, status: r.status, code: d.error?.code ?? null });
  return d;
}
async function cloud(action, payload = {}, status = 200, which = caseId) {
  const nonce = id();
  const d = await checked(
    'authority/' + action,
    await fetch(cf + which + '/' + action, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, ...payload }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    }),
    status,
  );
  if (status === 200 && (d.nonce !== nonce || d.authorityId !== authorityId || d.caseId !== which)) throw Error('Wrong authority');
  return d;
}
if (phase === 'bootstrap-all') {
  for (const c of cases) {
    await cloud('bootstrap', { ownerId: owner, authorityId }, 200, c);
    const d = await cloud('state', { ownerId: owner }, 200, c);
    await writeFile(file('initial-' + c + '.json'), JSON.stringify(d.state), { flag: 'wx' });
  }
  console.log(JSON.stringify({ phase, checks }));
  process.exit(0);
}
async function login() {
  const r = await fetch(url + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: fixtures.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: fixtures.users.owner.email, password: fixtures.users.owner.password }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw Error('Synthetic login failed');
  const data = await r.json(),
    claims = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64url'));
  if (claims.sub !== owner) throw Error('Wrong identity');
  return { token: data.access_token, session: claims.session_id, expiresAt: claims.exp, passwordAt: claims.amr.find(x => x.method === 'password')?.timestamp };
}
const authFile = file('auth-' + caseId + '.json');
let auth;
if (phase === 'start') {
  auth = { a: await login(), b: await login(), writes: [] };
  await writeFile(authFile, JSON.stringify(auth), { flag: 'wx', mode: 0o600 });
} else auth = JSON.parse(await readFile(authFile, 'utf8'));
async function save() {
  await writeFile(authFile, JSON.stringify(auth), { mode: 0o600 });
}
async function call(label, method, path, body, status = 200, who = 'a') {
  return checked(
    label,
    await fetch(edge + path, {
      method,
      headers: { Origin: origin, apikey: fixtures.key, Authorization: 'Bearer ' + auth[who].token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(25000),
    }),
    status,
  );
}
async function identity(kind, who = 'a', target = null, status = 200) {
  const view = await cloud('state', { ownerId: owner });
  const operationId = id();
  await call(kind, 'POST', '/identity', { kind, operationId, expectedSequence: view.state.sequence, targetSessionId: target }, status, who);
  return operationId;
}
const bytes = (n, size) => Buffer.alloc(size, n).toString('base64url');
async function makePut() {
  const n = auth.writes.length + 1;
  let e;
  if (n === 1) {
    const v = JSON.parse(await readFile(new URL('../../src/app/finance/compatibility/fixtures/vault-vectors.json', import.meta.url), 'utf8'));
    e = { ...v.envelope, ownerId: owner };
  } else {
    e = structuredClone(JSON.parse(auth.writes.at(-1)).envelope);
    e.revision = String(n);
    e.payload.nonce = bytes(n, 12);
    e.payload.keySalt = bytes(n, 32);
    if (n === 3 || n === 5) {
      e.passwordWrap = {
        ...e.passwordWrap,
        slotEpoch: String(Number(e.passwordWrap.slotEpoch) + 1),
        salt: bytes(n, 16),
        nonce: bytes(n, 12),
        wrappedKey: bytes(n, 48),
      };
      e.credentialEpoch = String(Number(e.credentialEpoch) + 1);
    }
    if (n === 4 || n === 5) {
      e.recoveryWrap = {
        ...e.recoveryWrap,
        slotEpoch: String(Number(e.recoveryWrap.slotEpoch) + 1),
        salt: bytes(n, 32),
        nonce: bytes(n + 1, 12),
        wrappedKey: bytes(n + 1, 48),
      };
      if (n === 4) e.credentialEpoch = String(Number(e.credentialEpoch) + 1);
    }
    if (n === 5) e.keyEpoch = '2';
  }
  e.operationId = id();
  return JSON.stringify({ expectedRevision: String(n - 1), operationId: e.operationId, envelope: e });
}
if (phase === 'enroll') {
  auth.enrollA = await identity('enroll');
  auth.enrollB = await identity('enroll', 'b');
  await save();
} else if (phase === 'reauth') {
  auth.a = await login();
  await save();
  auth.enrollA = await identity('enroll');
  await save();
} else if (phase === 'write') {
  const b = await makePut();
  await call('write version ' + (auth.writes.length + 1), 'PUT', '', b);
  auth.writes.push(b);
  await save();
} else if (phase === 'read') {
  await call('current head read', 'GET', '');
} else if (phase === 'probe-old') {
  await call('old snapshot read denied', 'GET', '', undefined, 409);
  await call('old bytes cannot be replayed', 'PUT', '', auth.writes.at(-2), 409);
} else if (phase === 'identity') {
  await identity(caseId === 'logout' ? 'logout-all' : caseId, 'a', caseId === 'revoke' ? auth.b.session : null);
} else if (phase === 'blocked') {
  await call('restored identity remains denied', 'GET', '', undefined, 403, caseId === 'revoke' ? 'b' : 'a');
} else if (phase === 'repair') {
  auth.recovery = await login();
  await save();
  const view = await cloud('state', { ownerId: owner });
  const b = auth.writes.find(x => JSON.parse(x).operationId === view.state.head?.operationId);
  const envelope = view.state.head === null ? null : JSON.parse(b).envelope;
  await call('repair from exact independent head', 'POST', '/repair', { envelope }, 200, 'recovery');
  await writeFile(file('release-state-' + caseId + '.json'), JSON.stringify(view.state));
} else if (phase === 'probe-partial') {
  await call('transplanted ciphertext denied', 'GET', '', undefined, 409);
  await call('receipt does not replace current ciphertext check', 'PUT', '', auth.writes.at(-1), 409);
} else if (phase === 'fresh-login') {
  auth.recovery = await login();
  await save();
  await identity('enroll', 'recovery');
  await call('new session admitted', 'GET', '', undefined, 200, 'recovery');
  await call('old session remains denied', 'GET', '', undefined, [401, 403]);
} else if (phase === 'survivor') {
  await call('other session preserved', 'GET', '');
  await call('revoked session remains denied', 'GET', '', undefined, [401, 403], 'b');
} else if (phase === 'new-context') {
  const previous = JSON.parse(auth.writes[0]).envelope;
  previous.operationId = id();
  let b = JSON.stringify({ expectedRevision: '0', operationId: previous.operationId, envelope: previous });
  await call('retired context cannot be recreated', 'PUT', '', b, 403, 'recovery');
  previous.vaultId = id();
  previous.operationId = id();
  b = JSON.stringify({ expectedRevision: '0', operationId: previous.operationId, envelope: previous });
  await call('explicit new context admitted', 'PUT', '', b, 200, 'recovery');
  await call('new context readable', 'GET', '', undefined, 200, 'recovery');
} else if (phase === 'pending-put') {
  const before = await cloud('state', { ownerId: owner });
  const enrollment = (await cloud('operation', { ownerId: owner, operationId: auth.enrollA })).intent.command;
  const b = await makePut(),
    p = JSON.parse(b);
  const command = {
    ownerId: owner,
    operationId: p.operationId,
    expectedSequence: before.state.sequence,
    kind: 'put',
    expectedHead: before.state.head,
    head: await envelopeHead(p.envelope, await sha256(b)),
    actorSessionId: auth.a.session,
    sessionCreatedAtMs: enrollment.sessionCreatedAtMs,
    targetSessionId: null,
  };
  await cloud('prepare', { command });
  await call('pending closes reads', 'GET', '', undefined, 503);
  await call('pending requires original envelope', 'POST', '/resume', { operationId: p.operationId, originalPut: null }, 409);
  await call('exact original resumes write', 'POST', '/resume', { operationId: p.operationId, originalPut: b });
  await call('duplicate has same receipt', 'PUT', '', b);
  auth.writes.push(b);
  await save();
  await call('resumed head readable', 'GET', '');
} else if (phase === 'pending-revoke') {
  const before = await cloud('state', { ownerId: owner }),
    enrollment = (await cloud('operation', { ownerId: owner, operationId: auth.enrollA })).intent.command;
  const command = {
    ownerId: owner,
    operationId: id(),
    expectedSequence: before.state.sequence,
    kind: 'revoke',
    expectedHead: before.state.head,
    head: null,
    actorSessionId: auth.a.session,
    sessionCreatedAtMs: enrollment.sessionCreatedAtMs,
    targetSessionId: auth.a.session,
  };
  const intent = (await cloud('prepare', { command })).intent;
  await writeFile(
    file('pending-sql.json'),
    JSON.stringify({ actor: owner, session: auth.a.session, expiresAt: auth.a.expiresAt, passwordAt: auth.a.passwordAt, before: before.state, intent }),
    { mode: 0o600 },
  );
  auth.pendingOperation = command.operationId;
  await save();
} else if (phase === 'resume-revoke') {
  auth.recovery = await login();
  await save();
  await call('fresh login finalizes self-revocation', 'POST', '/resume', { operationId: auth.pendingOperation, originalPut: null }, 200, 'recovery');
  await call('self-revoked login denied', 'GET', '', undefined, [401, 403]);
} else if (phase === 'export') {
  const view = await cloud('state', { ownerId: owner });
  if (view.pending) throw Error('Unresolved intent');
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const artifact = await signRecoveryCheckpoint(authorityId, caseId, view.state, null, keys.privateKey),
    publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const pin = {
    authorityId,
    caseId,
    ownerId: owner,
    sequence: view.state.sequence,
    stateDigest: await sha256(stable(view.state)),
    publicKeyFingerprint: await keyFingerprint(keys.publicKey),
  };
  await writeFile(file('recovery-' + caseId + '.json'), JSON.stringify({ artifact, publicKey }), { flag: 'wx' });
  await writeFile(file('pin-' + caseId + '.json'), JSON.stringify(pin), { flag: 'wx' });
  const assessment = await assessAuthorityRecovery(artifact, keys.publicKey, pin, null);
  if (assessment.admission !== false || assessment.mode !== 'new-generation-required') throw Error('Unsafe recovery');
  checks.push({ label: 'lost authority cannot reopen old context', assessment });
  await cloud('bootstrap', { authorityId, ownerId: owner }, 403);
} else if (phase === 'unavailable') {
  auth.a = await login();
  await save();
  await cloud('state', { ownerId: owner }, 401);
  await call('authority loss closes reads', 'GET', '', undefined, 503);
  await call('authority loss closes writes', 'PUT', '', auth.writes.at(-1), 503);
} else if (phase === 'closed') {
  await call('test coordinator disabled', 'GET', '', undefined, 503);
} else if (phase !== 'start') throw Error('Unknown phase');
await writeFile(file(`${caseId}-${phase}-${auth.writes.length}-report.json`), JSON.stringify({ at: new Date().toISOString(), caseId, phase, checks }, null, 2));
console.log(JSON.stringify({ caseId, phase, checks }));
