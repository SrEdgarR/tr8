import { describe, expect, it, vi } from 'vitest';
import vector from '../../../src/app/finance/compatibility/fixtures/vault-vectors.json';
import { encodeBase64Url, type VaultEnvelope } from '../../../src/app/finance/compatibility/protocol.ts';
import { createFinanceHandler, FinanceError, readFinanceBytes, type FinanceActor, type FinanceRuntime } from './handler.ts';
import { createFinanceRuntime } from './runtime.ts';

const PROJECT = 'https://kajcbwlnqcwcpbtqyieo.supabase.co';
const ORIGIN = 'http://127.0.0.1:5173';
const OWNER = 'f6b10000-0000-4000-8000-000000000001';
const SESSION = 'f6b11000-0000-4000-8000-000000000001';
const NOW = 1_792_756_800_000;
const actor: FinanceActor = { id: OWNER, session: SESSION, expiresAt: NOW / 1000 + 3600, passwordAt: NOW / 1000 };
const request = (method = 'GET', path = '', body?: string, headers: Record<string, string> = {}) =>
  new Request(`${PROJECT}/functions/v1/tr8-finance${path}`, {
    method,
    headers: { Origin: ORIGIN, Authorization: 'Bearer synthetic', 'Content-Type': 'application/json', 'x-tr8-finance-epoch': '1', ...headers },
    ...(body === undefined ? {} : { body }),
  });
const fixture = () => ({ ...structuredClone(vector.envelope), ownerId: OWNER }) as VaultEnvelope;
const put = () => {
  const envelope = fixture();
  return JSON.stringify({ expectedRevision: '0', operationId: envelope.operationId, envelope });
};

function harness(overrides: Partial<FinanceRuntime> = {}) {
  const runtime: FinanceRuntime = {
    origin: ORIGIN,
    enabled: true,
    authenticate: vi.fn(async () => actor),
    call: vi.fn(async () => ({ revision: '1', operationId: fixture().operationId })),
    ...overrides,
  };
  return { runtime, handle: createFinanceHandler(runtime) };
}

