import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TaskDependency } from '../planning-types';
import type { Project, Task } from '../types';
import DependencyPanel from './DependencyPanel';
import { summaryProject, summaryTask } from './summary-test-fixtures';
import type { PlanningController } from './usePlanning';

const otherProject: Project = { ...summaryProject, id: 'second-project', code: 'P-B', name: 'Imprenta' };
const blocker: Task = { ...summaryTask, id: 'blocker', project_id: otherProject.id, title: 'Revisar borrador', due_date: '2026-11-05' };
const successor: Task = { ...summaryTask, id: 'successor', title: 'Publicar edición', start_date: '2026-10-28' };
const edge: TaskDependency = {
  id: 'edge',
  workspace_id: summaryProject.workspace_id,
  task_id: summaryTask.id,
  blocker_task_id: blocker.id,
  version: 2,
  created_at: summaryProject.created_at,
};

function planning(overrides: Partial<PlanningController> = {}): PlanningController {
  return {
    state: { dependencies: [], milestones: [] },
    available: true,
    loading: false,
    pending: false,
    error: null,
    refresh: vi.fn(),
    addDependency: vi.fn().mockResolvedValue(edge),
    removeDependency: vi.fn().mockResolvedValue(undefined),
    createMilestone: vi.fn(),
    updateMilestone: vi.fn(),
    deleteMilestone: vi.fn(),
    ...overrides,
  };
}

function props(controller = planning()) {
  return {
    task: summaryTask,
    tasks: [summaryTask, blocker, successor],
    projects: [summaryProject, otherProject],
    planning: controller,
    canEdit: true,
    onOpen: vi.fn(),
  };
}

