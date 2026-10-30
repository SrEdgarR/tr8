import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Task, TaskSubtask } from '../types';
import type { WorkManagementApi } from '../work-management-types';
import TaskDetail, { type TaskDetailProps } from './TaskDetail';
import { summaryProject, summaryTask } from './summary-test-fixtures';

const secondProject = { ...summaryProject, id: 'second-project', name: 'Segundo proyecto', code: 'P2' };
const task: Task = {
  ...summaryTask,
  title: 'Preparar lanzamiento',
  description: '<script>no se ejecuta</script>',
  labels: ['Diseño'],
  estimate_minutes: 30,
  subtasks: [{ id: 'check-1', title: 'Revisar portada', done: false }],
  archived_at: null,
};

function api() {
  return {
    scopeKey: ['work-management', task.workspace_id],
    updateTaskDetails: vi
      .fn()
      .mockImplementation(async (before: Task, input: { labels: string[]; estimate_minutes: number | null; subtasks: TaskSubtask[] }) => ({
        ...before,
        ...input,
        version: before.version + 1,
      })),
    duplicateTask: vi.fn().mockImplementation(async (before: Task, projectId: string) => ({
      ...before,
      id: 'duplicate-task',
      project_id: projectId,
      title: `${before.title} (copia)`,
      version: 1,
    })),
    moveTask: vi.fn().mockImplementation(async (before: Task, projectId: string, _requestId: string, clearAssignee: boolean) => ({
      ...before,
      project_id: projectId,
      assignee_member_id: clearAssignee ? null : before.assignee_member_id,
      version: before.version + 1,
    })),
    archiveTask: vi.fn().mockImplementation(async (before: Task, archived: boolean) => ({
      ...before,
      archived_at: archived ? '2026-10-28T10:00:00Z' : null,
      version: before.version + 1,
    })),
  } as unknown as WorkManagementApi;
}
function props(overrides: Partial<TaskDetailProps> = {}): TaskDetailProps {
  return {
    task,
    projects: [summaryProject, secondProject],
    pending: false,
    canCreateInProject: () => true,
    canAssign: true,
    canDelete: true,
    api: api(),
    assigneeName: 'Persona principal',
    onUpdate: vi.fn().mockImplementation(async (before: Task, patch: Partial<Task>) => ({ ...before, ...patch, version: before.version + 1 })),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    onTaskSaved: vi.fn(),
    onTaskMoved: vi.fn(),
    ...overrides,
  };
}

