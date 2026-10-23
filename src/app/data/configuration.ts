export interface AppConfiguration {
  url: string;
  publishableKey: string;
  ownerEmail: string;
}

export function readConfiguration(values: Record<string, string | undefined>): AppConfiguration | null {
  const url = values.VITE_SUPABASE_URL?.trim() ?? '';
  const publishableKey = values.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';
  const ownerEmail = values.VITE_OWNER_EMAIL?.trim().toLowerCase() ?? '';
  if (!url || !publishableKey || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) return null;
  try {
    const parsed = new URL(url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) || parsed.username || parsed.password) return null;
    if (publishableKey.startsWith('sb_publishable_')) return { url: parsed.origin, publishableKey, ownerEmail };
    // Legacy anon keys are supported; privileged JWTs are never accepted by this client.
    const payload = JSON.parse(atob(publishableKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.role !== 'anon') return null;
    return { url: parsed.origin, publishableKey, ownerEmail };
  } catch {
    return null;
  }
}