describe('finance synthetic HTTP boundary', () => {
  it('bounds total read time and does not await an uncooperative cancellation', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const pending = readFinanceBytes(new Response(new ReadableStream<Uint8Array>({ cancel })), 4096).then(
        () => 'accepted',
        error => error.code,
      );
      await vi.advanceTimersByTimeAsync(8000);
      expect(await Promise.race([pending, Promise.resolve('still-reading')])).toBe('BODY_TIMEOUT');
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('is off before authentication and never activates production by configuration', async () => {
    const { handle, runtime } = harness({ enabled: false });
    expect((await handle(request())).status).toBe(503);
    expect(runtime.authenticate).not.toHaveBeenCalled();
    const production = environment({ SUPABASE_URL: 'https://ggbjezprlsnhidlbjivl.supabase.co', TR8_FINANCE_TEST_PROJECT_REF: 'ggbjezprlsnhidlbjivl' });
    expect(createFinanceRuntime(name => production[name]).enabled).toBe(false);
    const disabled = environment({ TR8_FINANCE_TESTING_ENABLED: 'false' });
    expect(createFinanceRuntime(name => disabled[name]).enabled).toBe(false);
  });

  it.each(['https://evil.invalid', 'null', ORIGIN + '/', ''])('denies non-exact origin %s', async origin => {
    const { handle, runtime } = harness();
    expect((await handle(request('GET', '', undefined, { Origin: origin }))).status).toBe(403);
    expect(runtime.authenticate).not.toHaveBeenCalled();
    expect(runtime.call).not.toHaveBeenCalled();
  });

  it('preflight grants only explicit methods/headers and is never authentication', async () => {
    const { handle, runtime } = harness();
    const accepted = await handle(
      request('OPTIONS', '', undefined, {
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'authorization, content-type, x-tr8-finance-epoch',
      }),
    );
    expect(accepted.status).toBe(204);
    expect(accepted.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(runtime.authenticate).not.toHaveBeenCalled();
    expect((await handle(request('OPTIONS', '', undefined, { 'Access-Control-Request-Method': 'DELETE' }))).status).toBe(403);
    expect(
      (await handle(request('OPTIONS', '', undefined, { 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-user-id' }))).status,
    ).toBe(403);
  });

  it('still requires verified identity despite correct CORS and never exposes errors', async () => {
    const { handle, runtime } = harness({
      authenticate: vi.fn(async () => {
        throw new FinanceError('AUTH_REQUIRED', 401);
      }),
    });
    const result = await handle(request());
    expect(result.status).toBe(401);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(runtime.call).not.toHaveBeenCalled();
    const failed = harness({
      call: vi.fn(async () => {
        throw new Error('sensitive fixture exception');
      }),
    });
    expect(await (await failed.handle(request())).text()).not.toContain('sensitive');
  });

  it('preserves exact PUT bytes and derives actor separately from the body', async () => {
    const { handle, runtime } = harness();
    const body = ` \n${put()}\n`;
    expect((await handle(request('PUT', '', body))).status).toBe(200);
    const [action, verified, args] = vi.mocked(runtime.call).mock.calls[0];
    expect(action).toBe('put');
    expect(verified).toEqual(actor);
    expect(Buffer.from(args.p_body_base64 as string, 'base64').toString('utf8')).toBe(body);
    expect(args.p_expected_epoch).toBe('1');
    const foreign = JSON.parse(put());
    foreign.envelope.ownerId = 'foreign';
    expect((await handle(request('PUT', '', JSON.stringify(foreign)))).status).toBe(403);
    expect(runtime.call).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate keys, invalid UTF-8, extra owner fields and compression', async () => {
    const { handle, runtime } = harness();
    expect((await handle(request('PUT', '', put().replace('"expectedRevision":"0"', '"expectedRevision":"0","expectedRevision":"0"')))).status).toBe(400);
    expect((await handle(request('PUT', '', JSON.stringify({ ...JSON.parse(put()), ownerId: OWNER })))).status).toBe(400);
    expect((await handle(request('PUT', '', put(), { 'Content-Encoding': 'gzip' }))).status).toBe(400);
    const invalid = new Request(`${PROJECT}/functions/v1/tr8-finance`, {
      method: 'PUT',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: new Uint8Array([0xff]),
    });
    expect((await handle(invalid)).status).toBe(400);
    expect(runtime.call).not.toHaveBeenCalled();
  });

  it('uses canonical IDs, separate lifecycle contracts and explicit epochs', async () => {
    const { handle, runtime } = harness();
    const envelope = fixture();
    expect((await handle(request('GET', `/receipt/${envelope.vaultId}/${envelope.operationId}`))).status).toBe(200);
    expect(runtime.call).toHaveBeenLastCalledWith('receipt', actor, {
      p_vault_id: envelope.vaultId,
      p_operation_id: envelope.operationId,
      p_expected_epoch: '1',
    });
    const command = { operationId: envelope.operationId, expectedEpoch: '1', expectedVaultId: envelope.vaultId };
    expect((await handle(request('POST', '/reset', JSON.stringify(command)))).status).toBe(200);
    expect(runtime.call).toHaveBeenLastCalledWith('reset', actor, {
      p_operation_id: command.operationId,
      p_expected_epoch: '1',
      p_vault_id: command.expectedVaultId,
    });
    expect((await handle(request('POST', '/reset', JSON.stringify({ ...command, expectedEpoch: 1 })))).status).toBe(400);
    expect((await handle(request('PUT', '', put(), { 'x-tr8-finance-epoch': '01' }))).status).toBe(400);
  });

  it('bounds many empty and tiny stream chunks without retaining per-chunk storage', async () => {
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === 4000) {
          controller.close();
          return;
        }
        controller.enqueue(index++ % 2 ? new Uint8Array([42]) : new Uint8Array());
      },
    });
    expect(await readFinanceBytes(new Response(stream), 2048)).toEqual(new Uint8Array(2000).fill(42));
    await expect(readFinanceBytes(new Response(new Uint8Array(2049)), 2048)).rejects.toMatchObject({ code: 'ENVELOPE_TOO_LARGE' });
  });
});

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SUPABASE_URL: PROJECT,
    SUPABASE_ANON_KEY: 'synthetic-public-key',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-backend-key',
    TR8_FINANCE_TESTING_ENABLED: 'true',
    TR8_FINANCE_TEST_PROJECT_REF: 'kajcbwlnqcwcpbtqyieo',
    TR8_FINANCE_ALLOWED_ORIGIN: ORIGIN,
    ...overrides,
  };
}
function token(claims: Record<string, unknown> = {}) {
  const payload = {
    sub: OWNER,
    session_id: SESSION,
    iss: `${PROJECT}/auth/v1`,
    aud: 'authenticated',
    role: 'authenticated',
    is_anonymous: false,
    exp: NOW / 1000 + 3600,
    iat: NOW / 1000,
    amr: [{ method: 'password', timestamp: NOW / 1000 }],
    ...claims,
  };
  return `e30.${encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}.synthetic-signature`;
}
function runtimeHarness(claims: Record<string, unknown> = {}, ok = true) {
  const env = environment();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: OWNER, is_anonymous: false }, { status: ok ? 200 : 401 }));
  const runtime = createFinanceRuntime(
    name => env[name],
    fetcher,
    () => NOW,
  );
  const incoming = new Request(`${PROJECT}/functions/v1/tr8-finance`, { headers: { Authorization: `Bearer ${token(claims)}` } });
  return { runtime, incoming, fetcher };
}

