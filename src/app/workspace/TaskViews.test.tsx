import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { SavedTaskView } from '../productivity-types';
import TasksView from './TasksView';
import { defaultTaskView } from './task-views';
import { summaryMember, summaryProject, summaryTask } from './summary-test-fixtures';

const tasks = [
  { ...summaryTask, id: 'a', title: 'Preparar portada', position: 100 },
  { ...summaryTask, id: 'b', title: 'Revisar notas', priority: 'high' as const, status: 'review' as const, position: 200 },
  { ...summaryTask, id: 'c', title: 'Publicar revista', assignee_member_id: null, position: 300 },
];
function props(overrides: Partial<ComponentProps<typeof TasksView>> = {}): ComponentProps<typeof TasksView> {
  return {
    scopeKey: 'user:workspace:tasks',
    tasks,
    projects: [summaryProject],
    members: [summaryMember],
    pending: false,
    onCreate: vi.fn(),
    onOpen: vi.fn(),
    onMove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
function mount(value = props(), entry = '/tasks?workspace=team-summary-a') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TasksView {...value} />
    </MemoryRouter>,
  );
}
function saved(config = defaultTaskView()): SavedTaskView {
  return {
    id: 'saved-view-a',
    workspace_id: summaryProject.workspace_id,
    context: 'tasks',
    project_id: null,
    name: 'Revisión semanal',
    config,
    version: 3,
    created_at: summaryProject.created_at,
    updated_at: summaryProject.updated_at,
  };
}

