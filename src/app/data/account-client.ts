import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfiguration } from './configuration';
import { verifiedAccessToken } from './verified-access-token';

/** Data-only client: a queued request can never adopt another signed-in account's token. */
export function createAccountDataClient(
  authClient: SupabaseClient,
  ownerId: string,
  configuration: Pick<AppConfiguration, 'url' | 'publishableKey'>,
  transport: typeof fetch = fetch,
): SupabaseClient {
  return createClient(configuration.url, configuration.publishableKey, {
    // Auth remains owned by the original client. Resolve the verified token at
    // the final fetch boundary, including REST pagination and Edge Functions.
    accessToken: async () => null,
    db: { retry: false },
    global: {
      fetch: async (input, init) => {
        const token = await verifiedAccessToken(authClient, ownerId);
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${token}`);
        return transport(input, { ...init, headers });
      },
    },
  });
}