describe('actual Auth transport and verified-claim mapping; provider is mocked here', () => {
  it('verifies the exact token through Auth before trusting its identity/AMR', async () => {
    const { runtime, incoming, fetcher } = runtimeHarness();
    expect(await runtime.authenticate(incoming)).toEqual(actor);
    expect(fetcher).toHaveBeenCalledWith(
      `${PROJECT}/auth/v1/user`,
      expect.objectContaining({
        headers: { apikey: 'synthetic-public-key', Authorization: incoming.headers.get('authorization') },
        redirect: 'error',
        cache: 'no-store',
      }),
    );
    const rejected = runtimeHarness({}, false);
    await expect(rejected.runtime.authenticate(rejected.incoming)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it.each([
    { sub: 'foreign' },
    { session_id: 'not-uuid' },
    { iss: 'https://foreign.invalid/auth/v1' },
    { aud: 'anon' },
    { role: 'service_role' },
    { is_anonymous: true },
    { exp: NOW / 1000 },
    { nbf: NOW / 1000 + 1 },
  ])('rejects authenticated-provider response with invalid claims %j', async claims => {
    const { runtime, incoming } = runtimeHarness(claims);
    await expect(runtime.authenticate(incoming)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('does not turn fresh iat or refresh/recovery into password login evidence', async () => {
    for (const method of ['token_refresh', 'recovery', 'oauth']) {
      const { runtime, incoming } = runtimeHarness({ amr: [{ method, timestamp: NOW / 1000 }] });
      expect((await runtime.authenticate(incoming)).passwordAt).toBeNull();
    }
    const stale = runtimeHarness({
      amr: [
        { method: 'password', timestamp: NOW / 1000 - 600 },
        { method: 'token_refresh', timestamp: NOW / 1000 },
      ],
    });
    expect((await stale.runtime.authenticate(stale.incoming)).passwordAt).toBe(NOW / 1000 - 600);
  });

  it('protects trusted RPC actor fields and sanitizes backend failures', async () => {
    const { runtime, fetcher } = runtimeHarness();
    fetcher.mockResolvedValueOnce(Response.json({ code: 'PT409', message: 'private error details' }, { status: 409 }));
    await expect(runtime.call('put', actor, { p_actor: 'foreign', p_session: 'foreign' })).rejects.toMatchObject({ code: 'FINANCE_CONFLICT', status: 409 });
    const sent = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(sent.p_actor).toBe(OWNER);
    expect(sent.p_session).toBe(SESSION);
    expect(fetcher.mock.calls[0][1]!.headers).toEqual({ apikey: 'synthetic-backend-key', 'Content-Type': 'application/json' });
  });
});
