import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectInput, Task, TaskInput } from '../types';
import { createRepository } from './repository';

const projectInput: ProjectInput = { name: '  Mi proyecto  ', description: '  Descripción  ', color: '#22aabb', status: 'active' };
const taskInput: TaskInput = {
  project_id: 'project-a',
  title: '  Mi tarea  ',
  description: '  Detalle  ',
  status: 'todo',
  priority: 'medium',
  start_date: null,
  due_date: null,
};

function rpcClient() {
  const rpc = vi.fn();
  return { rpc, repository: createRepository({ rpc } as unknown as SupabaseClient) };
}

type Response = { data: unknown; error: unknown };

function pagedClient(pages: Record<string, Response[]>) {
  const queries: { table: string; eq: ReturnType<typeof vi.fn>; range: ReturnType<typeof vi.fn>; abortSignal: ReturnType<typeof vi.fn> }[] = [];
  const from = vi.fn((table: string) => {
    const response = pages[table].shift();
    if (!response) throw new Error(`Petición inesperada a ${table}`);
    const promise = Promise.resolve(response);
    const query = {
      table,
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockReturnThis(),
      abortSignal: vi.fn().mockReturnThis(),
      then: promise.then.bind(promise),
    };
    queries.push(query);
    return query;
  });
  const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
  return { queries, rpc, repository: createRepository({ from, rpc } as unknown as SupabaseClient) };
}

describe('repositorio de proyectos y tareas', () => {
  it('exige el contrato v2 y conserva la denegación del servidor para cuentas sin habilitar', async () => {
    const { rpc, repository } = rpcClient();
    rpc
      .mockResolvedValueOnce({ data: { contract_version: 1 }, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Denied' } });
    await expect(repository.context()).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    await expect(repository.context()).rejects.toMatchObject({ code: '42501' });
    expect(rpc).toHaveBeenCalledWith('tr8_v2_get_context', {});
  });

  it('no permite un listado sin espacio seleccionado', async () => {
    const { rpc, repository } = rpcClient();
    await expect(repository.load('')).rejects.toThrow('Selecciona un espacio');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('carga proyectos y tareas más allá del límite de una página y permite cancelar cada petición', async () => {
    const firstPage = Array.from({ length: 250 }, (_, id) => ({ id: `project-${id}` }));
    const lastPage = [{ id: 'project-250' }];
    const tasks = [{ id: 'task-a' }];
    const { repository, queries } = pagedClient({
      tr8_workspace_projects: [
        { data: firstPage, error: null },
        { data: lastPage, error: null },
      ],
      tr8_workspace_tasks: [{ data: tasks, error: null }],
    });
    const controller = new AbortController();
    await expect(repository.load('workspace-a', controller.signal)).resolves.toEqual({ projects: [...firstPage, ...lastPage], tasks });
    const projectQueries = queries.filter(query => query.table === 'tr8_workspace_projects');
    expect(projectQueries[0].range).toHaveBeenCalledWith(0, 249);
    expect(projectQueries[1].range).toHaveBeenCalledWith(250, 499);
    expect(queries.every(query => query.eq.mock.calls[0][0] === 'workspace_id' && query.eq.mock.calls[0][1] === 'workspace-a')).toBe(true);
    expect(queries.every(query => query.abortSignal.mock.calls[0][0] === controller.signal)).toBe(true);
  });

  it('no devuelve un espacio parcialmente vacío si falla la consulta de tareas', async () => {
    const { repository } = pagedClient({
      tr8_workspace_projects: [{ data: [{ id: 'project-a' }], error: null }],
      tr8_workspace_tasks: [{ data: null, error: { message: 'Network connection failed' } }],
    });
    await expect(repository.load('workspace-a')).rejects.toThrow('problema de conexión');
  });

  it('reutiliza el identificador de creación tras un fallo de red sin modificar el formulario', async () => {
    const { rpc, repository } = rpcClient();
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } })
      .mockResolvedValueOnce({ data: { id: 'request-a', name: 'Mi proyecto' }, error: null });
    await expect(repository.createProject('workspace-a', projectInput, 'request-a')).rejects.toThrow('problema de conexión');
    await expect(repository.createProject('workspace-a', projectInput, 'request-a')).resolves.toMatchObject({ id: 'request-a' });
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(rpc).toHaveBeenLastCalledWith('tr8_v2_create_project', {
      p_workspace_id: 'workspace-a',
      p_id: 'request-a',
      p_name: 'Mi proyecto',
      p_description: 'Descripción',
      p_color: '#22aabb',
      p_status: 'active',
    });
    expect(projectInput.name).toBe('  Mi proyecto  ');
  });

  it.each([null, []])('no informa una creación correcta si el servidor no confirma el registro (%j)', async data => {
    const { rpc, repository } = rpcClient();
    rpc.mockResolvedValue({ data, error: null });
    await expect(repository.createTask('workspace-a', taskInput, 'request-a')).rejects.toThrow();
  });

  it('envía la versión leída para que la base detecte ediciones simultáneas', async () => {
    const { rpc, repository } = rpcClient();
    rpc.mockResolvedValue({ data: null, error: { code: 'PT409', message: 'Conflict' } });
    const current = { ...taskInput, workspace_id: 'workspace-a', id: 'task-a', version: 4 } as Task;
    await expect(repository.updateTask(current, { title: '  Nuevo título  ' })).rejects.toMatchObject({ code: 'PT409' });
    expect(rpc).toHaveBeenCalledWith('tr8_v2_update_task', { p_workspace_id: 'workspace-a', p_id: 'task-a', p_version: 4, p_patch: { title: 'Nuevo título' } });
    expect(current.title).toBe('  Mi tarea  ');
  });

  it('rechaza fechas invertidas y títulos vacíos antes de iniciar un guardado', () => {
    const { rpc, repository } = rpcClient();
    expect(() => repository.createTask('workspace-a', { ...taskInput, start_date: '2026-10-23', due_date: '2026-10-22' }, 'request-a')).toThrow(
      'fecha de vencimiento',
    );
    expect(() => repository.createProject('workspace-a', { ...projectInput, name: '  ' }, 'request-b')).toThrow('nombre');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('solo considera confirmado el borrado cuando la base no devuelve un error', async () => {
    const { rpc, repository } = rpcClient();
    const current = { ...taskInput, id: 'task-a', version: 4 } as Task;
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Forbidden' } }).mockResolvedValueOnce({ data: null, error: null });
    await expect(repository.deleteTask(current)).rejects.toMatchObject({ code: '42501' });
    await expect(repository.deleteTask(current)).resolves.toBeUndefined();
  });
});
