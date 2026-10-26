import { describe, expect, it, vi } from 'vitest';
import { createGoogleRuntime, GoogleServiceError, boundedJson } from './google-runtime.ts';
import { randomBase64Url } from './google-crypto.ts';

const userId = '10000000-0000-4000-8000-000000000001';
const sessionId = '10000000-0000-4000-8000-000000000002';
function setup(fetcher: typeof fetch = vi.fn<typeof fetch>(async () => Response.json({}))) {
  const env: Record<string, string> = {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'synthetic-public' }),
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'synthetic-server-only' }),
    TR8_GOOGLE_APP_ORIGIN: 'https://tr8.example.test',
    TR8_GOOGLE_CLIENT_ID: 'synthetic-client',
    TR8_GOOGLE_CLIENT_SECRET: 'synthetic-client-secret',
    TR8_GOOGLE_ENCRYPTION_KEYS: JSON.stringify({ first: randomBase64Url() }),
    TR8_GOOGLE_ACTIVE_KEY: 'first',
    TR8_GOOGLE_WORKER_SECRET: randomBase64Url(),
  };
  return { env, make: () => createGoogleRuntime(name => env[name], fetcher), fetcher };
}
function token(sub = userId, overrides: Record<string, unknown> = {}) {
  return `synthetic.${btoa(JSON.stringify({ sub, role: 'authenticated', iss: 'https://project.supabase.co/auth/v1', aud: 'authenticated', is_anonymous: false, session_id: sessionId, exp: Math.floor(Date.now() / 1000) + 3600, ...overrides })).replaceAll('=', '')}.signature`;
}
describe('Google server runtime', () => {
  it('fails closed until every server prerequisite exists', () => {
    const f = setup();
    expect(f.make().configured).toBe(true);
    delete f.env.TR8_GOOGLE_CLIENT_SECRET;
    expect(f.make().configured).toBe(false);
  });
  it('does not accept redirect parameters as an application origin', () => {
    const f = setup();
    f.env.TR8_GOOGLE_APP_ORIGIN = 'https://tr8.example.test/?redirect=bad';
    expect(f.make().configured).toBe(false);
  });
  it('uses the server key only on native RPC apikey, never Bearer or URL', async () => {
    const f = setup();
    await f.make().rpc('claim', { limit: 2 });
    const [url, options] = vi.mocked(f.fetcher).mock.calls[0];
    expect(url).toBe('https://project.supabase.co/rest/v1/rpc/tr8_server_google');
    expect(options?.headers).toEqual({ apikey: 'synthetic-server-only', 'Content-Type': 'application/json' });
    expect(options?.redirect).toBe('error');
  });
  it('verifies the JWT remotely before extracting user and initiating session', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: userId }));
    const f = setup(fetcher);
    expect(await f.make().authenticate(new Request('https://project.supabase.co', { headers: { Authorization: `Bearer ${token()}` } }))).toEqual({
      id: userId,
      session: sessionId,
    });
    expect(fetcher.mock.calls[0][0]).toBe('https://project.supabase.co/auth/v1/user');
  });
  it('does not trust a claimed user that differs from the verified user', async () => {
    const f = setup(vi.fn<typeof fetch>(async () => Response.json({ id: userId })));
    await expect(
      f.make().authenticate(new Request('https://project.supabase.co', { headers: { Authorization: `Bearer ${token(sessionId)}` } })),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('denies anonymous requests without a network call', async () => {
    const f = setup();
    await expect(f.make().authenticate(new Request('https://project.supabase.co'))).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('maps SQL diagnostics to sanitized errors', async () => {
    const f = setup(vi.fn<typeof fetch>(async () => Response.json({ code: 'PT409', message: 'synthetic-private-diagnostic' }, { status: 409 })));
    await expect(f.make().rpc('begin')).rejects.toMatchObject({ code: 'STALE_VERSION', status: 409, message: 'STALE_VERSION' });
  });
  it('reports expired or unavailable OAuth attempts without exposing SQL diagnostics', async () => {
    const f = setup(vi.fn<typeof fetch>(async () => Response.json({ code: 'PT404', message: 'private attempt details' }, { status: 404 })));
    await expect(f.make().rpc('consume_attempt')).rejects.toMatchObject({ code: 'OPERATION_UNAVAILABLE', status: 404, message: 'OPERATION_UNAVAILABLE' });
  });
  it('limits request size before JSON parsing', async () => {
    await expect(boundedJson(new Request('https://example.test', { method: 'POST', body: 'x'.repeat(20_000) }))).rejects.toBeInstanceOf(GoogleServiceError);
  });
  it.each([
    { iss: 'https://another.supabase.co/auth/v1' },
    { aud: 'anon' },
    { is_anonymous: true },
    { exp: Number.MAX_VALUE },
    { nbf: Math.floor(Date.now() / 1000) + 3600 },
  ])('rejects a verified but unsuitable session context %j', async claims => {
    const f = setup(vi.fn<typeof fetch>(async () => Response.json({ id: userId })));
    await expect(
      f.make().authenticate(new Request('https://project.supabase.co', { headers: { Authorization: `Bearer ${token(userId, claims)}` } })),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('rejects anonymous Auth users even when their token omits the anonymous flag', async () => {
    const f = setup(vi.fn<typeof fetch>(async () => Response.json({ id: userId, is_anonymous: true })));
    await expect(f.make().authenticate(new Request('https://project.supabase.co', { headers: { Authorization: `Bearer ${token()}` } }))).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });
  it('stops reading a stalled stream at its deadline and cancels without waiting for the sender', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const body = new ReadableStream<Uint8Array>({ cancel });
      const pending = boundedJson(new Response(body)).then(
        () => 'accepted',
        error => error.code,
      );
      await vi.advanceTimersByTimeAsync(8000);
      expect(await Promise.race([pending, Promise.resolve('still-reading')])).toBe('INVALID_INPUT');
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