describe('productive task views', () => {
  it('opens the table and edits a title using the original version while keeping failed drafts for retry', async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn().mockRejectedValueOnce(new Error('La tarea cambió en otro dispositivo')).mockResolvedValue(undefined);
    mount(props({ onPatch }));
    await user.click(screen.getByRole('button', { name: 'Tabla' }));
    const title = screen.getByRole('textbox', { name: 'Título de Preparar portada' });
    await user.clear(title);
    await user.type(title, 'Portada corregida{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('La tarea cambió en otro dispositivo');
    expect(title).toHaveValue('Portada corregida');
    expect(onPatch).toHaveBeenNthCalledWith(1, tasks[0], { title: 'Portada corregida' });
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(2));
  });
  it('cancels inline input with Escape without sending the draft on blur', async () => {
    const user = userEvent.setup();
    const onPatch = vi.fn().mockResolvedValue(undefined);
    mount(props({ onPatch }), '/tasks?view=table');
    const title = screen.getByRole('textbox', { name: 'Título de Preparar portada' });
    await user.clear(title);
    await user.type(title, 'No guardar{Escape}');
    expect(title).toHaveValue('Preparar portada');
    expect(onPatch).not.toHaveBeenCalled();
  });
  it('does not save or discard an inline title while an IME is composing', async () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    mount(props({ onPatch }), '/tasks?view=table');
    const title = screen.getByRole('textbox', { name: 'Título de Preparar portada' });
    title.focus();
    fireEvent.change(title, { target: { value: 'Planificación 東京' } });
    fireEvent.keyDown(title, { key: 'Enter', isComposing: true });
    expect(onPatch).not.toHaveBeenCalled();
    fireEvent.keyDown(title, { key: 'Escape', isComposing: true });
    expect(title).toHaveFocus();
    expect(title).toHaveValue('Planificación 東京');
    fireEvent.keyDown(title, { key: 'Enter' });
    await waitFor(() => expect(onPatch).toHaveBeenCalledOnce());
    expect(onPatch).toHaveBeenCalledWith(tasks[0], { title: 'Planificación 東京' });
  });
  it('configures columns and keeps the title present', async () => {
    const user = userEvent.setup();
    mount(props(), '/tasks?view=table');
    await user.click(screen.getByText('Columnas', { exact: true }));
    const menu = screen.getByText('El título siempre está visible.').parentElement!;
    await user.click(within(menu).getByRole('checkbox', { name: 'Responsable' }));
    expect(screen.queryByRole('columnheader', { name: 'Responsable' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Tarea' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Tabla de tareas' })).toBeInTheDocument();
  });
  it('combines multiple status filters with an assignee filter and clears all filters', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByText('Filtros', { exact: true }));
    await user.click(screen.getByRole('checkbox', { name: 'Por hacer' }));
    await user.click(screen.getByRole('checkbox', { name: 'En revisión' }));
    await user.click(screen.getByRole('checkbox', { name: summaryMember.display_name }));
    expect(screen.getByRole('button', { name: 'Preparar portada' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revisar notas' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publicar revista' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    expect(screen.getByRole('button', { name: 'Publicar revista' })).toBeInTheDocument();
  });
  it('groups tasks with collapsible headings and withdraws removed member names', async () => {
    const user = userEvent.setup();
    const value = props();
    const { rerender } = mount(value);
    await user.click(screen.getByText('Organizar', { exact: true }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agrupar tareas por' }), 'assignee');
    const group = screen.getByRole('region', { name: summaryMember.display_name });
    await user.click(within(group).getByRole('button', { name: `${summaryMember.display_name}: 2 tareas` }));
    expect(within(group).queryByRole('button', { name: 'Preparar portada' })).not.toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <TasksView {...value} members={[]} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('region', { name: summaryMember.display_name })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Responsable no disponible' })).toBeInTheDocument();
  });
  it('applies a saved table view and sends save with its complete closed configuration', async () => {
    const user = userEvent.setup();
    const view = saved({ ...defaultTaskView(), view: 'table', statuses: ['review'], columns: ['status', 'priority'], sort: 'title' });
    const onCreateView = vi.fn().mockResolvedValue({ ...view, id: 'new-view' });
    mount(props({ savedViews: [view], onCreateView }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Vistas guardadas' }), view.id);
    expect(screen.getByRole('table', { name: 'Tabla de tareas' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Abrir Preparar portada' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Guardar vista' }));
    const dialog = screen.getByRole('dialog', { name: 'Guardar vista' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Nombre de la vista' }), 'Mi revisión');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar vista' }));
    await waitFor(() => expect(onCreateView).toHaveBeenCalledWith('Mi revisión', view.config, expect.stringMatching(/^[0-9a-f-]{36}$/)));
  });
  it('retains a saved-view name when persistence fails and deletes only the selected view after confirmation', async () => {
    const user = userEvent.setup();
    const view = saved();
    const onCreateView = vi.fn().mockRejectedValue(new Error('Sin conexión'));
    const onDeleteView = vi.fn().mockResolvedValue(undefined);
    mount(props({ savedViews: [view], onCreateView, onDeleteView }));
    await user.click(screen.getByRole('button', { name: 'Guardar vista' }));
    let dialog = screen.getByRole('dialog', { name: 'Guardar vista' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Nombre de la vista' }), 'Pendientes');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar vista' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Sin conexión');
    expect(within(dialog).getByRole('textbox', { name: 'Nombre de la vista' })).toHaveValue('Pendientes');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Vistas guardadas' }), view.id);
    await user.click(screen.getByRole('button', { name: `Eliminar vista ${view.name}` }));
    dialog = screen.getByRole('dialog', { name: 'Eliminar vista guardada' });
    expect(onDeleteView).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar vista' }));
    await waitFor(() => expect(onDeleteView).toHaveBeenCalledWith(view));
  });

  it('reuses one creation identity after an ambiguous response, including intervening rerenders', async () => {
    const user = userEvent.setup();
    const persisted = saved();
    const onCreateView = vi.fn().mockRejectedValueOnce(new Error('La respuesta se perdió')).mockResolvedValue(persisted);
    const value = props({ onCreateView });
    const { rerender } = mount(value);
    await user.click(screen.getByRole('button', { name: 'Guardar vista' }));
    let dialog = screen.getByRole('dialog', { name: 'Guardar vista' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Nombre de la vista' }), 'Reintento seguro');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar vista' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('La respuesta se perdió');
    const firstId = onCreateView.mock.calls[0][2];
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
    rerender(
      <MemoryRouter>
        <TasksView {...value} savedViews={[persisted]} />
      </MemoryRouter>,
    );
    dialog = screen.getByRole('dialog', { name: 'Guardar vista' });
    expect(within(dialog).getByRole('textbox', { name: 'Nombre de la vista' })).toHaveValue('Reintento seguro');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar vista' }));
    await waitFor(() => expect(onCreateView).toHaveBeenCalledTimes(2));
    expect(onCreateView.mock.calls[1]).toEqual(['Reintento seguro', defaultTaskView(), firstId]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Guardar vista' }));
    dialog = screen.getByRole('dialog', { name: 'Guardar vista' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Nombre de la vista' }), 'Otra vista');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar vista' }));
    await waitFor(() => expect(onCreateView).toHaveBeenCalledTimes(3));
    expect(onCreateView.mock.calls[2][2]).not.toBe(firstId);
  });

  it('retains the creation identity when a changed draft conflicts with an ambiguous prior save', async () => {
    const user = userEvent.setup();
    const onCreateView = vi
      .fn()
      .mockRejectedValueOnce(new Error('Resultado incierto'))
      .mockRejectedValueOnce(new Error('La solicitud ya guardó otro contenido. Actualiza las vistas.'));
    mount(props({ onCreateView }));
    await user.click(screen.getByRole('button', { name: 'Guardar vista' }));
    const dialog = screen.getByRole('dialog', { name: 'Guardar vista' });
    const name = within(dialog).getByRole('textbox', { name: 'Nombre de la vista' });
    await user.type(name, 'Original');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar vista' }));
    await within(dialog).findByRole('alert');
    await user.clear(name);
    await user.type(name, 'Borrador cambiado');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar vista' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('ya guardó otro contenido');
    expect(name).toHaveValue('Borrador cambiado');
    expect(onCreateView.mock.calls[0][2]).toBe(onCreateView.mock.calls[1][2]);
  });
  it('allows personal favorites on readonly content but keeps task edits and reorder disabled', async () => {
    const user = userEvent.setup();
    const onFavoriteTask = vi.fn().mockResolvedValue(undefined);
    const onPatch = vi.fn();
    const onReorder = vi.fn();
    mount(props({ readOnly: true, onFavoriteTask, onPatch, onReorder }), '/tasks?view=table');
    expect(screen.getByRole('textbox', { name: 'Título de Preparar portada' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Completar Preparar portada' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Subir Preparar portada' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Marcar favorita Preparar portada' }));
    await waitFor(() => expect(onFavoriteTask).toHaveBeenCalledWith(tasks[0], true));
    expect(onPatch).not.toHaveBeenCalled();
    expect(onReorder).not.toHaveBeenCalled();
  });
  it('reorders one project atomically with keyboard controls and excludes other projects', async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn().mockResolvedValue(undefined);
    const otherProject = { ...summaryProject, id: 'other-project' };
    const otherTask = { ...tasks[0], id: 'other-task', project_id: otherProject.id, title: 'Otra tarea' };
    mount(props({ tasks: [...tasks, otherTask], projects: [summaryProject, otherProject], onReorder }));
    await user.click(screen.getByRole('button', { name: 'Bajar Preparar portada' }));
    await waitFor(() => expect(onReorder).toHaveBeenCalledWith([tasks[1], tasks[0], tasks[2]]));
  });
  it('clears query, view selection and drafts when the authorized scope changes', async () => {
    const user = userEvent.setup();
    const value = props();
    const { rerender } = mount(value);
    await user.type(screen.getByRole('searchbox', { name: 'Buscar tareas' }), 'portada');
    expect(screen.queryByRole('button', { name: 'Revisar notas' })).not.toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <TasksView {...value} scopeKey="other-user:other-workspace:tasks" tasks={[{ ...tasks[1], title: 'Nuevo espacio' }]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('searchbox', { name: 'Buscar tareas' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Nuevo espacio' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preparar portada' })).not.toBeInTheDocument();
  });
  it('reports priority update errors without an unhandled rejection', async () => {
    const onPatch = vi.fn().mockRejectedValue(new Error('Conflicto de versión'));
    mount(props({ onPatch }), '/tasks?view=table');
    fireEvent.change(screen.getByRole('combobox', { name: 'Prioridad de Preparar portada' }), { target: { value: 'low' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Conflicto de versión');
  });
});
