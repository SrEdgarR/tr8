import { FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { createGoogleTasksRepository, parseGoogleTasksStatus, type GoogleTasksChange, type GoogleTasksStatus } from './google-tasks';

function fixture(change: Partial<GoogleTasksStatus> = {}): GoogleTasksStatus {
  return {
    configured: true,
    enabled: true,
    state: 'connected',
    version: 3,
    last_sync_at: null,
    next_sync_at: null,
    pending: 0,
    failed: 0,
    conflicts: 0,
    reason: null,
    lists: [{ id: 'google-list', title: 'Mis tareas', selected: true }],
    conflict_items: [],
    ...change,
  };
}
function repositoryFor(data: unknown, error: unknown = null) {
  const query = Object.assign(Promise.resolve({ data, error }), { abortSignal: vi.fn().mockReturnThis() });
  const rpc = vi.fn().mockReturnValue(query);
  const invoke = vi.fn().mockResolvedValue({ data, error });
  return { rpc, invoke, query, repository: createGoogleTasksRepository({ rpc, functions: { invoke } } as unknown as SupabaseClient) };
}

describe('Contrato personal de Google Tasks', () => {
  it('consulta la conexión personal sin parámetros de usuario o equipo y descarta campos privados', async () => {
    const { repository, rpc, query } = repositoryFor({ ...fixture(), credential_envelope: 'private', user_id: 'not retained' });
    const signal = new AbortController().signal;
    expect(await repository.googleTasksStatus(signal)).toEqual(fixture());
    expect(rpc).toHaveBeenCalledExactlyOnceWith('tr8_v6_get_google_tasks_status');
    expect(query.abortSignal).toHaveBeenCalledExactlyOnceWith(signal);
  });

  it('retiene solo títulos, selección y los datos mínimos de conflictos', () => {
    expect(
      parseGoogleTasksStatus({
        ...fixture(),
        lists: [{ id: 'list', title: 'Lista', selected: false, private: 'ignored' }],
        conflict_items: [{ id: 'link', title: 'TR8', google_title: null, reason: 'remote_deleted', token: 'ignored' }],
      }),
    ).toEqual(
      fixture({
        lists: [{ id: 'list', title: 'Lista', selected: false }],
        conflict_items: [{ id: 'link', title: 'TR8', google_title: null, reason: 'remote_deleted' }],
      }),
    );
  });

  it('acepta el servidor anterior sin habilitar ni inventar la exportación de tareas nuevas', () => {
    const status = parseGoogleTasksStatus(fixture());
    expect(status).not.toHaveProperty('outbound');
    expect(parseGoogleTasksStatus({ ...fixture(), outbound: undefined })).not.toHaveProperty('outbound');
  });

  it('retiene solo la configuración pública de exportación y la incertidumbre de creación', () => {
    const outbound = { enabled: true, list_id: 'google-list', enabled_at: '2026-10-23T12:00:00Z', uncertain: 2 };
    expect(parseGoogleTasksStatus({ ...fixture(), outbound: { ...outbound, marker: 'private', credential_envelope: 'private' } })).toEqual(
      fixture({ outbound }),
    );
  });

  it.each([
    null,
    { enabled: 'yes', list_id: 'list', enabled_at: null, uncertain: 0 },
    { enabled: true, list_id: null, enabled_at: null, uncertain: 0 },
    { enabled: false, list_id: '', enabled_at: null, uncertain: 0 },
    { enabled: false, list_id: null, enabled_at: 'tomorrow', uncertain: 0 },
    { enabled: false, list_id: null, enabled_at: null, uncertain: -1 },
    { enabled: false, list_id: null, enabled_at: null, uncertain: 0.5 },
  ])('rechaza configuración de exportación incompatible sin asumir un destino %j', outbound => {
    expect(() => parseGoogleTasksStatus({ ...fixture(), outbound })).toThrow('Actualiza TR8');
  });

  it('conserva las 2000 listas permitidas por Google, incluidas todas las seleccionadas al final de la colección', () => {
    const lists = Array.from({ length: 2000 }, (_, id) => ({ id: `list-${id}`, title: `Lista ${id}`, selected: id >= 100 }));
    const status = parseGoogleTasksStatus(fixture({ lists }));
    expect(status.lists).toEqual(lists);
    expect(status.lists.filter(list => list.selected)).toHaveLength(1900);
    expect(status.lists.at(-1)).toEqual({ id: 'list-1999', title: 'Lista 1999', selected: true });
  });

  it.each([
    { configured: 'yes' },
    { enabled: null },
    { state: 'provisioning' },
    { version: -1 },
    { pending: 0.5 },
    { failed: Number.MAX_SAFE_INTEGER + 1 },
    { conflicts: -1 },
    { reason: 'provider token diagnostic' },
    { last_sync_at: 'tomorrow' },
    { next_sync_at: undefined },
    { lists: [{ id: '', title: 'Lista', selected: true }] },
    { lists: [{ id: 'list', title: 'Lista', selected: 'yes' }] },
    {
      lists: [
        { id: 'same', title: 'Lista', selected: true },
        { id: 'same', title: 'Otra', selected: false },
      ],
    },
    { conflict_items: [{ id: 'link', title: 'Tarea', google_title: 42, reason: 'conflict' }] },
    { conflict_items: [{ id: 'link', title: 'Tarea', google_title: 'Otra', reason: 'raw diagnostic' }] },
    {
      conflict_items: [
        { id: 'link', title: 'Tarea', google_title: 'Otra', reason: 'conflict' },
        { id: 'link', title: 'Tarea', google_title: 'Otra', reason: 'conflict' },
      ],
    },
  ])('rechaza respuestas incompatibles o ilimitadas %j', change => {
    expect(() => parseGoogleTasksStatus({ ...fixture(), ...change })).toThrow('Actualiza TR8');
  });

  it('rechaza una respuesta por encima de 2000 listas sin truncar silenciosamente las listas elegidas', () => {
    const lists = Array.from({ length: 2001 }, (_, id) => ({ id: `list-${id}`, title: 'Lista', selected: id === 2000 }));
    expect(() => parseGoogleTasksStatus(fixture({ lists }))).toThrow('Actualiza TR8');
  });

  it.each<GoogleTasksChange>([
    { action: 'tasks_reconcile', request_id: 'request', expected_version: 3 },
    { action: 'tasks_pause', request_id: 'request', expected_version: 3 },
    { action: 'tasks_resume', request_id: 'request', expected_version: 3 },
    { action: 'tasks_select_list', request_id: 'request', expected_version: 3, list_id: 'list', selected: true },
    { action: 'tasks_configure_export', request_id: 'request', expected_version: 3, export_enabled: true, export_list_id: 'list' },
    { action: 'tasks_configure_export', request_id: 'request', expected_version: 3, export_enabled: false, export_list_id: null },
    { action: 'tasks_resolve', request_id: 'request', expected_version: 3, link_id: 'link', resolution: 'local' },
    { action: 'tasks_resolve', request_id: 'request', expected_version: 3, link_id: 'link', resolution: 'google' },
  ])('envía solo los campos autorizados de $action, con versión y cancelación', async input => {
    const { repository, invoke } = repositoryFor(fixture());
    const signal = new AbortController().signal;
    await repository.changeGoogleTasks(
      { ...input, user_id: 'ignored', workspace_id: 'ignored', credential: 'ignored' } as unknown as GoogleTasksChange,
      signal,
    );
    expect(invoke).toHaveBeenCalledExactlyOnceWith('tr8-google', { body: input, signal, timeout: 60000 });
  });

  it('sanitiza errores HTTP conocidos y nunca imprime diagnósticos externos', async () => {
    const error = new FunctionsHttpError(
      new Response(JSON.stringify({ error: { code: 'STALE_VERSION', message: 'private credential diagnostic' } }), { status: 409 }),
    );
    await expect(
      repositoryFor(null, error).repository.changeGoogleTasks({ action: 'tasks_reconcile', request_id: 'request', expected_version: 3 }),
    ).rejects.toMatchObject({
      code: 'STALE_VERSION',
      message: expect.stringContaining('otra pestaña'),
    });
    const raw = new FunctionsHttpError(new Response(JSON.stringify({ error: { code: 'UNKNOWN', message: 'secret refresh token' } }), { status: 500 }));
    await expect(
      repositoryFor(null, raw).repository.changeGoogleTasks({ action: 'tasks_pause', request_id: 'request', expected_version: 3 }),
    ).rejects.toMatchObject({
      code: 'GOOGLE_TASKS_REQUEST_FAILED',
      message: expect.not.stringContaining('secret'),
    });
  });

  it('oculta detalles de errores RPC y no intenta ejecutar una mutación para corregirlos', async () => {
    const { repository, invoke } = repositoryFor(null, { code: '42501', message: 'private row' });
    await expect(repository.googleTasksStatus()).rejects.toMatchObject({ message: expect.stringContaining('no tiene permiso') });
    expect(invoke).not.toHaveBeenCalled();
  });
});
