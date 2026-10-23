import { DataError } from '../data/errors';
import { parseGoogleAuthorization, type GoogleAuthorization, type GoogleCompletion } from '../data/google-calendar';

export function browserSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
export interface GooglePopup {
  result: Promise<GoogleCompletion>;
  cancel: () => void;
  authorize: (authorization: GoogleAuthorization) => void;
}
/** Open synchronously inside the click handler; credentials remain only in this closure. */
export function openGooglePopup(callbackOrigin: string, secret: string): GooglePopup {
  let origin: string;
  try {
    origin = new URL(callbackOrigin).origin;
  } catch {
    throw new DataError('No se pudo comprobar el destino de autorización.');
  }
  const local = new URL(origin).protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(new URL(origin).hostname);
  if (origin !== callbackOrigin || origin !== window.location.origin || (!origin.startsWith('https://') && !local))
    throw new DataError('No se pudo comprobar el destino de autorización.');
  const popup = window.open('about:blank', '_blank', 'popup,width=520,height=720');
  if (!popup) throw new DataError('Permite abrir una ventana emergente para conectar Google Calendar.', 'POPUP_BLOCKED');
  let expectedState: string | null = null;
  let settled = false;
  let resolve!: (value: GoogleCompletion) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<GoogleCompletion>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  function cleanup() {
    window.removeEventListener('message', receive);
    window.clearInterval(closed);
    window.clearTimeout(timeout);
    popup?.close();
  }
  function fail(message: string) {
    if (settled) return;
    settled = true;
    cleanup();
    reject(new DataError(message, 'OAUTH_CANCELLED'));
  }
  function receive(event: MessageEvent) {
    if (settled || !expectedState || event.origin !== origin || event.source !== popup || typeof event.data !== 'object' || event.data === null) return;
    const data = event.data as Record<string, unknown>;
    if (data.type !== 'tr8-google-oauth-ready' || Object.keys(data).length !== 1) return;
    settled = true;
    cleanup();
    resolve({ state: expectedState, browser_secret: secret });
  }
  window.addEventListener('message', receive);
  const closed = window.setInterval(() => {
    if (popup.closed) fail('Se cerró la autorización. Puedes volver a conectar cuando quieras.');
  }, 500);
  const timeout = window.setTimeout(() => fail('La autorización caducó. Vuelve a conectar Google Calendar.'), 10 * 60 * 1000);
  return {
    result,
    cancel: () => fail('La autorización se canceló al cambiar de sesión o de pantalla.'),
    authorize: value => {
      if (settled) return;
      const authorization = parseGoogleAuthorization(value);
      expectedState = authorization.state;
      popup.location.href = authorization.authorization_url;
    },
  };
}
