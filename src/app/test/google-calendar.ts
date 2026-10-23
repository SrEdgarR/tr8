import type { GoogleAuthorization, GoogleCalendarStatus } from '../data/google-calendar';
export function googleFixture(overrides: Partial<GoogleCalendarStatus> = {}): GoogleCalendarStatus {
  return { configured: true, state: 'disconnected', generation: 0, version: 1, last_sync_at: null, pending: 0, failed: 0, reason: null, ...overrides };
}
export function googleAuthorization(): GoogleAuthorization {
  const state = 's'.repeat(43);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    state,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.app.created',
    code_challenge_method: 'S256',
    code_challenge: 'c'.repeat(43),
    client_id: 'test.apps.googleusercontent.com',
    redirect_uri: 'https://test.supabase.co/functions/v1/tr8-google',
  }).toString();
  return { authorization_url: url.href, state };
}
