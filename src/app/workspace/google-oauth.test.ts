import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleAuthorization } from '../test/google-calendar';
import { browserSecret, openGooglePopup } from './google-oauth';

const origin = window.location.origin;
function popupFixture() {
  return { location: { href: 'about:blank' }, closed: false, close: vi.fn() } as unknown as Window;
}
function message(source: Window, data: unknown, from = origin) {
  window.dispatchEvent(new MessageEvent('message', { source, origin: from, data }));
}
describe('ventana OAuth con vínculo al navegador', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('genera 32 bytes aleatorios sin guardarlos en almacenamiento', () => {
    const store = vi.spyOn(Storage.prototype, 'setItem');
    const one = browserSecret();
    const two = browserSecret();
    expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(one).not.toBe(two);
    expect(store).not.toHaveBeenCalled();
  });
  it('abre la ventana de forma síncrona y solo acepta una señal vacía del origen y ventana exactos', async () => {
    const remote = popupFixture();
    const open = vi.spyOn(window, 'open').mockReturnValue(remote);
    const flow = openGooglePopup(origin, 'memory-only');
    expect(open).toHaveBeenCalledExactlyOnceWith('about:blank', '_blank', expect.stringContaining('popup'));
    const authorization = googleAuthorization();
    let settled = false;
    void flow.result.then(() => {
      settled = true;
    });
    flow.authorize(authorization);
    expect(remote.location.href).toBe(authorization.authorization_url);
    const payload = { type: 'tr8-google-oauth-ready' };
    message(remote, payload, 'https://attacker.test');
    message(popupFixture(), payload);
    message(remote, { ...payload, state: 'untrusted-state' });
    message(remote, { ...payload, code: 'untrusted-code' });
    message(remote, { type: 'tr8-google-oauth', state: authorization.state, code: 'legacy-code' });
    await Promise.resolve();
    expect(settled).toBe(false);
    message(remote, payload);
    expect(await flow.result).toEqual({ state: authorization.state, browser_secret: 'memory-only' });
    expect(remote.close).toHaveBeenCalledTimes(1);
    message(remote, payload);
    expect(remote.close).toHaveBeenCalledTimes(1);
  });
  it('conserva el state propio y nunca recibe código ni resultado OAuth desde el mensaje', async () => {
    const remote = popupFixture();
    vi.spyOn(window, 'open').mockReturnValue(remote);
    const flow = openGooglePopup(origin, 'memory-only');
    flow.authorize(googleAuthorization());
    message(remote, { type: 'tr8-google-oauth-ready' });
    expect(await flow.result).toEqual({ state: googleAuthorization().state, browser_secret: 'memory-only' });
  });
  it('cancela, limpia listeners y descarta señales tardías al abandonar el flujo', async () => {
    const remote = popupFixture();
    vi.spyOn(window, 'open').mockReturnValue(remote);
    const flow = openGooglePopup(origin, 'memory-only');
    flow.authorize(googleAuthorization());
    const failure = expect(flow.result).rejects.toMatchObject({ code: 'OAUTH_CANCELLED' });
    flow.cancel();
    message(remote, { type: 'tr8-google-oauth-ready' });
    await failure;
    expect(remote.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rechaza un origen externo configurado y señales antes de conocer el intento propio', async () => {
    const remote = popupFixture();
    const open = vi.spyOn(window, 'open').mockReturnValue(remote);
    expect(() => openGooglePopup('https://test.supabase.co', 'memory-only')).toThrow('destino de autorización');
    expect(open).not.toHaveBeenCalled();
    const flow = openGooglePopup(origin, 'memory-only');
    let settled = false;
    void flow.result.then(() => {
      settled = true;
    });
    message(remote, { type: 'tr8-google-oauth-ready' });
    await Promise.resolve();
    expect(settled).toBe(false);
    flow.authorize(googleAuthorization());
    message(remote, { type: 'tr8-google-oauth-ready' });
    expect(await flow.result).toEqual({ state: googleAuthorization().state, browser_secret: 'memory-only' });
  });
  it('detecta ventana bloqueada o cerrada y caducidad sin mantener temporizadores', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(() => openGooglePopup(origin, 'memory-only')).toThrow('ventana emergente');
    const remote = popupFixture();
    open.mockReturnValue(remote);
    const flow = openGooglePopup(origin, 'memory-only');
    const failure = expect(flow.result).rejects.toThrow('Se cerró');
    Object.assign(remote, { closed: true });
    vi.advanceTimersByTime(500);
    await failure;
    const another = popupFixture();
    open.mockReturnValue(another);
    const expired = openGooglePopup(origin, 'memory-only');
    const timeout = expect(expired.result).rejects.toThrow('caducó');
    vi.advanceTimersByTime(600000);
    await timeout;
    expect(vi.getTimerCount()).toBe(0);
  });
});
