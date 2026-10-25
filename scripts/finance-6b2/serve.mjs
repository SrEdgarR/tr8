/**
 * Local synthetic acceptance server. Serves only the separate built test page.
 * Optional hosted bridge: existing TEST example.test fixture credentials remain
 * server-side in memory; only opaque envelopes reach Supabase. No production URL,
 * service key, new Auth user, email or financial domain data is permitted.
 * node scripts/finance-6b2/serve.mjs [private-fixtures.json] [--finance-6b3]
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve, sep, extname } from 'node:path';

const origin = 'http://127.0.0.1:5188';
const testBase = 'https://kajcbwlnqcwcpbtqyieo.supabase.co';
const edgePath = '/functions/v1/tr8-finance';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
if (
  args.filter(arg => arg.startsWith('--')).some(arg => !['--finance-6b3', '--finance-6b4'].includes(arg)) ||
  args.filter(arg => arg.startsWith('--')).length > 1 ||
  args.filter(arg => !arg.startsWith('--')).length > 1 ||
  new Set(args).size !== args.length
)
  throw new Error('Unknown synthetic harness option');
const profile = args.includes('--finance-6b4') ? 'finance-6b4' : args.includes('--finance-6b3') ? 'finance-6b3' : 'finance-6b2';
const fixturePath = args.find(arg => !arg.startsWith('--'));
const root = resolve(repository, `test-results/${profile}-browser`);
await stat(resolve(root, `scripts/${profile}/index.html`));
let fixture;
let auth;
let requests = 0;
const saves = [];
if (fixturePath) {
  const configPath = resolve(fixturePath);
  const location = relative(repository, configPath);
  if (!location || (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`))) throw new Error('Fixture must stay outside Git');
  const parsed = JSON.parse(await readFile(configPath, 'utf8'));
  if (new URL(parsed.url).origin !== testBase || new URL(parsed.url).pathname !== '/' || parsed.key?.startsWith('sb_secret_'))
    throw new Error('Only TEST public credentials allowed');
  if (!parsed.key?.startsWith('sb_publishable_')) {
    const keyClaims = JSON.parse(Buffer.from(parsed.key?.split('.')[1] ?? '', 'base64url').toString());
    if (keyClaims.role !== 'anon' || keyClaims.ref !== 'kajcbwlnqcwcpbtqyieo') throw new Error('Privileged credentials prohibited');
  }
  const owner = parsed.users?.owner;
  if (
    owner?.id !== '37848d70-989a-4f69-b124-0c959d8b49a6' ||
    !/^[^@\s]+@example\.test$/.test(owner.email) ||
    typeof owner.password !== 'string' ||
    owner.password.length < 20
  )
    throw new Error('Existing synthetic owner required');
  fixture = { key: parsed.key, owner };
}
async function platform(path, method = 'GET', body, epoch) {
  if (!fixture || !['/auth/v1/', edgePath].some(prefix => path.startsWith(prefix))) throw new Error('Unexpected network target');
  requests++;
  const response = await fetch(testBase + path, {
    method,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: {
      apikey: fixture.key,
      ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}),
      ...(path.startsWith(edgePath) ? { Origin: 'http://127.0.0.1:5174' } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(epoch ? { 'x-tr8-finance-epoch': epoch } : {}),
    },
    ...(body === undefined ? {} : { body }),
  });
  const raw = await response.text();
  if (raw.length > 2_200_000) throw new Error('Unexpected response size');
  return { ok: response.ok, status: response.status, value: raw ? JSON.parse(raw) : null };
}
async function state() {
  const result = await platform(edgePath);
  if (!result.ok || !/^[1-9][0-9]*$/.test(result.value?.epoch)) throw new Error('Synthetic finance gate unavailable');
  return result.value;
}
async function identity() {
  if (!auth) throw new Error('Synthetic session not started');
  const verified = await platform('/auth/v1/user');
  if (!verified.ok || verified.value?.id !== fixture.owner.id) throw new Error('Synthetic session expired');
  const current = await state();
  return { ownerId: fixture.owner.id, sessionId: auth.sessionId, epoch: current.epoch, valid: true };
}
async function close() {
  if (auth) await platform('/auth/v1/logout?scope=local', 'POST');
  auth = undefined;
}
const json = (response, value, code = 200) => {
  response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
};
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  try {
    const target = new URL(request.url, origin);
    if (request.headers.host !== '127.0.0.1:5188' || target.search || target.hash) return json(response, { error: 'DENIED' }, 403);
    if (target.pathname.startsWith('/test-api/')) {
      if (
        request.headers['x-tr8-fixture-request'] !== '6b2' ||
        (request.headers.origin && request.headers.origin !== origin) ||
        !['same-origin', 'none'].includes(request.headers['sec-fetch-site'] ?? 'none')
      )
        return json(response, { error: 'DENIED' }, 403);
      if (target.pathname === '/test-api/available' && request.method === 'GET') return json(response, { hosted: Boolean(fixture) });
      if (!fixture) return json(response, { error: 'NOT_CONFIGURED' }, 503);
      if (target.pathname === '/test-api/start' && request.method === 'POST') {
        if (auth) throw new Error('Session already started');
        const result = await platform(
          '/auth/v1/token?grant_type=password',
          'POST',
          JSON.stringify({ email: fixture.owner.email, password: fixture.owner.password }),
        );
        if (!result.ok || result.value?.user?.id !== fixture.owner.id) throw new Error('Fixture login failed');
        const claims = JSON.parse(Buffer.from(result.value.access_token.split('.')[1], 'base64url').toString());
        if (claims.sub !== fixture.owner.id || !claims.session_id || claims.iss !== `${testBase}/auth/v1`) throw new Error('Fixture identity mismatch');
        auth = { token: result.value.access_token, sessionId: claims.session_id };
        const current = await state();
        if (current.envelope !== null) throw new Error('Refusing to overwrite existing synthetic vault');
        return json(response, await identity());
      }
      if (target.pathname === '/test-api/identity' && request.method === 'GET') return json(response, await identity());
      if (target.pathname === '/test-api/state' && request.method === 'GET') return json(response, await state());
      if (target.pathname === '/test-api/save' && request.method === 'PUT') {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 2_097_152) throw new Error('Request limit');
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const put = JSON.parse(body);
        if (put.envelope?.ownerId !== fixture.owner.id) throw new Error('Owner mismatch');
        const actor = await identity();
        const result = await platform(edgePath, 'PUT', body, actor.epoch);
        saves.push({ sha256: createHash('sha256').update(bytes).digest('hex'), revision: put.envelope.revision, status: result.status });
        return json(response, result.value, result.status);
      }
      if (target.pathname === '/test-api/close' && request.method === 'POST') {
        await close();
        return json(response, { requests, saves, syntheticOnly: true, sessionClosed: true });
      }
      return json(response, { error: 'DENIED' }, 403);
    }
    if (request.method !== 'GET') return json(response, { error: 'DENIED' }, 405);
    const path = resolve(root, '.' + decodeURIComponent(target.pathname === '/' ? `/scripts/${profile}/index.html` : target.pathname));
    const location = relative(root, path);
    if (!location || isAbsolute(location) || location.startsWith('..')) return json(response, { error: 'DENIED' }, 403);
    const content = await readFile(path);
    const worker = /(?:vault|probe|financial)\.worker-[^/]+\.js$/.test(path);
    response.writeHead(200, {
      'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': worker
        ? "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'"
        : "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    response.end(content);
  } catch {
    json(response, { error: 'SYNTHETIC_TEST_FAILED' }, 500);
  }
});
server.listen(5188, '127.0.0.1', () => console.log(JSON.stringify({ url: origin, hosted: Boolean(fixture), serves: 'separate built synthetic harness only' })));
process.on('SIGINT', async () => {
  try {
    await close();
  } finally {
    server.close();
  }
});
