import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { StrictMode, type ComponentProps } from 'react';
import type { BulkTasksApi } from '../bulk-task-types';
import TasksView from './TasksView';
import { summaryMember, summaryProject, summaryTask } from './summary-test-fixtures';

const tasks = [
  { ...summaryTask, id: 'a', title: 'Preparar portada', version: 4 },
  { ...summaryTask, id: 'b', title: 'Revisar notas', version: 7, priority: 'high' as const, status: 'review' as const },
  { ...summaryTask, id: 'c', title: 'Publicar revista', version: 3 },
];
type Props = ComponentProps<typeof TasksView>;
function props(overrides: Partial<Props> = {}): Props {
  const apply = vi.fn<BulkTasksApi['apply']>(async (_operation, items, request) => ({
    request_id: request.id,
    results: items.map(row => ({ id: row.id, outcome: 'applied' as const, code: null })),
  }));
  return {
    scopeKey: 'user:space:tasks',
    tasks,
    projects: [summaryProject],
    members: [summaryMember],
    pending: false,
    onCreate: vi.fn(),
    onOpen: vi.fn(),
    onMove: vi.fn(),
    bulkTasks: { scopeKey: ['bulk', 'user', 'space', 'acl-1'], apply },
    canBulkTask: () => true,
    ...overrides,
  };
}
function tree(value: Props, entry = '/tasks') {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <TasksView {...value} />
    </MemoryRouter>
  );
}
function mount(value = props(), entry = '/tasks') {
  return render(tree(value, entry));
}
function select(title: string) {
  fireEvent.click(screen.getByRole('checkbox', { name: `Seleccionar ${title}` }));
}
function review() {
  fireEvent.click(screen.getByRole('button', { name: 'Revisar acción' }));
}
function confirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar acción' }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('bulk task interactions', () => {
  it('selects only filtered visible rows, exposes mixed selection, and clears selection on filter or view changes', () => {
    mount();
    select('Preparar portada');
    expect(screen.getByRole('checkbox', { name: 'Seleccionar tareas visibles' })).toBePartiallyChecked();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar tareas' }), { target: { value: 'notas' } });
    expect(screen.queryByRole('button', { name: 'Revisar acción' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar tareas visibles' }));
    review();
    const list = screen.getByRole('list', { name: 'Tareas del lote' });
    expect(within(list).getByText('Revisar notas')).toBeInTheDocument();
    expect(within(list).queryByText('Preparar portada')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tabla' }));
    expect(screen.queryByRole('button', { name: 'Revisar acción' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Seleccionar Revisar notas' })).not.toBeChecked();
  });

  it('limits a select-all operation to fifty rows without including disabled rows', () => {
    const many = Array.from({ length: 53 }, (_, index) => ({ ...tasks[0], id: `synthetic-${index}`, title: `Tarea ${index}`, position: index }));
    const value = props({ tasks: many, canBulkTask: task => task.id !== 'synthetic-0' });
    mount(value);
    expect(screen.getByRole('checkbox', { name: 'Seleccionar Tarea 0' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar tareas visibles' }));
    expect(screen.getByText('50 seleccionadas')).toBeInTheDocument();
    expect(screen.getByText(/primeras 50 tareas visibles/)).toBeInTheDocument();
    review();
    confirm();
    expect(value.bulkTasks!.apply).toHaveBeenCalledTimes(1);
    const [, items] = vi.mocked(value.bulkTasks!.apply).mock.calls[0];
    expect(items).toHaveLength(50);
    expect(items.some(row => row.id === 'synthetic-0')).toBe(false);
  });

  it('does not select collapsed groups and removes a selection when its group collapses', () => {
    mount();
    fireEvent.click(screen.getByText('Organizar', { exact: true }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Agrupar tareas por' }), { target: { value: 'status' } });
    const heading = screen.getByRole('button', { name: 'Por hacer: 2 tareas' });
    select('Preparar portada');
    fireEvent.click(heading);
    expect(screen.queryByRole('button', { name: 'Revisar acción' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar tareas visibles' }));
    review();
    expect(within(screen.getByRole('list', { name: 'Tareas del lote' })).getAllByRole('listitem')).toHaveLength(1);
    expect(within(screen.getByRole('list', { name: 'Tareas del lote' })).getByText('Revisar notas')).toBeInTheDocument();
  });

  it('respects assignment and deletion permissions independently from task editing', () => {
    const value = props({ canEditTask: () => false, canBulkTask: (_task, kind) => kind === 'assign' });
    mount(value);
    select('Preparar portada');
    expect(screen.getByRole('option', { name: 'Cambiar estado' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Eliminar tareas' })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Acción masiva' }), { target: { value: 'assign' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Nuevo responsable' }), { target: { value: summaryMember.id } });
    review();
    confirm();
    expect(value.bulkTasks!.apply).toHaveBeenCalledWith(
      { kind: 'assign', assignee_member_id: summaryMember.id },
      [{ id: 'a', project_id: summaryProject.id, version: 4 }],
      expect.objectContaining({ id: expect.any(String), requested_at: expect.any(String) }),
    );
  });

  it('requires the exact deletion phrase and confirms only the reviewed rows', async () => {
    const value = props();
    mount(value);
    select('Preparar portada');
    select('Revisar notas');
    fireEvent.change(screen.getByRole('combobox', { name: 'Acción masiva' }), { target: { value: 'delete' } });
    review();
    expect(screen.getByRole('button', { name: 'Confirmar acción' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Confirmación de eliminación masiva' }), { target: { value: 'ELIMINAR' } });
    expect(screen.getByRole('button', { name: 'Confirmar acción' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Confirmación de eliminación masiva' }), { target: { value: 'ELIMINAR 2' } });
    confirm();
    await screen.findByRole('dialog', { name: 'Resultado de la acción masiva' });
    const [operation, items] = vi.mocked(value.bulkTasks!.apply).mock.calls[0];
    expect(operation).toEqual({ kind: 'delete' });
    expect(items).toEqual([
      { id: 'a', project_id: summaryProject.id, version: 4 },
      { id: 'b', project_id: summaryProject.id, version: 7 },
    ]);
    expect(items.some(row => row.id === 'c')).toBe(false);
  });

  it('shows partial results per row and deselects successful tasks without retrying rejected ones automatically', async () => {
    const apply = vi.fn().mockResolvedValue({
      request_id: 'synthetic-request',
      results: [
        { id: 'a', outcome: 'applied', code: null },
        { id: 'b', outcome: 'rejected', code: 'PT409' },
      ],
    });
    mount(props({ bulkTasks: { scopeKey: ['bulk'], apply } }));
    select('Preparar portada');
    select('Revisar notas');
    review();
    confirm();
    const result = await screen.findByRole('dialog', { name: 'Resultado de la acción masiva' });
    expect(within(result).getByText('Aplicada')).toBeInTheDocument();
    expect(within(result).getByText(/Cambió en otra sesión/)).toBeInTheDocument();
    expect(within(result).getByRole('status')).toHaveTextContent('1 aplicadas · 1 no aplicadas');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar resultado' }));
    expect(screen.getByRole('checkbox', { name: 'Seleccionar Preparar portada' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Seleccionar Revisar notas' })).toBeChecked();
    expect(apply).toHaveBeenCalledOnce();
  });

  it('retains request, timestamp, payload and original versions after an ambiguous result, even if refreshed rows changed', async () => {
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Network failed'))
      .mockResolvedValue({ request_id: 'synthetic-request', results: [{ id: 'a', outcome: 'applied', code: null }] });
    const value = props({ bulkTasks: { scopeKey: ['bulk'], apply } });
    const view = mount(value);
    select('Preparar portada');
    review();
    confirm();
    await screen.findByRole('button', { name: 'Reintentar el mismo lote' });
    const first = apply.mock.calls[0];
    view.rerender(tree({ ...value, tasks: tasks.map(task => ({ ...task, version: task.version + 1 })) }));
    fireEvent.click(screen.getByRole('button', { name: 'Tabla' }));
    expect(screen.getByRole('table', { name: 'Lista de tareas' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar más tarde' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retomar comprobación' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar el mismo lote' }));
    await screen.findByRole('dialog', { name: 'Resultado de la acción masiva' });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1]).toEqual(first);
    expect(first[1][0].version).toBe(4);
  });

  it('invalidates unsent selections and review dialogs when a selected task version changes', async () => {
    const value = props();
    const view = mount(value);
    select('Preparar portada');
    review();
    view.rerender(tree({ ...value, tasks: [{ ...tasks[0], version: 5 }, tasks[1], tasks[2]] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText(/La selección cambió o se actualizó una tarea/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Seleccionar Preparar portada' })).not.toBeChecked();
    expect(value.bulkTasks!.apply).not.toHaveBeenCalled();
  });

  it('blocks a second submission and closing while the request is in progress', async () => {
    const request = deferred<Awaited<ReturnType<BulkTasksApi['apply']>>>();
    const apply = vi.fn(() => request.promise);
    mount(props({ bulkTasks: { scopeKey: ['bulk'], apply } }));
    select('Preparar portada');
    review();
    const button = screen.getByRole('button', { name: 'Confirmar acción' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(apply).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Cerrar ventana' })).toBeDisabled();
    await act(async () => request.resolve({ request_id: 'synthetic-request', results: [{ id: 'a', outcome: 'applied', code: null }] }));
    expect(screen.getByRole('dialog', { name: 'Resultado de la acción masiva' })).toBeInTheDocument();
  });

  it('keeps the batch result mounted when the last task disappears during the refresh before apply resolves', async () => {
    const request = deferred<Awaited<ReturnType<BulkTasksApi['apply']>>>();
    const apply = vi.fn(() => request.promise);
    const value = props({ tasks: [tasks[0]], bulkTasks: { scopeKey: ['bulk'], apply } });
    const view = mount(value);
    select('Preparar portada');
    fireEvent.change(screen.getByRole('combobox', { name: 'Acción masiva' }), { target: { value: 'archive' } });
    review();
    confirm();
    view.rerender(tree({ ...value, tasks: [] }));
    expect(screen.getByRole('dialog', { name: 'Archivar tareas' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Buscar tareas' })).toBeDisabled();
    await act(async () => request.resolve({ request_id: 'synthetic-request', results: [{ id: 'a', outcome: 'applied', code: null }] }));
    expect(screen.getByRole('dialog', { name: 'Resultado de la acción masiva' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar resultado' }));
    expect(screen.getByRole('searchbox', { name: 'Buscar tareas' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Tu siguiente paso empieza aquí' })).toBeInTheDocument();
  });

  it('requires a new review after request expiry instead of offering an endless retry', async () => {
    const apply = vi.fn().mockRejectedValue(Object.assign(new Error('Expired'), { code: 'PT410' }));
    mount(props({ bulkTasks: { scopeKey: ['bulk'], apply } }));
    select('Preparar portada');
    review();
    confirm();
    expect(await screen.findByRole('alert')).toHaveTextContent('Este lote caducó');
    expect(screen.getByRole('button', { name: 'Confirmar acción' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Reintentar el mismo lote' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    review();
    expect(screen.getByRole('button', { name: 'Confirmar acción' })).toBeEnabled();
  });

  it('treats the daily request limit as a confirmed rejection and unlocks the view after closing', async () => {
    const apply = vi.fn().mockRejectedValue(Object.assign(new Error('Rate limited'), { code: 'PT429' }));
    mount(props({ bulkTasks: { scopeKey: ['bulk'], apply } }));
    select('Preparar portada');
    review();
    confirm();
    expect(await screen.findByRole('alert')).toHaveTextContent('No se aplicó este lote');
    expect(screen.getByRole('button', { name: 'Confirmar acción' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Reintentar el mismo lote' })).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Buscar tareas' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retomar comprobación' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tabla' })).toBeEnabled();
    expect(apply).toHaveBeenCalledOnce();
  });

  it('supports keyboard selection in the table and withdraws the old selection on permission scope changes', async () => {
    const user = userEvent.setup();
    const value = props();
    const view = mount(value, '/tasks?view=table');
    const selection = screen.getByRole('checkbox', { name: 'Seleccionar Preparar portada' });
    selection.focus();
    await user.keyboard(' ');
    expect(selection).toBeChecked();
    view.rerender(tree({ ...value, scopeKey: 'user:space:acl-2', canBulkTask: () => false }));
    expect(screen.getByRole('checkbox', { name: 'Seleccionar Preparar portada' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Seleccionar Preparar portada' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Revisar acción' })).not.toBeInTheDocument();
  });

  it('offers no bulk selection in read-only mode or the board', () => {
    const value = props({ readOnly: true });
    const view = mount(value);
    expect(screen.queryByRole('checkbox', { name: 'Seleccionar tareas visibles' })).not.toBeInTheDocument();
    view.rerender(tree({ ...value, readOnly: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Tablero' }));
    expect(screen.queryByRole('checkbox', { name: 'Seleccionar tareas visibles' })).not.toBeInTheDocument();
  });

  it('keeps a single confirmed request and accepts its response after StrictMode effect replay', async () => {
    const value = props();
    render(<StrictMode>{tree(value)}</StrictMode>);
    select('Preparar portada');
    review();
    confirm();
    expect(await screen.findByRole('dialog', { name: 'Resultado de la acción masiva' })).toBeInTheDocument();
    expect(value.bulkTasks!.apply).toHaveBeenCalledOnce();
    expect(screen.getByRole('searchbox', { name: 'Buscar tareas' })).toBeEnabled();
  });
});
