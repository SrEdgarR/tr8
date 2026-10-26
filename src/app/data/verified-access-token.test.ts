import type { SupabaseClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { verifiedAccessToken } from './verified-access-token';

it('verifies and returns the captured token, even when the mutable current session changes during verification', async () => {
  const session = { access_token: 'synthetic-first-token', user: { id: 'owner' } };
  const getSession = vi.fn(async () => ({ data: { session }, error: null }));
  const getUser = vi.fn(async (token: string) => {
    expect(token).toBe('synthetic-first-token');
    getSession.mockResolvedValue({ data: { session: { access_token: 'synthetic-other-token', user: { id: 'other' } } }, error: null });
    return { data: { user: { id: 'owner' } }, error: null };
  });
  expect(await verifiedAccessToken({ auth: { getSession, getUser } } as unknown as SupabaseClient, 'owner')).toBe('synthetic-first-token');
});

it.each([
  [null, 'owner'],
  [{ access_token: 'synthetic-token', user: { id: 'other' } }, 'owner'],
  [{ access_token: '', user: { id: 'owner' } }, 'owner'],
  [{ access_token: 'synthetic-token', user: { id: 'owner' } }, 'other'],
])('rejects absent, mismatched or unverified identities without reflecting credentials', async (session, verifiedOwner) => {
  const getSession = vi.fn(async () => ({ data: { session }, error: null }));
  const getUser = vi.fn(async () => ({ data: { user: { id: verifiedOwner } }, error: null }));
  await expect(verifiedAccessToken({ auth: { getSession, getUser } } as unknown as SupabaseClient, 'owner')).rejects.toThrow('Tu sesión cambió');
  if (session?.user.id !== 'owner' || !session.access_token) expect(getUser).not.toHaveBeenCalled();
});

it('replaces auth transport diagnostics with a fixed safe error', async () => {
  const getSession = vi.fn(async () => {
    throw Error('synthetic-sensitive-diagnostic');
  });
  await expect(verifiedAccessToken({ auth: { getSession } } as unknown as SupabaseClient, 'owner')).rejects.toThrow(/^Tu sesión cambió/);
});