describe('dependencias visibles de tareas', () => {
  it('muestra relaciones en ambas direcciones y avisa sin completar ni reprogramar ninguna tarea', async () => {
    const user = userEvent.setup();
    const reverse = { ...edge, id: 'next', task_id: successor.id, blocker_task_id: summaryTask.id };
    const original = structuredClone(summaryTask);
    const input = props(planning({ state: { dependencies: [edge, reverse], milestones: [] } }));
    render(<DependencyPanel {...input} />);
    expect(screen.getByRole('heading', { name: /Bloqueada por 1/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Bloquea a 1/ })).toBeInTheDocument();
    expect(screen.getByText(/Hay una predecesora pendiente/)).toBeInTheDocument();
    expect(screen.getAllByText(/La sucesora debe comenzar después/)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /^Revisar borrador/ }));
    expect(input.onOpen).toHaveBeenCalledExactlyOnceWith(blocker);
    expect(input.planning.addDependency).not.toHaveBeenCalled();
    expect(summaryTask).toEqual(original);
  });

  it('limita candidatos a tareas activas, legibles y del mismo espacio; excluye la propia tarea y vínculos existentes', async () => {
    const user = userEvent.setup();
    const foreignProject = { ...otherProject, id: 'foreign-project', workspace_id: 'other-workspace', name: 'Otro espacio' };
    const archivedProject = { ...otherProject, id: 'archived-project', archived_at: '2026-10-01' };
    const hiddenTask = { ...blocker, id: 'hidden', project_id: 'unreadable', title: 'Tarea oculta' };
    const input = props(planning({ state: { dependencies: [edge], milestones: [] } }));
    input.projects.push(foreignProject, archivedProject);
    input.tasks.push(
      hiddenTask,
      { ...blocker, id: 'foreign', workspace_id: 'other-workspace', project_id: foreignProject.id, title: 'Tarea ajena' },
      { ...blocker, id: 'archived', archived_at: '2026-10-01', title: 'Archivada' },
      { ...blocker, id: 'archived-parent', project_id: archivedProject.id, title: 'Proyecto archivado' },
    );
    render(<DependencyPanel {...input} />);
    await user.click(screen.getByRole('button', { name: 'Añadir dependencia' }));
    const select = screen.getByRole('combobox', { name: 'Esta tarea está bloqueada por' });
    expect(
      within(select)
        .getAllByRole('option')
        .map(option => option.textContent),
    ).toEqual(['Selecciona una tarea', 'Publicar edición · Revista']);
    expect(screen.queryByText('Tarea oculta')).not.toBeInTheDocument();
  });

  it('no muestra relaciones con extremos ocultos ni de otro espacio', () => {
    const input = props(
      planning({
        state: {
          dependencies: [
            { ...edge, blocker_task_id: 'missing' },
            { ...edge, id: 'foreign-edge', workspace_id: 'foreign' },
          ],
          milestones: [],
        },
      }),
    );
    render(<DependencyPanel {...input} />);
    expect(screen.getByText('Sin predecesoras visibles.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Quitar relación/ })).not.toBeInTheDocument();
  });

  it('avisa también si el inicio de la sucesora coincide con el día de vencimiento inclusivo', () => {
    const input = props(planning({ state: { dependencies: [edge], milestones: [] } }));
    render(<DependencyPanel {...input} task={{ ...summaryTask, start_date: blocker.due_date }} />);
    expect(screen.getByText(/La sucesora debe comenzar después/)).toBeInTheDocument();
  });

  it('permite recargar una consulta que falló', async () => {
    const user = userEvent.setup();
    const controller = planning({ available: false, error: 'No se pudo cargar la planificación' });
    render(<DependencyPanel {...props(controller)} />);
    await user.click(screen.getByRole('button', { name: 'Actualizar planificación' }));
    expect(controller.refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Añadir dependencia' })).toBeDisabled();
  });

  it.each([{ readOnly: true }, { canEdit: false }, { task: { ...summaryTask, archived_at: '2026-10-01' } }])(
    'conserva lectura sin ofrecer mutaciones: %j',
    override => {
      render(<DependencyPanel {...props(planning({ state: { dependencies: [edge], milestones: [] } }))} {...override} />);
      expect(screen.getByRole('button', { name: /Revisar borrador/ })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Añadir dependencia' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Quitar relación/ })).not.toBeInTheDocument();
    },
  );

  it('conserva selección e identidad al rechazar un ciclo o fallar la respuesta; otro intento obtiene otro UUID', async () => {
    const user = userEvent.setup();
    const controller = planning({ addDependency: vi.fn().mockRejectedValue(new Error('La dependencia crearía un ciclo.')) });
    render(<DependencyPanel {...props(controller)} />);
    await user.click(screen.getByRole('button', { name: 'Añadir dependencia' }));
    await user.selectOptions(screen.getByRole('combobox'), blocker.id);
    await user.click(screen.getByRole('button', { name: 'Vincular tarea' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('crearía un ciclo');
    expect(screen.getByRole('combobox')).toHaveValue(blocker.id);
    expect(screen.getByRole('combobox')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Vincular tarea' }));
    await waitFor(() => expect(controller.addDependency).toHaveBeenCalledTimes(2));
    expect(vi.mocked(controller.addDependency).mock.calls[0]).toEqual(vi.mocked(controller.addDependency).mock.calls[1]);
    expect(vi.mocked(controller.addDependency).mock.calls[0]).toEqual([summaryTask, blocker, expect.stringMatching(/^[a-f0-9-]{36}$/)]);
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    await user.click(screen.getByRole('button', { name: 'Añadir dependencia' }));
    await user.selectOptions(screen.getByRole('combobox'), successor.id);
    await user.click(screen.getByRole('button', { name: 'Vincular tarea' }));
    await waitFor(() => expect(controller.addDependency).toHaveBeenCalledTimes(3));
    expect(vi.mocked(controller.addDependency).mock.calls[2][2]).not.toBe(vi.mocked(controller.addDependency).mock.calls[0][2]);
  });

  it('permite repetir el mismo intento si una recarga confirma la relación tras perder la respuesta', async () => {
    const user = userEvent.setup();
    const addDependency = vi.fn().mockRejectedValueOnce(new Error('Respuesta perdida')).mockResolvedValueOnce(edge);
    const controller = planning({ addDependency });
    const input = props(controller);
    const view = render(<DependencyPanel {...input} />);
    await user.click(screen.getByRole('button', { name: 'Añadir dependencia' }));
    await user.selectOptions(screen.getByRole('combobox'), blocker.id);
    await user.click(screen.getByRole('button', { name: 'Vincular tarea' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Respuesta perdida');
    const requestId = addDependency.mock.calls[0][2];
    view.rerender(<DependencyPanel {...input} planning={{ ...controller, state: { dependencies: [{ ...edge, id: requestId }], milestones: [] } }} />);
    expect(screen.getByRole('button', { name: 'Vincular tarea' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Vincular tarea' }));
    await waitFor(() => expect(addDependency).toHaveBeenCalledTimes(2));
    expect(addDependency.mock.calls[1]).toEqual(addDependency.mock.calls[0]);
    expect(await screen.findByRole('status')).toHaveTextContent('Dependencia añadida');
  });

  it('confirma quitar únicamente la relación con su versión y no permite quitar la sucesora desde aquí', async () => {
    const user = userEvent.setup();
    const controller = planning({
      state: { dependencies: [edge, { ...edge, id: 'next', task_id: successor.id, blocker_task_id: summaryTask.id }], milestones: [] },
    });
    render(<DependencyPanel {...props(controller)} />);
    expect(screen.queryByRole('button', { name: 'Quitar relación con Publicar edición' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Quitar relación con Revisar borrador' }));
    const confirmation = screen.getByRole('alertdialog', { name: '¿Quitar esta dependencia?' });
    expect(confirmation).toHaveTextContent('Las dos tareas y su contenido se conservarán');
    expect(controller.removeDependency).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole('button', { name: 'Quitar relación' }));
    await waitFor(() => expect(controller.removeDependency).toHaveBeenCalledExactlyOnceWith(edge));
  });

  it('conserva las versiones del primer envío aunque lleguen tareas actualizadas entre reintentos', async () => {
    const user = userEvent.setup();
    const controller = planning({ addDependency: vi.fn().mockRejectedValue(new Error('No se confirmó la respuesta.')) });
    const input = props(controller);
    const view = render(<DependencyPanel {...input} />);
    await user.click(screen.getByRole('button', { name: 'Añadir dependencia' }));
    await user.selectOptions(screen.getByRole('combobox'), blocker.id);
    await user.click(screen.getByRole('button', { name: 'Vincular tarea' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se confirmó');
    view.rerender(<DependencyPanel {...input} task={{ ...summaryTask, version: 3 }} tasks={[summaryTask, { ...blocker, version: 5 }, successor]} />);
    await user.click(screen.getByRole('button', { name: 'Vincular tarea' }));
    await waitFor(() => expect(controller.addDependency).toHaveBeenCalledTimes(2));
    expect(vi.mocked(controller.addDependency).mock.calls[1]).toEqual(vi.mocked(controller.addDependency).mock.calls[0]);
  });

  it('deshabilita mutaciones pendientes y evita que una respuesta tardía toque el panel de otra tarea', async () => {
    const user = userEvent.setup();
    let resolve!: (value: TaskDependency) => void;
    const controller = planning({
      addDependency: vi.fn().mockImplementation(
        () =>
          new Promise<TaskDependency>(done => {
            resolve = done;
          }),
      ),
    });
    const input = props(controller);
    const view = render(<DependencyPanel {...input} />);
    await user.click(screen.getByRole('button', { name: 'Añadir dependencia' }));
    await user.selectOptions(screen.getByRole('combobox'), blocker.id);
    await user.click(screen.getByRole('button', { name: 'Vincular tarea' }));
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    view.rerender(<DependencyPanel {...input} task={successor} />);
    await act(async () => resolve(edge));
    expect(screen.queryByText(/Dependencia añadida/)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
