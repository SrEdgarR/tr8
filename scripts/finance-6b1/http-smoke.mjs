/**
 * Synthetic-only hosted finance acceptance. Never targets production or creates
 * Auth users. Uses existing example.test fixtures and a public TEST key only.
 * Usage: node scripts/finance-6b1/http-smoke.mjs <private-fixtures.json>
 *        [app-origin] [--coordinate-auth]
 *
 * Coordination writes only the fresh session IDs created here to a private
 * checkpoint. An operator may age exactly those synthetic Auth rows, then write
 * the matching runId to finance-6b1-continue.json. Tokens never leave memory.
 * Aged fixture AMR + real refresh is not a naturally elapsed-time experiment.
 * Envelopes are structural synthetic fixtures, not valid newly encrypted vaults.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const TEST_HOST = 'kajcbwlnqcwcpbtqyieo.supabase.co';
const PRODUCTION_REF = 'ggbjezprlsnhidlbjivl';
const USERS = ['owner', 'otherOwner', 'outsider'];
const ORIGINS = ['http://127.0.0.1:5173', 'http://127.0.0.1:5174', 'https://tr8.vercel.app'];
const PRIVATE_DIR = resolve(process.env.USERPROFILE ?? '', '.codex/tmp/tr8-stage6b1-private');
const EDGE_PATH = '/functions/v1/tr8-finance';
let assertions = 0;
let requests = 0;
class SmokeError extends Error {}
const check = (condition, label) => {
  if (!condition) throw new SmokeError(label);
  assertions++;
};
const equal = (left, right, label) => check(isDeepStrictEqual(left, right), label);
const encoded = size => randomBytes(size).toString('base64url');
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const sessionClaims = token => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
function success(response, label) {
  check(response.status >= 200 && response.status < 300, label);
  return response.body;
}
function rejected(response, statuses, label, codes) {
  check(statuses.includes(response.status), label);
  if (codes) check(codes.includes(response.body?.error?.code), `${label}: unexpected sanitized error code.`);
}
function sanitized(response) {
  equal(Object.keys(response.body ?? {}), ['error'], 'Finance error exposed top-level diagnostics.');
  equal(Object.keys(response.body.error ?? {}), ['code'], 'Finance error exposed diagnostics or credentials.');
  check(typeof response.body.error.code === 'string', 'Finance error is missing a technical code.');
}
function privateDenied(response, label) {
  check(response.status >= 400 && response.status < 500 && ['42501', 'PGRST106', 'PGRST202', 'PGRST205'].includes(response.body?.code), label);
}
function stateShape(value) {
  equal(Object.keys(value ?? {}).sort(), ['envelope', 'epoch'], 'Read exposed non-contract finance metadata.');
  check(typeof value.epoch === 'string' && /^[1-9][0-9]*$/.test(value.epoch), 'Invalid finance authority epoch.');
  return value;
}

async function main() {
  if (!process.env.USERPROFILE || !process.argv[2]) throw new SmokeError('Expected a private synthetic-fixture config and local user profile.');
  const flags = process.argv.slice(3);
  const coordinate = flags.includes('--coordinate-auth');
  const appOrigin = flags.find(argument => !argument.startsWith('--')) ?? 'http://127.0.0.1:5174';
  if (flags.some(argument => argument.startsWith('--') && argument !== '--coordinate-auth') || !ORIGINS.includes(appOrigin))
    throw new SmokeError('Unsupported smoke option or application origin.');
  const configPath = resolve(process.argv[2]);
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const location = relative(repository, configPath);
  if (!location || (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`)))
    throw new SmokeError('Fixture credentials must remain outside the repository.');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const base = new URL(config.url);
  if (
    base.protocol !== 'https:' ||
    base.hostname !== TEST_HOST ||
    base.port ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    config.url.includes(PRODUCTION_REF)
  )
    throw new SmokeError('Refusing network access: only the literal disposable TEST project is permitted.');
  if (typeof config.key !== 'string' || !config.key || config.key.startsWith('sb_secret_'))
    throw new SmokeError('Only a public TEST-project key is permitted.');
  if (!config.key.startsWith('sb_publishable_')) {
    let claims;
    try {
      claims = sessionClaims(config.key);
    } catch {
      throw new SmokeError('Invalid public TEST-project key.');
    }
    if (claims.role !== 'anon' || claims.ref !== TEST_HOST.split('.')[0]) throw new SmokeError('Privileged or foreign keys are prohibited.');
  }
  for (const name of USERS) {
    const user = config.users?.[name];
    if (
      !user ||
      !/^[^@\s]+@example\.test$/i.test(user.email) ||
      typeof user.password !== 'string' ||
      user.password.length < 20 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id)
    )
      throw new SmokeError('Only existing synthetic example.test fixtures are permitted.');
  }
  check(new Set(USERS.map(name => config.users[name].id)).size === USERS.length, 'Synthetic identities must be distinct.');
  await mkdir(PRIVATE_DIR, { recursive: true, mode: 0o700 });
  const runId = randomUUID();
  const checkpointPath = resolve(PRIVATE_DIR, 'finance-6b1-checkpoint.json');
  const continuePath = resolve(PRIVATE_DIR, 'finance-6b1-continue.json');
  const resultPath = resolve(PRIVATE_DIR, 'http-finance-6b1-result.json');
  const vector = JSON.parse(await readFile(new URL('../../src/app/finance/compatibility/fixtures/vault-vectors.json', import.meta.url), 'utf8'));
  const tokens = new Map();
  const created = new Map();
  const cleanup = new Map();
  const evidence = {
    runId,
    assertions: 0,
    requests: 0,
    sessionExpiry: 'not tested',
    staleAmr: 'not tested',
    provider: 'Supabase TEST Auth; no Google calls',
    scope: 'structural opaque synthetic envelopes only; no new cryptographic vault validation',
  };

  async function request(path, token, method = 'GET', rawBody, headers = {}) {
    const target = new URL(path, base);
    if (target.origin !== base.origin || !['/auth/v1/', '/rest/v1/', '/functions/v1/'].some(prefix => target.pathname.startsWith(prefix)))
      throw new SmokeError('Unexpected network target.');
    requests++;
    const response = await fetch(target, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      cache: 'no-store',
      headers: {
        apikey: config.key,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(rawBody === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(rawBody === undefined ? {} : { body: rawBody }),
    });
    const raw = await response.text();
    if (raw.length > 2_200_000) throw new SmokeError('Unexpected API response size.');
    let body = null;
    try {
      if (raw) body = JSON.parse(raw);
    } catch {
      throw new SmokeError('Expected sanitized JSON API response.');
    }
    return { status: response.status, body, cors: response.headers.get('access-control-allow-origin'), cache: response.headers.get('cache-control') };
  }
  const token = name => tokens.get(name)?.accessToken;
  const edge = (name, suffix = '', method = 'GET', body, epoch, origin = appOrigin) =>
    request(`${EDGE_PATH}${suffix}`, token(name), method, body, {
      ...(origin === null ? {} : { Origin: origin }),
      ...(epoch ? { 'x-tr8-finance-epoch': epoch } : {}),
    });
  const read = async name => stateShape(success(await edge(name), 'Synthetic finance read failed.'));
  const rpc = (name, functionName, params = {}, headers = {}) => request(`/rest/v1/rpc/${functionName}`, token(name), 'POST', JSON.stringify(params), headers);

  async function login(name, fixtureName) {
    const fixture = config.users[fixtureName];
    const session = success(
      await request('/auth/v1/token?grant_type=password', null, 'POST', JSON.stringify({ email: fixture.email, password: fixture.password })),
      'Existing synthetic fixture login failed.',
    );
    check(
      typeof session.access_token === 'string' && typeof session.refresh_token === 'string' && session.user?.id === fixture.id,
      'Unexpected synthetic login identity.',
    );
    const claims = sessionClaims(session.access_token);
    check(claims.sub === fixture.id && typeof claims.session_id === 'string', 'Invalid synthetic session identity.');
    const password = claims.amr?.find(proof => proof.method === 'password');
    check(Number.isSafeInteger(password?.timestamp), 'Real password login did not issue a password AMR proof.');
    const record = {
      fixtureName,
      userId: fixture.id,
      sessionId: claims.session_id,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      passwordAt: password.timestamp,
    };
    tokens.set(name, record);
    created.set(claims.session_id, record);
    return record;
  }
  async function logout(name) {
    const record = tokens.get(name);
    if (!record) return;
    const response = await request('/auth/v1/logout?scope=local', record.accessToken, 'POST');
    check([204, 401, 403].includes(response.status), 'Could not revoke a fresh synthetic session created by this suite.');
    created.delete(record.sessionId);
    tokens.delete(name);
  }
  function fresh(ownerId) {
    const envelope = structuredClone(vector.envelope);
    envelope.ownerId = ownerId;
    envelope.vaultId = encoded(16);
    envelope.operationId = encoded(16);
    return envelope;
  }
  function next(previous, rekey = false) {
    const envelope = structuredClone(previous);
    envelope.revision = String(BigInt(previous.revision) + 1n);
    envelope.operationId = encoded(16);
    envelope.payload = { keySalt: encoded(32), nonce: encoded(12), ciphertext: encoded(17) };
    if (rekey) {
      envelope.keyEpoch = String(BigInt(previous.keyEpoch) + 1n);
      envelope.credentialEpoch = String(BigInt(previous.credentialEpoch) + 1n);
      envelope.passwordWrap = {
        ...envelope.passwordWrap,
        slotEpoch: String(BigInt(previous.passwordWrap.slotEpoch) + 1n),
        salt: encoded(16),
        nonce: encoded(12),
        wrappedKey: encoded(48),
      };
      envelope.recoveryWrap = {
        ...envelope.recoveryWrap,
        slotEpoch: String(BigInt(previous.recoveryWrap.slotEpoch) + 1n),
        salt: encoded(32),
        nonce: encoded(12),
        wrappedKey: encoded(48),
      };
    }
    return envelope;
  }
  const putBody = (envelope, expectedRevision = '0') => JSON.stringify({ expectedRevision, operationId: envelope.operationId, envelope });
  async function resetOwned(name, vaultId) {
    const current = await read(name);
    if (current.envelope === null) {
      cleanup.delete(name);
      return;
    }
    check(current.envelope?.vaultId === vaultId, 'Refusing reset: the fixture context is not the one created by this run.');
    success(
      await edge(name, '/reset', 'POST', JSON.stringify({ operationId: encoded(16), expectedEpoch: current.epoch, expectedVaultId: vaultId })),
      'Synthetic context cleanup reset failed.',
    );
    check((await read(name)).envelope === null, 'Synthetic reset did not clear its own context.');
    cleanup.delete(name);
  }

  let failure;
  try {
    await login('ownerMain', 'owner');
    await login('ownerSecondary', 'owner');
    await login('ownerRevoked', 'owner');
    await login('otherMain', 'otherOwner');
    await login('outsiderMain', 'outsider');
    const initialOwner = await read('ownerMain');
    const initialOther = await read('otherMain');
    check(initialOwner.envelope === null && initialOther.envelope === null, 'Refusing to overwrite existing synthetic finance contexts.');
    const context = success(await rpc('ownerMain', 'tr8_v2_get_context'), 'Synthetic TR8 context failed.');
    check(context.external_invites_enabled === false, 'External onboarding gate changed.');

    for (const origin of [null, 'https://attacker.example.test']) {
      const response = await edge('ownerMain', '', 'GET', undefined, undefined, origin);
      rejected(response, [403], 'Missing or foreign Origin was accepted.', ['ORIGIN_DENIED']);
      sanitized(response);
      check(response.cors === null, 'Rejected Origin received CORS access.');
    }
    const preflight = await request(EDGE_PATH, null, 'OPTIONS', undefined, {
      Origin: appOrigin,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'authorization,apikey,content-type,x-tr8-finance-epoch',
    });
    check(preflight.status === 204 && preflight.cors === appOrigin, 'Configured finance Origin failed preflight.');
    for (const method of ['DELETE', 'PATCH'])
      rejected(await edge('ownerMain', '', method), [405], 'Unexpected finance HTTP method was accepted.', ['METHOD_NOT_ALLOWED']);
    for (const name of [null, 'outsiderMain']) {
      const response = await edge(name);
      rejected(response, name ? [403] : [401], 'Anonymous or unapproved fixture read finance data.');
      sanitized(response);
    }
    for (const name of [null, 'ownerMain', 'otherMain', 'outsiderMain']) {
      privateDenied(
        await rpc(name, 'tr8_server_finance', {
          p_action: 'read',
          p_actor: config.users.owner.id,
          p_session: tokens.get('ownerMain').sessionId,
          p_token_exp: 9999999999,
        }),
        'A public client reached the privileged finance RPC.',
      );
      privateDenied(await rpc(name, 'server', {}, { 'Content-Profile': 'tr8_finance' }), 'A public client reached the private finance schema.');
      for (const table of ['config', 'synthetic_allowlist', 'actors', 'vaults', 'receipts', 'retired', 'revoked_sessions', 'lifecycle_receipts']) {
        privateDenied(
          await request(`/rest/v1/${table}?select=*`, token(name), 'GET', undefined, { 'Accept-Profile': 'tr8_finance' }),
          'A public client read a private finance table.',
        );
        privateDenied(
          await request(`/rest/v1/${table}`, token(name), 'POST', '{}', { 'Content-Profile': 'tr8_finance' }),
          'A public client reached private finance DML.',
        );
      }
    }

    const main = tokens.get('ownerMain');
    for (const replacement of [{ exp: 1 }, { session_id: tokens.get('otherMain').sessionId }, { sub: config.users.otherOwner.id }]) {
      const parts = main.accessToken.split('.');
      parts[1] = Buffer.from(JSON.stringify({ ...sessionClaims(main.accessToken), ...replacement })).toString('base64url');
      const response = await request(EDGE_PATH, parts.join('.'), 'GET', undefined, { Origin: appOrigin });
      rejected(response, [401], 'JWT claim tampering retained finance access.', ['AUTH_REQUIRED']);
      sanitized(response);
    }
    const foreignRevoke = await edge(
      'ownerMain',
      '/revoke',
      'POST',
      JSON.stringify({ operationId: encoded(16), expectedEpoch: initialOwner.epoch, sessionId: tokens.get('otherMain').sessionId }),
    );
    rejected(foreignRevoke, [403, 404], 'A fixture revoked another owner session.');
    success(
      await edge(
        'ownerMain',
        '/revoke',
        'POST',
        JSON.stringify({ operationId: encoded(16), expectedEpoch: initialOwner.epoch, sessionId: tokens.get('ownerRevoked').sessionId }),
      ),
      'Own synthetic secondary-session revocation failed.',
    );
    rejected(await edge('ownerRevoked'), [401], 'A real revoked session retained finance access with its old signed JWT.', ['AUTH_REQUIRED']);
    const loggedOutToken = token('ownerRevoked');
    await logout('ownerRevoked');
    rejected(
      await request(EDGE_PATH, loggedOutToken, 'GET', undefined, { Origin: appOrigin }),
      [401],
      'A real Supabase logout left the old signed JWT usable for finance.',
      ['AUTH_REQUIRED'],
    );

    let ownerState = await read('ownerMain');
    const original = fresh(config.users.owner.id);
    const originalBody = putBody(original);
    const receipt = success(await edge('ownerMain', '', 'PUT', originalBody, ownerState.epoch), 'Synthetic finance creation failed.');
    cleanup.set('ownerMain', original.vaultId);
    equal(receipt, { operationId: original.operationId, revision: '1' }, 'Unexpected opaque creation receipt.');
    const createdState = await read('ownerMain');
    equal(createdState.envelope, original, 'Stored opaque snapshot differs from the exact synthetic envelope.');
    equal(
      success(await edge('ownerMain', '', 'PUT', originalBody, createdState.epoch), 'Exact synthetic retry failed.'),
      receipt,
      'Exact retry created a second revision.',
    );
    equal(
      success(
        await edge('ownerMain', `/receipt/${original.vaultId}/${original.operationId}`, 'GET', undefined, createdState.epoch),
        'Durable receipt lookup failed.',
      ),
      receipt,
      'Receipt lookup differs from committed result.',
    );
    rejected(await edge('ownerMain', '', 'PUT', `${originalBody}\n`, createdState.epoch), [409], 'Different request bytes reused an operation ID.', [
      'FINANCE_CONFLICT',
    ]);
    rejected(
      await edge('otherMain', `/receipt/${original.vaultId}/${original.operationId}`, 'GET', undefined, initialOther.epoch),
      [403, 404],
      'A fixture read another owner receipt.',
    );
    rejected(await edge('otherMain', '', 'PUT', originalBody, initialOther.epoch), [403], 'Client-controlled owner ID selected another finance context.', [
      'CONTEXT_DENIED',
    ]);
    check((await read('otherMain')).envelope === null, 'Denied cross-owner probes changed another fixture context.');

    const left = next(original);
    const right = next(original);
    const competing = await Promise.all([
      edge('ownerMain', '', 'PUT', putBody(left, '1'), createdState.epoch),
      edge('ownerSecondary', '', 'PUT', putBody(right, '1'), createdState.epoch),
    ]);
    equal(competing.map(response => response.status).sort(), [200, 409], 'CAS failed to select exactly one concurrent writer.');
    ownerState = await read('ownerMain');
    check(
      ownerState.envelope?.revision === '2' && [left.operationId, right.operationId].includes(ownerState.envelope.operationId),
      'CAS committed an unexpected snapshot.',
    );

    if (coordinate) {
      const checkpoint = {
        runId,
        phase: 'awaiting-synthetic-auth-aging',
        projectRef: TEST_HOST.split('.')[0],
        sessions: Object.fromEntries(
          ['ownerMain', 'ownerSecondary', 'otherMain'].map(name => {
            const record = tokens.get(name);
            return [name, { userId: record.userId, sessionId: record.sessionId, originalPasswordAt: record.passwordAt }];
          }),
        ),
        expected: 'Age ONLY ownerMain password AMR.updated_at beyond five minutes and set ONLY ownerSecondary.not_after in the past; keep ownerMain live.',
      };
      await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
      console.log(JSON.stringify({ phase: checkpoint.phase, runId, checkpointPath, continuePath }));
      const deadline = Date.now() + 15 * 60_000;
      let continued = false;
      while (Date.now() < deadline) {
        try {
          const control = JSON.parse(await readFile(continuePath, 'utf8'));
          if (control.runId === runId && control.continue === true) {
            continued = true;
            break;
          }
        } catch {
          /* A private operator checkpoint is pending. */
        }
        await sleep(500);
      }
      check(continued, 'Synthetic Auth coordination timed out.');
      rejected(await edge('ownerSecondary'), [401], 'A real expired synthetic session retained finance access.', ['AUTH_REQUIRED']);
      evidence.sessionExpiry =
        'Real Auth session.not_after fixture set in the past by the operator; expired signed-session request rejected. JWT signature expiry was not fabricated.';
    } else {
      const until = (tokens.get('ownerMain').passwordAt + 302) * 1000;
      console.log(JSON.stringify({ phase: 'waiting-for-natural-password-amr-expiry', runId, waitMilliseconds: Math.max(0, until - Date.now()) }));
      while (Date.now() < until) await sleep(Math.min(1000, until - Date.now()));
      evidence.sessionExpiry = 'Not tested without --coordinate-auth; real logout/session revocation was tested separately.';
    }
    const oldRecord = tokens.get('ownerMain');
    const refreshed = success(
      await request('/auth/v1/token?grant_type=refresh_token', null, 'POST', JSON.stringify({ refresh_token: oldRecord.refreshToken })),
      'Real synthetic Auth refresh failed.',
    );
    const refreshedClaims = sessionClaims(refreshed.access_token);
    const refreshedPassword = refreshedClaims.amr?.find(proof => proof.method === 'password');
    check(refreshedClaims.sub === oldRecord.userId && refreshedClaims.session_id === oldRecord.sessionId, 'Refresh changed the synthetic owner/session.');
    check(
      Number.isSafeInteger(refreshedPassword?.timestamp) && refreshedPassword.timestamp * 1000 <= Date.now() - 300_000,
      'Refresh incorrectly supplied a fresh password-login proof.',
    );
    tokens.set('ownerMain', {
      ...oldRecord,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      passwordAt: refreshedPassword.timestamp,
    });
    created.set(oldRecord.sessionId, tokens.get('ownerMain'));
    ownerState = await read('ownerMain');
    const ordinary = next(ownerState.envelope);
    success(
      await edge('ownerMain', '', 'PUT', putBody(ordinary, ownerState.envelope.revision), ownerState.epoch),
      'Stale login incorrectly blocked an ordinary snapshot.',
    );
    const rekey = next(ordinary, true);
    rejected(
      await edge('ownerMain', '', 'PUT', putBody(rekey, ordinary.revision), ownerState.epoch),
      [403],
      'Refreshed stale AMR authorized a sensitive rekey.',
      ['REAUTHENTICATION_REQUIRED'],
    );
    equal((await read('ownerMain')).envelope, ordinary, 'Denied rekey changed the stored snapshot.');
    evidence.staleAmr = coordinate
      ? 'Operator-aged synthetic DB AMR plus real Auth refresh; verified password AMR remained stale and rekey was denied. Not a naturally elapsed-time test.'
      : 'Real password AMR aged naturally beyond five minutes; real refresh preserved it and rekey was denied.';

    await logout('ownerMain');
    await login('ownerMain', 'owner');
    ownerState = await read('ownerMain');
    await resetOwned('ownerMain', original.vaultId);
    const afterReset = await read('ownerMain');
    rejected(
      await edge('ownerMain', '', 'PUT', originalBody, afterReset.epoch),
      [403, 409],
      'Retired context used an old exact-body receipt to revive a snapshot.',
    );
    rejected(
      await edge('ownerMain', `/receipt/${original.vaultId}/${original.operationId}`, 'GET', undefined, afterReset.epoch),
      [403, 404, 409],
      'Retired context exposed a historical receipt as active.',
    );
    const changedOwner = { ...original, ownerId: config.users.otherOwner.id, operationId: encoded(16) };
    rejected(await edge('otherMain', '', 'PUT', putBody(changedOwner), initialOther.epoch), [403, 409], 'Another owner revived a globally retired context.');
    check((await read('otherMain')).envelope === null, 'Retired-context probe changed the other owner.');

    // A fresh login is required after the intentional stale-proof experiment.
    await logout('otherMain');
    await login('otherMain', 'otherOwner');
    const otherEnvelope = fresh(config.users.otherOwner.id);
    const otherState = await read('otherMain');
    success(await edge('otherMain', '', 'PUT', putBody(otherEnvelope), otherState.epoch), 'Other synthetic owner could not create its own separate context.');
    cleanup.set('otherMain', otherEnvelope.vaultId);
    equal((await read('otherMain')).envelope, otherEnvelope, 'Other owner snapshot changed unexpectedly.');
    check((await read('ownerMain')).envelope === null, 'Other owner creation changed the reset owner context.');
    await resetOwned('otherMain', otherEnvelope.vaultId);
    check(
      (await read('ownerMain')).envelope === null && (await read('otherMain')).envelope === null,
      'Synthetic vault cleanup did not preserve empty baselines.',
    );
    evidence.result = 'passed';
  } catch (error) {
    failure = error;
    evidence.result = 'failed';
    evidence.failure = error instanceof SmokeError ? error.message : 'Local configuration, API or network failure; credentials suppressed.';
  } finally {
    for (const [name, vaultId] of cleanup) {
      try {
        const fixtureName = tokens.get(name)?.fixtureName;
        if (!fixtureName) throw new SmokeError('Missing synthetic cleanup identity.');
        await logout(name);
        await login(name, fixtureName);
        await resetOwned(name, vaultId);
      } catch {
        evidence.cleanupPending = true;
      }
    }
    for (const record of created.values()) {
      try {
        const response = await request('/auth/v1/logout?scope=local', record.accessToken, 'POST');
        if (![204, 401, 403].includes(response.status)) evidence.sessionCleanupPending = true;
      } catch {
        evidence.sessionCleanupPending = true;
      }
    }
    evidence.assertions = assertions;
    evidence.requests = requests;
    evidence.projectRef = TEST_HOST.split('.')[0];
    evidence.onboarding = 'disabled';
    if (evidence.cleanupPending || evidence.sessionCleanupPending) evidence.result = 'failed';
    await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(evidence, null, 2));
  }
  if (failure) throw failure;
  if (evidence.cleanupPending || evidence.sessionCleanupPending) throw new SmokeError('Synthetic cleanup requires operator review.');
}

main().catch(error => {
  console.error(
    error instanceof SmokeError
      ? `Finance 6B1 smoke failed: ${error.message}`
      : 'Finance 6B1 smoke failed: local configuration, API or network error; credentials suppressed.',
  );
  process.exitCode = 1;
});
