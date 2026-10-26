import type { SupabaseClient } from '@supabase/supabase-js';
import { DataError } from './errors';

/** Bind account-scoped requests to the verified session, rather than the client's mutable current session. */
export async function verifiedAccessToken(client: SupabaseClient, ownerId: string): Promise<string> {
  try {
    const { data, error } = await client.auth.getSession();
    const session = data.session;
    if (!error && session?.user.id === ownerId && typeof session.access_token === 'string' && session.access_token) {
      const verified = await client.auth.getUser(session.access_token);
      if (!verified.error && verified.data.user?.id === ownerId) return session.access_token;
    }
  } catch {
    // Transport errors and credential material must never reach the interface.
  }
  throw new DataError('Tu sesión cambió. Vuelve a iniciar sesión.');
}
