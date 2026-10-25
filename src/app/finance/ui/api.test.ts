import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createFinanceApi, validateHead } from './api';
import { testEnvelope } from '../worker/test-fixtures';
import { DefinitiveOpaqueSaveError } from '../session/opaque-save';

const origin = 'https://kajcbwlnqcwcpbtqyieo.supabase.co';
const owner = testEnvelope().ownerId;
const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function setup(overrides: Record<string, unknown> = {}) {
  const claims = {
    sub: owner,
    iss: `${origin}/auth/v1`,
    role: 'authenticated',
    aud: 'authenticated',
    session_id: sessionId,
    exp: Math.floor(Date.now() / 1000) + 1000,
    ...overrides,
  };
  const token = `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const user = { id: owner, email: 'fixture@example.test' };
  const session = { user, access_token: token };
  let listener: (_event: string, value: typeof session | null) => void = () => {};
  const unsubscribe = vi.fn();
  const client = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session }, error: null })),
      getUser: vi.fn(async () => ({ data: { user }, error: null })),
      signInWithPassword: vi.fn(async () => ({ data: { user }, error: null })),
      onAuthStateChange: vi.fn((fn: typeof listener) => {
        listener = fn;
        return { data: { subscription: { unsubscribe } } };
      }),
    },
  };
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ envelope: null, epoch: '1' })));
  vi.stubGlobal('fetch', fetcher);
  return {
    client,
    fetcher,
    token,
    user,
    session,
    unsubscribe,
    emit: (value: typeof session | null) => listener('TOKEN_REFRESHED', value),
    api: createFinanceApi(client as unknown as SupabaseClient, owner, origin, 'public-key'),
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('Financial authenticated opaque transport', () => {
  it('production gate performs no Auth or network requests', async () => {
    const h = setup();
    const api = createFinanceApi(h.client as unknown as SupabaseClient, owner, 'https://ggbjezprlsnhidlbjivl.supabase.co', 'public');
    expect(api.enabled).toBe(false);
    await expect(api.head()).rejects.toMatchObject({ code: 'FINANCE_DISABLED' });
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.client.auth.getSession).not.toHaveBeenCalled();
  });
  it('validates the exact bearer with Auth and uses bounded no-store requests', async () => {
    const h = setup();
    expect(await h.api.identity()).toEqual({ ownerId: owner, sessionId, epoch: '1', valid: true });
    expect(h.client.auth.getUser).toHaveBeenCalledWith(h.token);
    expect(h.fetcher).toHaveBeenCalledWith(
      `${origin}/functions/v1/tr8-finance`,
      expect.objectContaining({
        cache: 'no-store',
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: `Bearer ${h.token}`, apikey: 'public-key' }),
      }),
    );
  });
  it.each([{ sub: 'other' }, { iss: 'https://untrusted.example/auth/v1' }, { role: 'anon' }, { session_id: 'bad' }, { exp: 1 }])(
    'rejects mismatched verified session context %j',
    async claims => {
      const h = setup(claims);
      await expect(h.api.head()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(h.fetcher).not.toHaveBeenCalled();
    },
  );
  it('does not accept another owner or extra response fields', () => {
    expect(() => validateHead({ envelope: { ...testEnvelope(), ownerId: crypto.randomUUID() }, epoch: '1' }, owner)).toThrow();
    expect(() => validateHead({ envelope: null, epoch: '1', plaintext: 'forbidden' }, owner)).toThrow();
  });
  it('distinguishes definitive denial from ambiguous status', async () => {
    const h = setup();
    const identity = { ownerId: owner, sessionId, epoch: '1', valid: true };
    h.fetcher.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 'FINANCE_CONFLICT' } }), { status: 409 }));
    await expect(h.api.save('{}', identity)).rejects.toBeInstanceOf(DefinitiveOpaqueSaveError);
    h.fetcher.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 'FINANCE_CONFLICT' } }), { status: 503 }));
    await expect(h.api.save('{}', identity)).rejects.not.toBeInstanceOf(DefinitiveOpaqueSaveError);
  });
  it('requires a closed matching receipt and sends only the opaque body', async () => {
    const h = setup();
    h.fetcher.mockImplementation(async () => new Response(JSON.stringify({ operationId: testEnvelope().operationId, revision: '2' })));
    expect(await h.api.save('{"opaque":true}', { ownerId: owner, sessionId, epoch: '1', valid: true })).toEqual({
      operationId: testEnvelope().operationId,
      revision: '2',
    });
    expect(h.fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'PUT', body: '{"opaque":true}', headers: expect.objectContaining({ 'x-tr8-finance-epoch': '1' }) }),
    );
    h.fetcher.mockImplementation(async () => new Response('{"operationId":"bad","revision":"2"}'));
    await expect(h.api.save('{}', { ownerId: owner, sessionId, epoch: '1', valid: true })).rejects.toThrow();
  });
  it('ignores ordinary refresh but invalidates replaced or removed sessions', () => {
    const h = setup();
    const invalidate = vi.fn();
    const stop = h.api.subscribe(invalidate);
    h.emit(h.session);
    h.emit(h.session);
    expect(invalidate).not.toHaveBeenCalled();
    h.emit(null);
    expect(invalidate).toHaveBeenCalledOnce();
    stop();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });
});
