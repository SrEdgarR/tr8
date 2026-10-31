import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { consentRedirect, createOAuthConsentApi, type OAuthConsentDetails } from './consent-api';

const attempt = `tr8_oauth_p_${'a'.repeat(64)}`,
  code = `tr8_oauth_c_${'b'.repeat(64)}`;
const credential = '11111111-1111-4111-8111-111111111111';
const fingerprint = 'd'.repeat(64);
const redirect = 'https://client.example/callback';
function details(): OAuthConsentDetails {
  return {
    attempt,
    client_id: 'synthetic-dot',
    client_name: 'Asistente ficticio',
    redirect_uri: redirect,
    scopes: ['finance:read'],
    resource: 'https://tr8.vercel.app/api/mcp/finance',
    expires_at: new Date(Date.now() + 300000).toISOString(),
    connections: [
      {
        credential_id: credential,
        grant_fingerprint: fingerprint,
        name: 'Permiso de ejemplo',
        access: 'read',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        accounts: [{ account_id: 'dop', name: 'Ahorros ficticios', currency: 'DOP', start_at: '2026-01-02T00:00:00Z' }],
        mailbox_ids: ['c'.repeat(64)],
        expense_categories: ['other'],
        income_categories: ['other'],
      },
    ],
  };
}
function setup(data: unknown) {
  const setHeader = vi.fn(async () => ({ data, error: null as null | { code: string; message: string } }));
  const rpc = vi.fn(() => ({ setHeader }));
  const getUser = vi.fn(async () => ({ data: { user: { id: 'owner-a' } }, error: null }));
  const getSession = vi.fn(async () => ({ data: { session: { access_token: 'synthetic-browser-session', user: { id: 'owner-a' } } }, error: null }));
  return { api: createOAuthConsentApi({ rpc, auth: { getUser, getSession } } as unknown as SupabaseClient, 'owner-a'), rpc, setHeader, getUser };
}
describe('financial OAuth browser consent boundary', () => {
  it('does not create or approve an access when constructed or reading details', async () => {
    const value = details(),
      h = setup(value);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(await h.api.details(attempt)).toEqual(value);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('tr8_mcp_oauth_consent', { p_action: 'details', p_input: { attempt } });
    expect(h.setHeader).toHaveBeenCalledWith('Authorization', 'Bearer synthetic-browser-session');
  });
  it('requires a valid attempt and exact credential identity before consent', async () => {
    const h = setup({ redirect_uri: redirect, state: null, code });
    await expect(h.api.approve('attacker', credential, fingerprint)).rejects.toThrow();
    await expect(h.api.approve(attempt, 'foreign-not-a-uuid', fingerprint)).rejects.toThrow();
    await expect(h.api.approve(attempt, credential, 'invalid-fingerprint')).rejects.toThrow();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(await h.api.approve(attempt, credential, fingerprint)).toMatchObject({ code });
    expect(h.rpc).toHaveBeenCalledWith('tr8_mcp_oauth_consent', {
      p_action: 'approve',
      p_input: { attempt, credential_id: credential, grant_fingerprint: fingerprint },
    });
  });
  it('accepts read-only connections without mailboxes and rejects empty-mailbox write connections', async () => {
    const value = details();
    value.connections[0]!.mailbox_ids = [];
    value.connections[0]!.expense_categories = [];
    value.connections[0]!.income_categories = [];
    expect(await setup(value).api.details(attempt)).toEqual(value);
    value.connections[0]!.access = 'write';
    await expect(setup(value).api.details(attempt)).rejects.toThrow('No pudimos comprobar');
  });
  it.each([
    () => ({ ...details(), access_token: 'must-not-reach-browser' }),
    () => ({ ...details(), resource: 'https://another.example/mcp' }),
    () => ({ ...details(), attempt: `tr8_oauth_p_${'d'.repeat(64)}` }),
    () => ({ ...details(), redirect_uri: 'javascript:alert(1)' }),
    () => ({ ...details(), redirect_uri: 'https://user:password@client.example/callback' }),
    () => ({ ...details(), scopes: ['openid', 'admin'] }),
  ])('rejects secret-bearing or inconsistent consent responses', async value => {
    await expect(setup(value()).api.details(attempt)).rejects.toThrow('No pudimos comprobar');
  });
  it('discards results when the account changes while a request is in flight', async () => {
    const h = setup(details());
    h.getUser
      .mockResolvedValueOnce({ data: { user: { id: 'owner-a' } }, error: null })
      .mockResolvedValueOnce({ data: { user: { id: 'owner-b' } }, error: null });
    await expect(h.api.details(attempt)).rejects.toThrow('Tu sesión cambió');
  });
  it('does not expose backend diagnostics on an uncertain approval', async () => {
    const h = setup(null);
    h.setHeader.mockResolvedValue({ data: null, error: { code: 'XX000', message: `private ${code}` } });
    await expect(h.api.approve(attempt, credential, fingerprint)).rejects.toThrow('No se pudo confirmar');
    await expect(h.api.approve(attempt, credential, fingerprint)).rejects.not.toThrow(code);
  });
  it('returns only to the exact reviewed callback and preserves OAuth state', () => {
    const value = details();
    const url = new URL(consentRedirect(value, { redirect_uri: redirect, state: 'state + /', code }));
    expect(url.searchParams.get('code')).toBe(code);
    expect(url.searchParams.get('state')).toBe('state + /');
    expect(() => consentRedirect(value, { redirect_uri: 'https://attacker.example/callback', state: null, code })).toThrow('No pudimos comprobar');
    expect(new URL(consentRedirect(value, { redirect_uri: redirect, state: 's', error: 'access_denied' })).searchParams.get('error')).toBe('access_denied');
  });
});
