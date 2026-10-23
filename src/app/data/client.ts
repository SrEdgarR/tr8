import { createClient } from '@supabase/supabase-js';
import { readConfiguration } from './configuration';

export const callbackRequestedRecovery =
  new URLSearchParams(location.search).get('auth') === 'recovery' || new URLSearchParams(location.hash.slice(1)).get('type') === 'recovery';
export const configuration = readConfiguration(import.meta.env);
export const supabase = configuration
  ? createClient(configuration.url, configuration.publishableKey, {
      auth: {
        flowType: 'pkce',
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
        storageKey: 'gr8r.auth.v1',
      },
    })
  : null;