describe('task detail and guarded task actions', () => {
  it('opens secondary presentation actions without changing the task and returns focus on Escape', async () => {
    const value = props();
    render(<TaskDetail {...value} />);
    const toggle = screen.getByRole('button', { name: 'Más acciones' });
    const group = screen.getByRole('group', { name: 'Más acciones de tarea' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', group.id);
    await userEvent.click(toggle);
    expect(group).toHaveClass('is-open');
    screen.getByRole('button', { name: 'Duplicar' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(group).not.toHaveClass('is-open');
    expect(toggle).toHaveFocus();
    expect(value.api!.duplicateTask).not.toHaveBeenCalled();
    expect(value.onDelete).not.toHaveBeenCalled();
    expect(value.onUpdate).not.toHaveBeenCalled();
  });
  it('shows task identity, safe description, actual metadata and authorized assignee name', () => {
    render(<TaskDetail {...props()} />);
    expect(screen.getByRole('dialog', { name: 'Detalle de tarea' })).toHaveClass('td-drawer');
    expect(screen.getByText(task.description)).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('Diseño')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Título de subtarea 1' })).toHaveValue('Revisar portada');
    expect(screen.getByRole('spinbutton', { name: 'Estimación en minutos' })).toHaveValue(30);
    expect(screen.getByText('Persona principal')).toBeInTheDocument();
  });

  it('saves labels, estimation and subtasks together with the opening version', async () => {
    const user = userEvent.setup();
    const value = props();
    render(<TaskDetail {...value} />);
    await user.type(screen.getByRole('textbox', { name: 'Nueva etiqueta' }), 'Urgente{Enter}');
    await user.clear(screen.getByRole('spinbutton', { name: 'Estimación en minutos' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Estimación en minutos' }), '90');
    await user.click(screen.getByRole('checkbox', { name: 'Completar subtarea Revisar portada' }));
    await user.type(screen.getByRole('textbox', { name: 'Nueva subtarea' }), 'Publicar anuncio{Enter}');
    await user.click(screen.getByRole('button', { name: 'Guardar detalle' }));
    await waitFor(() =>
      expect(value.api!.updateTaskDetails).toHaveBeenCalledWith(task, {
        labels: ['Diseño', 'Urgente'],
        estimate_minutes: 90,
        subtasks: [
          { id: 'check-1', title: 'Revisar portada', done: true },
          { id: expect.any(String), title: 'Publicar anuncio', done: false },
        ],
      }),
    );
    expect(value.onTaskSaved).toHaveBeenCalledWith(expect.objectContaining({ version: task.version + 1, estimate_minutes: 90 }));
    expect(await screen.findByRole('status')).toHaveTextContent('Detalle guardado.');
  });

  it('keeps a failed draft and original version when another device updates the task', async () => {
    const user = userEvent.setup();
    const value = props();
    vi.mocked(value.api!.updateTaskDetails).mockRejectedValue(new Error('La versión ya cambió. Actualiza la tarea.'));
    const view = render(<TaskDetail {...value} />);
    await user.type(screen.getByRole('textbox', { name: 'Nueva etiqueta' }), 'Borrador{Enter}');
    view.rerender(<TaskDetail {...value} task={{ ...task, version: task.version + 1, labels: ['Otra versión'] }} />);
    expect(screen.getByText(/Tu borrador sigue aquí/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Guardar detalle' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La versión ya cambió');
    expect(screen.getByText('Borrador')).toBeInTheDocument();
    expect(value.api!.updateTaskDetails).toHaveBeenCalledWith(task, expect.objectContaining({ labels: ['Diseño', 'Borrador'] }));
    await user.click(screen.getByRole('button', { name: 'Cargar detalle actual' }));
    expect(screen.queryByText('Borrador')).not.toBeInTheDocument();
    expect(screen.getByText('Otra versión')).toBeInTheDocument();
  });

  it('does not silently duplicate labels and rejects a blank subtask before contacting the server', async () => {
    const user = userEvent.setup();
    const value = props();
    render(<TaskDetail {...value} />);
    await user.type(screen.getByRole('textbox', { name: 'Nueva etiqueta' }), 'diseño{Enter}');
    expect(screen.getAllByText('Diseño')).toHaveLength(1);
    await user.clear(screen.getByRole('textbox', { name: 'Título de subtarea 1' }));
    await user.click(screen.getByRole('button', { name: 'Guardar detalle' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Cada subtarea necesita un título');
    expect(value.api!.updateTaskDetails).not.toHaveBeenCalled();
  });

  it('reuses a duplicate request identity after an ambiguous response and keeps the source intact', async () => {
    const user = userEvent.setup();
    const value = props();
    vi.mocked(value.api!.duplicateTask).mockRejectedValueOnce(new Error('No se pudo confirmar el resultado.'));
    render(<TaskDetail {...value} />);
    await user.click(screen.getByRole('button', { name: 'Duplicar' }));
    const dialog = screen.getByRole('dialog', { name: 'Duplicar tarea' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Proyecto de destino' }), secondProject.id);
    await user.click(within(dialog).getByRole('button', { name: 'Duplicar tarea' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo confirmar');
    await user.click(within(dialog).getByRole('button', { name: 'Duplicar tarea' }));
    await waitFor(() => expect(value.api!.duplicateTask).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(value.api!.duplicateTask).mock.calls;
    expect(calls[0]).toEqual([task, secondProject.id, expect.any(String)]);
    expect(calls[1]).toEqual(calls[0]);
    expect(await screen.findByRole('dialog', { name: 'Detalle de tarea' })).toHaveTextContent(task.title);
    expect(value.onDelete).not.toHaveBeenCalled();
    expect(value.onTaskSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'duplicate-task' }));
  });

  it('moves the existing identity to an authorized project with explicit assignee removal', async () => {
    const user = userEvent.setup();
    const value = props();
    render(<TaskDetail {...value} />);
    await user.click(screen.getByRole('button', { name: 'Mover' }));
    const dialog = screen.getByRole('dialog', { name: 'Mover tarea' });
    expect(within(dialog).getByText(/conservará su identidad/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Mover sin responsable' }));
    await user.click(within(dialog).getByRole('button', { name: 'Mover tarea' }));
    await waitFor(() => expect(value.api!.moveTask).toHaveBeenCalledWith(task, secondProject.id, expect.any(String), true));
    expect(value.onTaskMoved).toHaveBeenCalledWith(expect.objectContaining({ id: task.id, project_id: secondProject.id, assignee_member_id: null }));
  });

  it('never offers an archived, foreign-space or unauthorized destination and protects assignment permission', async () => {
    const user = userEvent.setup();
    const value = props({
      canAssign: false,
      canCreateInProject: id => id !== 'forbidden',
      projects: [
        summaryProject,
        secondProject,
        { ...secondProject, id: 'forbidden', name: 'Sin permiso' },
        { ...secondProject, id: 'archived', name: 'Archivado', archived_at: '2026-01-01T00:00:00Z' },
        { ...secondProject, id: 'foreign', name: 'Otro espacio', workspace_id: 'other-workspace' },
      ],
    });
    render(<TaskDetail {...value} />);
    await user.click(screen.getByRole('button', { name: 'Mover' }));
    const select = screen.getByRole('combobox', { name: 'Proyecto de destino' });
    expect(within(select).queryByRole('option', { name: 'Sin permiso' })).not.toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: 'Archivado' })).not.toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: 'Otro espacio' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Mover sin responsable' })).toBeDisabled();
  });

  it('archives and restores without deleting or changing the task identity', async () => {
    const user = userEvent.setup();
    const value = props();
    render(<TaskDetail {...value} />);
    await user.click(screen.getByRole('button', { name: 'Archivar' }));
    await user.click(screen.getByRole('button', { name: 'Archivar tarea' }));
    expect(await screen.findByText(/Esta tarea está archivada/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Editar tarea' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Restaurar' }));
    await user.click(screen.getByRole('button', { name: 'Restaurar tarea' }));
    await waitFor(() => expect(value.api!.archiveTask).toHaveBeenCalledTimes(2));
    expect(vi.mocked(value.api!.archiveTask).mock.calls[0]).toEqual([task, true, expect.any(String)]);
    expect(vi.mocked(value.api!.archiveTask).mock.calls[1][0]).toEqual(
      expect.objectContaining({ id: task.id, version: task.version + 1, archived_at: expect.any(String) }),
    );
    expect(vi.mocked(value.api!.archiveTask).mock.calls[1][1]).toBe(false);
    expect(value.onDelete).not.toHaveBeenCalled();
  });

  it('requires explicit typed deletion, keeps the dialog on a conflict and deletes no other task', async () => {
    const user = userEvent.setup();
    const value = props();
    vi.mocked(value.onDelete).mockRejectedValueOnce(new Error('La tarea cambió antes de eliminarla.'));
    render(<TaskDetail {...value} />);
    await user.click(screen.getByRole('button', { name: 'Eliminar' }));
    const dialog = screen.getByRole('dialog', { name: 'Eliminar tarea' });
    const confirm = within(dialog).getByRole('button', { name: 'Eliminar tarea' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: 'Escribe ELIMINAR para confirmar' }), 'ELIMINAR');
    await user.click(confirm);
    expect(await screen.findByRole('alert')).toHaveTextContent('La tarea cambió');
    expect(value.onClose).not.toHaveBeenCalled();
    await user.click(confirm);
    await waitFor(() => expect(value.onClose).toHaveBeenCalledOnce());
    expect(value.onDelete).toHaveBeenNthCalledWith(1, task);
    expect(value.onDelete).toHaveBeenNthCalledWith(2, task);
  });

  it('keeps all changes disabled under read-only access and offers no delete capability', () => {
    const value = props({ readOnly: true, canDelete: false });
    render(<TaskDetail {...value} />);
    for (const name of ['Editar tarea', 'Completar tarea', 'Duplicar', 'Mover', 'Archivar', 'Guardar detalle'])
      expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Nueva subtarea' })).toBeDisabled();
    expect(value.api!.archiveTask).not.toHaveBeenCalled();
  });

  it('allows a task reader to copy into a writable destination while source edits remain disabled', async () => {
    const user = userEvent.setup();
    const value = props({ canEdit: false, canDelete: false, canCreateInProject: id => id === secondProject.id });
    render(<TaskDetail {...value} />);
    for (const name of ['Editar tarea', 'Completar tarea', 'Mover', 'Archivar']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Nueva etiqueta' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Duplicar' }));
    expect(screen.getByRole('combobox', { name: 'Proyecto de destino' })).toHaveValue(secondProject.id);
    await user.click(screen.getByRole('button', { name: 'Duplicar tarea' }));
    await waitFor(() => expect(value.api!.duplicateTask).toHaveBeenCalledWith(task, secondProject.id, expect.any(String)));
    expect(value.onUpdate).not.toHaveBeenCalled();
    expect(value.api!.archiveTask).not.toHaveBeenCalled();
  });

  it('global read-only blocks deletion even when the capability snapshot still includes delete', () => {
    render(<TaskDetail {...props({ readOnly: true, canEdit: true, canDelete: true })} />);
    expect(screen.getByRole('button', { name: 'Eliminar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Duplicar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archivar' })).toBeDisabled();
  });

  it('uses the existing editor without nested dialogs and applies its confirmed result', async () => {
    const user = userEvent.setup();
    const value = props();
    render(<TaskDetail {...value} />);
    await user.click(screen.getByRole('button', { name: 'Editar tarea' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const title = screen.getByRole('textbox', { name: 'Título' });
    await user.clear(title);
    await user.type(title, 'Lanzamiento revisado');
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByRole('heading', { name: 'Lanzamiento revisado' })).toBeInTheDocument();
    expect(value.onUpdate).toHaveBeenCalledWith(task, expect.objectContaining({ title: 'Lanzamiento revisado' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('keeps a dirty draft until it is saved or explicitly discarded before moving or archiving', async () => {
    const user = userEvent.setup();
    const value = props();
    render(<TaskDetail {...value} />);
    await user.type(screen.getByRole('textbox', { name: 'Nueva etiqueta' }), 'No perder{Enter}');
    expect(screen.getByRole('button', { name: 'Mover' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archivar' })).toBeDisabled();
    expect(screen.getByText('No perder')).toBeInTheDocument();
    expect(value.api!.moveTask).not.toHaveBeenCalled();
    expect(value.api!.archiveTask).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Descartar cambios de detalle' }));
    expect(screen.queryByText('No perder')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mover' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Archivar' })).toBeEnabled();
    expect(value.api!.updateTaskDetails).not.toHaveBeenCalled();
  });

  it('replaces drafts on scope changes and suppresses late callbacks from the previous space', async () => {
    const user = userEvent.setup();
    let resolve!: (task: Task) => void;
    const value = props();
    vi.mocked(value.api!.updateTaskDetails).mockImplementation(
      () =>
        new Promise<Task>(finish => {
          resolve = finish;
        }),
    );
    const view = render(<TaskDetail {...value} />);
    await user.type(screen.getByRole('textbox', { name: 'Nueva etiqueta' }), 'Anterior{Enter}');
    await user.click(screen.getByRole('button', { name: 'Guardar detalle' }));
    const other = { ...task, id: 'new-task', workspace_id: 'new-workspace', title: 'Trabajo del otro espacio', labels: ['Actual'] };
    view.rerender(<TaskDetail {...value} task={other} api={{ ...value.api!, scopeKey: ['work-management', 'new-workspace'] }} />);
    await act(async () => {
      resolve({ ...task, labels: ['Anterior'], version: task.version + 1 });
    });
    expect(screen.getByRole('heading', { name: 'Trabajo del otro espacio' })).toBeInTheDocument();
    expect(screen.queryByText('Anterior')).not.toBeInTheDocument();
    expect(value.onTaskSaved).not.toHaveBeenCalled();
    expect(value.onTaskMoved).not.toHaveBeenCalled();
  });
});
