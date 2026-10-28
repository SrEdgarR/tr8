import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectMilestone } from '../planning-types';
import type { Project } from '../types';
import MilestonePanel from './MilestonePanel';
import { summaryProject, summaryProps } from './summary-test-fixtures';
import type { PlanningController } from './usePlanning';

const milestone: ProjectMilestone = {
  id: 'milestone',
  workspace_id: summaryProject.workspace_id,
  project_id: summaryProject.id,
  name: 'Lanzamiento',
  date: '2026-11-20',
  completed: false,
  version: 4,
  created_at: summaryProject.created_at,
  updated_at: summaryProject.updated_at,
};
const anotherProject: Project = { ...summaryProject, id: 'second-project', name: 'Imprenta' };

function planning(overrides: Partial<PlanningController> = {}): PlanningController {
  return {
    state: { dependencies: [], milestones: [milestone] },
    available: true,
    loading: false,
    pending: false,
    error: null,
    refresh: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    createMilestone: vi.fn().mockResolvedValue(milestone),
    updateMilestone: vi.fn().mockResolvedValue(milestone),
    deleteMilestone: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('hitos de proyectos', () => {
  it('ofrece recargar cuando falla la consulta y mantiene deshabilitada la creación', async () => {
    const user = userEvent.setup();
    const controller = planning({ available: false, error: 'No se pudo cargar la planificación' });
    render(<MilestonePanel data={summaryProps()} planning={controller} />);
    await user.click(screen.getByRole('button', { name: 'Actualizar planificación' }));
    expect(controller.refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Nuevo hito' })).toBeDisabled();
  });

  it('muestra solo hitos del espacio y proyectos legibles, con selector de proyectos editable', async () => {
    const user = userEvent.setup();
    const hidden = { ...anotherProject, id: 'hidden', name: 'Proyecto secreto' };
    const foreign = { ...anotherProject, id: 'foreign', workspace_id: 'otro-espacio', name: 'Otro espacio' };
    const controller = planning({
      state: {
        dependencies: [],
        milestones: [
          milestone,
          { ...milestone, id: 'hidden-row', project_id: hidden.id, name: 'Hito secreto' },
          { ...milestone, id: 'foreign-row', workspace_id: foreign.workspace_id, project_id: foreign.id, name: 'Hito ajeno' },
        ],
      },
    });
    render(
      <MilestonePanel
        data={summaryProps({
          projects: [summaryProject, anotherProject, hidden, foreign],
          capabilities: {
            [summaryProject.id]: { project_id: summaryProject.id, access_level: 'write', permissions: ['project.read', 'project.edit'] },
            [anotherProject.id]: { project_id: anotherProject.id, access_level: 'read', permissions: ['project.read'] },
          },
        })}
        planning={controller}
      />,
    );
    expect(screen.getByText('Lanzamiento')).toBeInTheDocument();
    expect(screen.queryByText('Hito secreto')).not.toBeInTheDocument();
    expect(screen.queryByText('Hito ajeno')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Nuevo hito' }));
    expect(
      within(screen.getByRole('combobox', { name: 'Proyecto' }))
        .getAllByRole('option')
        .map(option => option.textContent),
    ).toEqual(['Revista']);
  });

  it('filtra la vista por proyecto y conserva lectura aunque el espacio sea de solo lectura', () => {
    const controller = planning({
      state: { dependencies: [], milestones: [milestone, { ...milestone, id: 'second', project_id: anotherProject.id, name: 'Hito de imprenta' }] },
    });
    render(
      <MilestonePanel data={summaryProps({ projects: [summaryProject, anotherProject], readOnly: true })} project={summaryProject} planning={controller} />,
    );
    expect(screen.getByText('Lanzamiento')).toBeInTheDocument();
    expect(screen.queryByText('Hito de imprenta')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nuevo hito' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Completar hito Lanzamiento' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Editar hito Lanzamiento' })).not.toBeInTheDocument();
  });

  it.each([{ archived_at: '2026-10-01' }, { archived_at: null }])('no permite edición sin project.edit o con el proyecto archivado: %j', projectOverride => {
    render(
      <MilestonePanel
        data={summaryProps({
          projects: [{ ...summaryProject, ...projectOverride }],
          capabilities: { [summaryProject.id]: { project_id: summaryProject.id, access_level: 'read', permissions: ['project.read'] } },
        })}
        planning={planning()}
      />,
    );
    expect(screen.getByText('Lanzamiento')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nuevo hito' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Completar hito Lanzamiento' })).toBeDisabled();
  });

  it('guarda nombre, fecha y finalización con un UUID estable en reintentos y uno nuevo al reabrir', async () => {
    const user = userEvent.setup();
    const controller = planning({ createMilestone: vi.fn().mockRejectedValue(new Error('No se confirmó la respuesta.')) });
    render(<MilestonePanel data={summaryProps()} project={summaryProject} planning={controller} />);
    await user.click(screen.getByRole('button', { name: 'Nuevo hito' }));
    await user.type(screen.getByLabelText('Nombre del hito'), '  Lanzar web  ');
    fireEvent.change(screen.getByLabelText('Fecha del hito'), { target: { value: '2026-12-02' } });
    await user.click(screen.getByRole('checkbox', { name: 'Hito completado' }));
    await user.click(screen.getByRole('button', { name: 'Guardar hito' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se confirmó');
    expect(screen.getByLabelText('Nombre del hito')).toHaveValue('  Lanzar web  ');
    expect(screen.getByLabelText('Nombre del hito')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Guardar hito' }));
    await waitFor(() => expect(controller.createMilestone).toHaveBeenCalledTimes(2));
    expect(vi.mocked(controller.createMilestone).mock.calls[0]).toEqual([
      summaryProject,
      { name: 'Lanzar web', date: '2026-12-02', completed: true },
      expect.stringMatching(/^[a-f0-9-]{36}$/),
    ]);
    expect(vi.mocked(controller.createMilestone).mock.calls[0]).toEqual(vi.mocked(controller.createMilestone).mock.calls[1]);
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    await user.click(screen.getByRole('button', { name: 'Nuevo hito' }));
    await user.type(screen.getByLabelText('Nombre del hito'), 'Otro hito');
    await user.click(screen.getByRole('button', { name: 'Guardar hito' }));
    await waitFor(() => expect(controller.createMilestone).toHaveBeenCalledTimes(3));
    expect(vi.mocked(controller.createMilestone).mock.calls[2][2]).not.toBe(vi.mocked(controller.createMilestone).mock.calls[0][2]);
  });

  it('preserva el borrador y la versión capturada ante un conflicto, sin sobrescribir cambios recientes', async () => {
    const user = userEvent.setup();
    const controller = planning({ updateMilestone: vi.fn().mockRejectedValue(new Error('El hito cambió. Vuelve a abrirlo.')) });
    const data = summaryProps();
    const view = render(<MilestonePanel data={data} planning={controller} />);
    await user.click(screen.getByRole('button', { name: 'Editar hito Lanzamiento' }));
    await user.clear(screen.getByLabelText('Nombre del hito'));
    await user.type(screen.getByLabelText('Nombre del hito'), 'Mi borrador');
    view.rerender(
      <MilestonePanel
        data={data}
        planning={{ ...controller, state: { dependencies: [], milestones: [{ ...milestone, version: 5, name: 'Cambio reciente' }] } }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Guardar hito' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El hito cambió');
    expect(screen.getByLabelText('Nombre del hito')).toHaveValue('Mi borrador');
    expect(controller.updateMilestone).toHaveBeenCalledExactlyOnceWith(milestone, { name: 'Mi borrador', date: milestone.date, completed: false });
    expect(screen.getByText('Cambio reciente')).toBeInTheDocument();
  });

  it('completa con la versión visible y confirma el borrado de un hito sin tocar tareas', async () => {
    const user = userEvent.setup();
    const controller = planning();
    render(<MilestonePanel data={summaryProps()} planning={controller} />);
    await user.click(screen.getByRole('button', { name: 'Completar hito Lanzamiento' }));
    await waitFor(() =>
      expect(controller.updateMilestone).toHaveBeenCalledExactlyOnceWith(milestone, { name: milestone.name, date: milestone.date, completed: true }),
    );
    await user.click(screen.getByRole('button', { name: 'Eliminar hito Lanzamiento' }));
    const dialog = screen.getByRole('dialog', { name: 'Eliminar hito' });
    expect(dialog).toHaveTextContent('Sus tareas, proyectos y fechas se conservarán');
    expect(controller.deleteMilestone).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar hito' }));
    await waitFor(() => expect(controller.deleteMilestone).toHaveBeenCalledExactlyOnceWith(milestone));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cierra el diálogo al perder permisos e ignora respuestas tardías de otro espacio', async () => {
    const user = userEvent.setup();
    let resolve!: (value: ProjectMilestone) => void;
    const controller = planning({
      createMilestone: vi.fn().mockImplementation(
        () =>
          new Promise<ProjectMilestone>(done => {
            resolve = done;
          }),
      ),
    });
    const data = summaryProps();
    const view = render(<MilestonePanel data={data} planning={controller} />);
    await user.click(screen.getByRole('button', { name: 'Nuevo hito' }));
    await user.type(screen.getByLabelText('Nombre del hito'), 'Hito pendiente');
    await user.click(screen.getByRole('button', { name: 'Guardar hito' }));
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    view.rerender(<MilestonePanel data={{ ...data, readOnly: true }} planning={controller} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => resolve(milestone));
    expect(screen.queryByText('Hito guardado.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nuevo hito' })).not.toBeInTheDocument();
  });
});
