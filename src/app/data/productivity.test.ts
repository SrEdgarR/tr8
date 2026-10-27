import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { SavedTaskView, TaskViewConfig } from '../productivity-types';
import { createProductivityRepository, isTaskViewConfig } from './productivity';

const workspace = 'f9300000-0000-4000-8000-000000000001';
const project = 'f9301000-0000-4000-8000-000000000001';
const id = 'f9302000-0000-4000-8000-000000000001';
const config: TaskViewConfig = {
  schemaVersion: 1,
  view: 'table',
  query: '',
  statuses: [],
  priorities: [],
  projectIds: [],
  assigneeIds: ['none'],
  due: 'all',
  sort: 'manual',
  direction: 'asc',
  group: 'none',
  columns: ['status', 'priority', 'due_date'],
  favoritesOnly: false,
};
const saved: SavedTaskView = {
  id,
  workspace_id: workspace,
  context: 'project',
  project_id: project,
  name: 'Mi vista',
  config,
  version: 2,
  created_at: '2026-10-27T14:00:00Z',
  updated_at: '2026-10-27T14:00:00Z',
};
function setup() {
  const rpc = vi.fn();
  return { rpc, repository: createProductivityRepository({ rpc } as unknown as SupabaseClient, workspace) };
}

describe('contrato de productividad', () => {
  it('carga solamente el espacio enlazado y propaga abort signal', async () => {
    const { rpc, repository } = setup();
    const abortSignal = vi
      .fn()
      .mockResolvedValue({ data: { favorites: [{ kind: 'project', id: project, project_id: project }], views: [saved] }, error: null });
    rpc.mockReturnValue({ abortSignal });
    const controller = new AbortController();
    await expect(repository.load(controller.signal)).resolves.toMatchObject({ views: [saved] });
    expect(rpc).toHaveBeenCalledWith('tr8_v2_productivity', { p_workspace_id: workspace, p_action: 'load', p_input: {} });
    expect(abortSignal).toHaveBeenCalledWith(controller.signal);
  });

  it.each([
    { ...config, sql: 'select *' },
    { ...config, schemaVersion: 2 },
    { ...config, view: 'timeline' },
    { ...config, query: 'x'.repeat(501) },
    { ...config, statuses: ['done', 'done'] },
    { ...config, priorities: ['other'] },
    { ...config, columns: ['title'] },
    { ...config, columns: ['status', 'status'] },
    { ...config, assigneeIds: ['arbitrary'] },
    { ...config, projectIds: ['other'] },
    { ...config, favoritesOnly: 'false' },
    { ...config, direction: 'other' },
    { ...config, group: 'all' },
    { ...config, sort: 'assignee' },
    { ...config, due: 'next30' },
    { ...config, query: null },
  ])('rechaza configuración desconocida o no acotada %j', invalid => {
    expect(isTaskViewConfig(invalid)).toBe(false);
  });

  it('permite todos los valores de columnas/filtros y referencias opacas sin conceder acceso', () => {
    expect(
      isTaskViewConfig({
        ...config,
        projectIds: [project],
        assigneeIds: [id, 'none'],
        columns: ['project', 'status', 'priority', 'assignee', 'start_date', 'due_date'],
      }),
    ).toBe(true);
  });

  it('no transmite propietarios y usa set idempotente en lugar de toggle', async () => {
    const { rpc, repository } = setup();
    rpc.mockResolvedValue({ data: { kind: 'task', id, project_id: project, favorite: true }, error: null });
    await expect(repository.setFavorite('task', id, true)).resolves.toMatchObject({ favorite: true });
    expect(rpc).toHaveBeenLastCalledWith('tr8_v2_productivity', {
      p_workspace_id: workspace,
      p_action: 'set_favorite',
      p_input: { kind: 'task', id, favorite: true },
    });
  });

  it('rechaza confirmaciones ambiguas de favorito', async () => {
    const { rpc, repository } = setup();
    rpc.mockResolvedValue({ data: { kind: 'task', id: project, project_id: project, favorite: true }, error: null });
    await expect(repository.setFavorite('task', id, true)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('guarda el ID de creación y el contexto exactos y normaliza solo el nombre', async () => {
    const { rpc, repository } = setup();
    rpc.mockResolvedValue({ data: saved, error: null });
    await expect(repository.createView(id, ' Mi vista ', 'project', project, config)).resolves.toEqual(saved);
    expect(rpc).toHaveBeenLastCalledWith('tr8_v2_productivity', {
      p_workspace_id: workspace,
      p_action: 'create_view',
      p_input: { id, name: 'Mi vista', context: 'project', project_id: project, config },
    });
  });

  it('no envía una vista inválida ni un nombre vacío', async () => {
    const { rpc, repository } = setup();
    await expect(repository.createView(id, '', 'project', project, config)).rejects.toMatchObject({ code: '22023' });
    await expect(repository.createView(id, 'Vista', 'project', project, { ...config, schemaVersion: 9 } as unknown as TaskViewConfig)).rejects.toMatchObject({
      code: '22023',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rechaza vistas de otro espacio o contexto y versiones no avanzadas', async () => {
    const { rpc, repository } = setup();
    rpc
      .mockResolvedValueOnce({ data: { ...saved, workspace_id: project }, error: null })
      .mockResolvedValueOnce({ data: { ...saved, context: 'tasks', project_id: null }, error: null })
      .mockResolvedValueOnce({ data: saved, error: null });
    await expect(repository.createView(id, saved.name, 'project', project, config)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    await expect(repository.updateView(saved, saved.name, config)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    await expect(repository.updateView(saved, saved.name, config)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('actualiza con CAS y exige confirmación del ID eliminado', async () => {
    const { rpc, repository } = setup();
    rpc
      .mockResolvedValueOnce({ data: { ...saved, version: 3 }, error: null })
      .mockResolvedValueOnce({ data: { id: project, deleted: true }, error: null })
      .mockResolvedValueOnce({ data: { id, deleted: true }, error: null });
    await expect(repository.updateView(saved, 'Mi vista', config)).resolves.toMatchObject({ version: 3 });
    expect(rpc).toHaveBeenLastCalledWith('tr8_v2_productivity', {
      p_workspace_id: workspace,
      p_action: 'update_view',
      p_input: { id, version: 2, name: 'Mi vista', config },
    });
    await expect(repository.deleteView(saved)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    await expect(repository.deleteView(saved)).resolves.toBeUndefined();
  });

  it.each([
    null,
    { favorites: [], views: [{ ...saved, version: 0 }] },
    { favorites: [], views: [{ ...saved, workspace_id: project }] },
    { favorites: [{ kind: 'task', id: 'bad', project_id: project }], views: [] },
    [],
  ])('no admite respuestas parciales/malformadas %j', async data => {
    const { rpc, repository } = setup();
    rpc.mockResolvedValue({ data, error: null });
    await expect(repository.load()).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('propaga conflictos y revocación sin convertirlos en listas vacías', async () => {
    const { rpc, repository } = setup();
    rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'PT409', message: 'Conflict' } })
      .mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Revoked' } });
    await expect(repository.updateView(saved, saved.name, config)).rejects.toMatchObject({ code: 'PT409' });
    await expect(repository.load()).rejects.toMatchObject({ code: '42501' });
  });

  it('rechaza órdenes parciales inválidos en el cliente y transmite versiones/petición', async () => {
    const { rpc, repository } = setup();
    const items = [{ id, version: 1, position: 1000 }];
    await expect(repository.reorderTasks(project, [items[0], items[0]], id)).rejects.toMatchObject({ code: '22023' });
    await expect(repository.reorderTasks(project, [{ ...items[0], position: 1.5 }], id)).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: [{ id, workspace_id: workspace, project_id: project, version: 2, position: 1000 }], error: null });
    await expect(repository.reorderTasks(project, items, id)).resolves.toMatchObject([{ id, version: 2 }]);
    expect(rpc).toHaveBeenLastCalledWith('tr8_v2_productivity', {
      p_workspace_id: workspace,
      p_action: 'reorder_tasks',
      p_input: { project_id: project, request_id: id, items },
    });
  });
});
