/** Operator-driven synthetic PostgreSQL restore rehearsal; all credentials stay outside Git. */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const [phase, privateDir, fixturePath, caseId = 'reset'] = process.argv.slice(2);
function outside(path) {
  if (!path || !isAbsolute(path)) throw Error('Absolute private path required');
  const r = relative(root, resolve(path));
  if (!r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep))) throw Error('Private material must stay outside Git');
}
outside(privateDir);
outside(fixturePath);
if (!['reset', 'revoke', 'purge'].includes(caseId)) throw Error('Unknown case');
const owner = '37848d70-989a-4f69-b124-0c959d8b49a6',
  vault = 'AAAAAAAAAAAAAAAAAAAAAA',
  authorityId = '9583b66a-a5f8-43e4-aaf6-6409f7502669';
const cf = 'https://tr8-authority-restore-test.sredgarpadilla.workers.dev/v1/cases/' + caseId;
const url = 'https://kajcbwlnqcwcpbtqyieo.supabase.co',
  origin = 'http://127.0.0.1:5174',
  edge = url + '/functions/v1/tr8-finance-restore-test';
const file = name => resolve(privateDir, name),
  id = () => randomBytes(16).toString('base64url');
await mkdir(privateDir, { recursive: true });
if (phase === 'init') {
  const token = randomBytes(32).toString('hex');
  await writeFile(file('cf-secret.json'), JSON.stringify({ ACCESS_TOKEN: token }), { flag: 'wx', mode: 0o600 });
  await writeFile(file('cf-close.json'), JSON.stringify({ ACCESS_TOKEN: null }), { flag: 'wx', mode: 0o600 });
  await writeFile(
    file('edge.env'),
    `TR8_FINANCE_RESTORE_TESTING_ENABLED=true\nTR8_FINANCE_AUTHORITY_ID=${authorityId}\nTR8_FINANCE_RESTORE_CASE=${caseId}\nTR8_FINANCE_AUTHORITY_SECRET=${token}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(file('edge-closed.env'), 'TR8_FINANCE_RESTORE_TESTING_ENABLED=false\nTR8_FINANCE_AUTHORITY_SECRET=closed\n', { flag: 'wx', mode: 0o600 });
  console.log('Private synthetic configuration prepared');
  process.exit(0);
}
const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
if (fixtures.url !== url || fixtures.users.owner.id !== owner || !fixtures.users.owner.email.endsWith('@example.test')) throw Error('Wrong isolated fixture');
const token = JSON.parse(await readFile(file('cf-secret.json'), 'utf8')).ACCESS_TOKEN;
const checks = [];
async function checked(label, response, status) {
  const data = await response.json();
  if (response.status !== status) throw Error(`${label}: expected ${status}, received ${response.status} (${data.error?.code ?? data.code ?? 'unknown'})`);
  checks.push({ label, status, code: data.error?.code ?? null });
  return data;
}
async function cloud(action, payload, status = 200) {
  const nonce = id();
  const data = await checked(
    'authority/' + action,
    await fetch(cf + '/' + action, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, ...payload }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    }),
    status,
  );
  if (status === 200 && (data.nonce !== nonce || data.authorityId !== authorityId || data.caseId !== caseId)) throw Error('Wrong authority response');
  return data;
}
async function login() {
  const r = await fetch(url + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: fixtures.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: fixtures.users.owner.email, password: fixtures.users.owner.password }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw Error('Synthetic sign-in failed');
  const data = await r.json();
  const claims = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64url'));
  if (claims.sub !== owner) throw Error('Wrong synthetic identity');
  return { token: data.access_token, session: claims.session_id };
}
const authPath = file('auth-' + caseId + '.json');
let auth;
if (phase === 'start') {
  auth = { a: await login(), b: await login(), operationId: id() };
  await writeFile(authPath, JSON.stringify(auth), { flag: 'wx', mode: 0o600 });
  await cloud('bootstrap', { authorityId, ownerId: owner, vaultId: vault });
} else auth = JSON.parse(await readFile(authPath, 'utf8'));
const vector = JSON.parse(await readFile(new URL('../../src/app/finance/compatibility/fixtures/vault-vectors.json', import.meta.url), 'utf8'));
const envelope = { ...vector.envelope, ownerId: owner, vaultId: vault };
const put = JSON.stringify({ expectedRevision: '0', operationId: envelope.operationId, envelope });
async function call(label, method, path, body, status = 200, who = 'a', epoch = '1') {
  return checked(
    label,
    await fetch(edge + path, {
      method,
      headers: {
        Origin: origin,
        apikey: fixtures.key,
        ...(who === 'none' ? {} : { Authorization: 'Bearer ' + auth[who].token }),
        'Content-Type': 'application/json',
        'x-tr8-finance-epoch': epoch,
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(25000),
    }),
    status,
  );
}
if (phase === 'create') {
  await call('create', 'PUT', '', put);
  await call('read initial', 'GET', '');
  await call('receipt initial', 'GET', `/receipt/${vault}/${envelope.operationId}`);
} else if (phase === 'mutate') {
  auth.a = await login();
  await writeFile(authPath, JSON.stringify(auth), { mode: 0o600 });
  const data = { operationId: auth.operationId, expectedEpoch: '1', ...(caseId === 'revoke' ? { sessionId: auth.b.session } : { expectedVaultId: vault }) };
  await call('lifecycle ' + caseId, 'POST', '/' + caseId, data);
  const state = (await cloud('state', { ownerId: owner })).state;
  if (state.epoch !== '2' || state.operations[0]?.status !== 'committed') throw Error('Lifecycle not committed');
} else if (phase === 'probe') {
  const who = caseId === 'revoke' ? 'b' : 'a';
  await call('restored snapshot read denied', 'GET', '', undefined, 403, who);
  await call('restored exact put denied', 'PUT', '', put, 403, who);
  await call('restored receipt denied', 'GET', `/receipt/${vault}/${envelope.operationId}`, undefined, 403, who);
  await call('anonymous denied', 'GET', '', undefined, 401, 'none');
} else if (['repair', 'release'].includes(phase)) {
  auth.a = await login();
  await writeFile(authPath, JSON.stringify(auth), { mode: 0o600 });
  const result = await call(phase, 'POST', '/reconcile', { release: phase === 'release' });
  if (result.quarantined !== (phase === 'repair') || result.epoch !== '2') throw Error('Unexpected reconciliation');
} else if (phase === 'survivor') {
  if (caseId !== 'revoke') throw Error('Only revoke has a live context');
  const head = await call('unrevoked session retained', 'GET', '', undefined, 200, 'a', '2');
  if (head.epoch !== '2' || head.envelope?.vaultId !== vault) throw Error('Wrong surviving head');
  await call('revoked session still denied', 'GET', '', undefined, 403, 'b', '2');
} else if (phase === 'pending') {
  const command = { operationId: id(), ownerId: owner, expectedEpoch: '2', kind: 'revoke', vaultId: null, targetSessionId: auth.b.session };
  await cloud('prepare', { command });
  await call('pending denies data', 'GET', '', undefined, 503, 'a', '2');
  await call('pending refuses repair/release', 'POST', '/reconcile', { release: true }, 503);
} else if (phase === 'unavailable') {
  await cloud('state', { ownerId: owner }, 401);
  await call('missing authority denies data', 'GET', '', undefined, 503);
  await call('missing authority denies put', 'PUT', '', put, 503);
  await call('missing authority denies receipt', 'GET', `/receipt/${vault}/${envelope.operationId}`, undefined, 503);
} else if (phase === 'closed') {
  await cloud('state', { ownerId: owner }, 401);
  await call('Edge disabled', 'GET', '', undefined, 503);
} else if (phase !== 'start') throw Error('Unknown phase');
const report = { at: new Date().toISOString(), caseId, phase, checks };
await writeFile(file(`${caseId}-${phase}-report.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
