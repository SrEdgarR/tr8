import { createClient, FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { googleAuthorization, googleFixture } from '../test/google-calendar';
import { createGoogleCalendarRepository, parseGoogleAuthorization, parseGoogleStatus } from './google-calendar';

function repositoryFor(data: unknown, error: unknown = null) {
  const query = Object.assign(Promise.resolve({ data, error }), { abortSignal: vi.fn().mockReturnThis() });
  const rpc = vi.fn().mockReturnValue(query);
  const invoke = vi.fn().mockResolvedValue({ data, error });
  return { rpc, invoke, query, repository: createGoogleCalendarRepository({ rpc, functions: { invoke } } as unknown as SupabaseClient) };
}
describe('contrato personal de Google Calendar', () => {
  it('exige los dos permisos al solicitar Tasks y permite conservar un permiso de Tasks ya autorizado', () => {
    const authorization = googleAuthorization();
    const url = new URL(authorization.authorization_url);
    url.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/tasks');
    const tasksAuthorization = { ...authorization, authorization_url: url.href };
    expect(parseGoogleAuthorization(tasksAuthorization, true)).toEqual(tasksAuthorization);
    expect(parseGoogleAuthorization(tasksAuthorization)).toEqual(tasksAuthorization);
    expect(() => parseGoogleAuthorization(authorization, true)).toThrow('Actualiza TR8');
    for (const scope of [
      'https://www.googleapis.com/auth/tasks',
      'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/tasks.readonly',
      'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/tasks openid',
      'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/tasks',
      '',
    ]) {
      const badUrl = new URL(url);
      badUrl.searchParams.set('scope', scope);
      expect(() => parseGoogleAuthorization({ ...authorization, authorization_url: badUrl.href }, true)).toThrow('Actualiza TR8');
      expect(() => parseGoogleAuthorization({ ...authorization, authorization_url: badUrl.href })).toThrow('Actualiza TR8');
    }
  });

  it('envía tasks_requested solo cuando se pide y verifica la URL ampliada antes de devolverla', async () => {
    const authorization = googleAuthorization();
    const url = new URL(authorization.authorization_url);
    url.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/tasks');
    const tasksAuthorization = { ...authorization, authorization_url: url.href };
    const { repository, invoke } = repositoryFor(tasksAuthorization);
    const signal = new AbortController().signal;
    expect(
      await repository.beginGoogle({ request_id: 'tasks-request', expected_version: 5, browser_secret: 'browser-only', tasks_requested: true }, signal),
    ).toEqual(tasksAuthorization);
    expect(invoke).toHaveBeenLastCalledWith('tr8-google', {
      body: { action: 'begin', request_id: 'tasks-request', expected_version: 5, browser_secret: 'browser-only', tasks_requested: true },
      signal,
      timeout: 60000,
    });
    invoke.mockResolvedValue({ data: authorization, error: null });
    await expect(
      repository.beginGoogle({ request_id: 'missing-scope', expected_version: 5, browser_secret: 'browser-only', tasks_requested: true }),
    ).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    await repository.beginGoogle({ request_id: 'calendar-request', expected_version: 5, browser_secret: 'browser-only', tasks_requested: false }, signal);
    expect(invoke).toHaveBeenLastCalledWith('tr8-google', {
      body: { action: 'begin', request_id: 'calendar-request', expected_version: 5, browser_secret: 'browser-only' },
      signal,
      timeout: 60000,
    });
    invoke.mockResolvedValue({ data: tasksAuthorization, error: null });
    expect(await repository.beginGoogle({ request_id: 'retained-scope', expected_version: 5, browser_secret: 'browser-only' })).toEqual(tasksAuthorization);
    const unsafeUrl = new URL(url);
    unsafeUrl.searchParams.set('scope', `${url.searchParams.get('scope')} https://www.googleapis.com/auth/drive`);
    invoke.mockResolvedValue({ data: { ...authorization, authorization_url: unsafeUrl.href }, error: null });
    await expect(repository.beginGoogle({ request_id: 'unexpected-scope', expected_version: 5, browser_secret: 'browser-only' })).rejects.toMatchObject({
      code: 'CLIENT_UPGRADE_REQUIRED',
    });
  });
  it('consulta solo su propia conexión y elimina campos ajenos al contrato', async () => {
    const data = { ...googleFixture(), access_token: 'never reach application state', calendar_id: 'private' };
    const { repository, rpc, query } = repositoryFor(data);
    const signal = new AbortController().signal;
    expect(await repository.googleStatus(signal)).toEqual(googleFixture());
    expect(rpc).toHaveBeenCalledExactlyOnceWith('tr8_v2_get_google_status');
    expect(query.abortSignal).toHaveBeenCalledExactlyOnceWith(signal);
  });
  it('rechaza estados, motivos, contadores, fechas y versiones inesperados', () => {
    for (const value of [
      null,
      {},
      googleFixture({ configured: 'yes' as unknown as boolean }),
      googleFixture({ state: 'whatever' as never }),
      googleFixture({ reason: 'raw provider diagnostic' as never }),
      googleFixture({ pending: -1 }),
      googleFixture({ generation: 0.5 }),
      googleFixture({ version: Number.MAX_SAFE_INTEGER + 1 }),
      googleFixture({ last_sync_at: 'next week' }),
    ])
      expect(() => parseGoogleStatus(value)).toThrow('Actualiza TR8');
  });
  it('acepta exclusivamente Google con su state, los permisos previstos y PKCE S256', () => {
    const authorization = googleAuthorization();
    expect(parseGoogleAuthorization(authorization)).toEqual(authorization);
    for (const edit of [
      (url: URL) => {
        url.hostname = 'accounts.google.com.attacker.test';
      },
      (url: URL) => {
        url.protocol = 'http:';
      },
      (url: URL) => {
        url.pathname = '/elsewhere';
      },
      (url: URL) => {
        url.searchParams.set('state', 'other-state');
      },
      (url: URL) => {
        url.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar');
      },
      (url: URL) => {
        url.searchParams.set('code_challenge_method', 'plain');
      },
      (url: URL) => {
        url.username = 'hidden';
      },
    ]) {
      const url = new URL(authorization.authorization_url);
      edit(url);
      expect(() => parseGoogleAuthorization({ ...authorization, authorization_url: url.href })).toThrow('Actualiza TR8');
    }
  });
  it('envía las acciones con identidad implícita, versión, UUID y cancelación', async () => {
    const { repository, invoke } = repositoryFor(googleAuthorization());
    const signal = new AbortController().signal;
    await repository.beginGoogle({ request_id: 'request-a', expected_version: 3, browser_secret: 'browser-only' }, signal);
    expect(invoke).toHaveBeenLastCalledWith('tr8-google', {
      body: { action: 'begin', request_id: 'request-a', expected_version: 3, browser_secret: 'browser-only' },
      signal,
      timeout: 60000,
    });
    invoke.mockResolvedValue({ data: googleFixture({ state: 'connected', version: 4, generation: 1 }), error: null });
    await repository.completeGoogle({ state: 'flow-state', browser_secret: 'browser-only' }, signal);
    expect(invoke).toHaveBeenLastCalledWith('tr8-google', {
      body: { action: 'complete', state: 'flow-state', browser_secret: 'browser-only' },
      signal,
      timeout: 60000,
    });
    await repository.changeGoogle({ action: 'disconnect', request_id: 'request-b', expected_version: 4, mode: 'delete' }, signal);
    expect(invoke).toHaveBeenLastCalledWith('tr8-google', {
      body: { action: 'disconnect', request_id: 'request-b', expected_version: 4, mode: 'delete' },
      signal,
      timeout: 60000,
    });
  });
  it('muestra mensajes propios para errores HTTP sin filtrar mensajes ni secretos remotos', async () => {
    const error = new FunctionsHttpError(
      new Response(JSON.stringify({ error: { code: 'STALE_VERSION', message: 'secret raw provider diagnostic' } }), { status: 409 }),
    );
    const { repository } = repositoryFor(null, error);
    await expect(repository.changeGoogle({ action: 'reconcile', request_id: 'request', expected_version: 1 })).rejects.toMatchObject({
      code: 'STALE_VERSION',
      message: expect.stringContaining('otra pestaña'),
    });
    const raw = repositoryFor(null, new Error('access_token must never be printed'));
    await expect(raw.repository.beginGoogle({ request_id: 'request', expected_version: 1, browser_secret: 'secret' })).rejects.not.toThrow('access_token');
  });
  it('permite reiniciar un intento no disponible sin pedir un nuevo inicio de sesión', async () => {
    const error = new FunctionsHttpError(
      new Response(JSON.stringify({ error: { code: 'OPERATION_UNAVAILABLE', message: 'private attempt details' } }), { status: 404 }),
    );
    const { repository } = repositoryFor(null, error);
    await expect(repository.completeGoogle({ state: 'expired-state', browser_secret: 'browser-only' })).rejects.toMatchObject({
      code: 'OPERATION_UNAVAILABLE',
      message: 'El intento ya no está disponible. Actualiza el estado y vuelve a conectar Google.',
    });
  });
  it('combina el plazo del SDK con la cancelación inmediata de la sesión, sin reintentar', async () => {
    let started!: () => void;
    const requested = new Promise<void>(resolve => {
      started = resolve;
    });
    let transportSignal: AbortSignal | undefined;
    const fetchRequest = vi.fn().mockImplementation(
      (_url: unknown, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          transportSignal = options.signal ?? undefined;
          transportSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
          started();
        }),
    );
    const client = createClient('https://test.supabase.co', 'sb_publishable_fixture', {
      global: { fetch: fetchRequest },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const sessionController = new AbortController();
    const operation = createGoogleCalendarRepository(client).changeGoogle(
      { action: 'reconcile', request_id: 'request', expected_version: 1 },
      sessionController.signal,
    );
    const failure = expect(operation).rejects.toMatchObject({ code: 'GOOGLE_REQUEST_FAILED' });
    await requested;
    expect(transportSignal).toBeDefined();
    expect(transportSignal).not.toBe(sessionController.signal);
    sessionController.abort();
    expect(transportSignal?.aborted).toBe(true);
    await failure;
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });
});
