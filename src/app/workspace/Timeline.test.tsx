import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { PlanningState, ProjectMilestone, TaskDependency } from '../planning-types';
import type { Task } from '../types';
import type { PlanningController } from './usePlanning';
import Timeline from './Timeline';
import { summaryMember, summaryProject, summaryProps, summaryTask } from './summary-test-fixtures';

const today = '2026-10-28';
const task = (id: string, patch: Partial<Task> = {}): Task => ({
  ...summaryTask,
  id,
  title: id,
  start_date: today,
  due_date: '2026-10-30',
  version: 7,
  ...patch,
});
const edge: TaskDependency = {
  id: 'dependency',
  workspace_id: summaryProject.workspace_id,
  blocker_task_id: 'Preparar',
  task_id: 'Publicar',
  version: 1,
  created_at: summaryTask.created_at,
};
const milestone: ProjectMilestone = {
  id: 'milestone',
  workspace_id: summaryProject.workspace_id,
  project_id: summaryProject.id,
  name: 'Lanzamiento',
  date: today,
  completed: false,
  version: 1,
  created_at: summaryTask.created_at,
  updated_at: summaryTask.updated_at,
};
function planning(state: PlanningState = { dependencies: [], milestones: [] }): PlanningController {
  return {
    state,
    available: true,
    loading: false,
    pending: false,
    error: null,
    refresh: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    createMilestone: vi.fn(),
    updateMilestone: vi.fn(),
    deleteMilestone: vi.fn(),
  };
}
function props(overrides: Partial<ComponentProps<typeof Timeline>> = {}): ComponentProps<typeof Timeline> {
  return {
    data: summaryProps({ tasks: [task('Preparar')] }),
    planning: planning(),
    onOpen: vi.fn(),
    onReschedule: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
function pointer(target: Element, name: string, x: number) {
  fireEvent(target, new MouseEvent(name, { bubbles: true, clientX: x, clientY: 100, button: 0 }));
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Timeline', () => {
  it('renders civil date bars, an explicit date alternative, and both demo scales', async () => {
    const user = userEvent.setup();
    const value = props();
    render(<Timeline {...value} />);
    expect(screen.getByRole('heading', { name: 'Cronograma' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Preparar, .*Abrir tarea$/ })).toHaveStyle({ width: '96px' });
    await user.click(screen.getByRole('button', { name: /^Preparar, .*Abrir tarea$/ }));
    expect(value.onOpen).toHaveBeenCalledWith(value.data.tasks[0]);
    await user.click(screen.getByRole('button', { name: 'Meses' }));
    expect(screen.getByRole('button', { name: 'Meses' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Preparar, .*Abrir tarea$/ })).toHaveStyle({ width: '33px' });
    expect(screen.getByRole('button', { name: 'Reprogramar Preparar' })).toBeEnabled();
  });
  it('recenters Today after a horizontal scroll even when the period has not changed', async () => {
    render(<Timeline {...props()} />);
    const viewport = screen.getByRole('region', { name: 'Fechas del cronograma; desplazamiento horizontal' });
    const centered = viewport.scrollLeft;
    viewport.scrollLeft = 1500;
    await userEvent.click(screen.getByRole('button', { name: 'Hoy' }));
    expect(viewport.scrollLeft).toBe(centered);
    expect(viewport.scrollLeft).not.toBe(1500);
  });
  it('centers Today within the actual mobile plot width and recenters after resizing the viewport or fixed column', async () => {
    let width = 358;
    let labelWidth = 215;
    let notifyResize: (() => void) | undefined;
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notifyResize = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('pwt-scroll') ? width : 0;
    });
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, 0, this.classList.contains('pwt-corner') ? labelWidth : 0, 54);
    });
    try {
      const rendered = render(<Timeline {...props()} />);
      const viewport = screen.getByRole('region', { name: 'Fechas del cronograma; desplazamiento horizontal' });
      const todayCenter = 23.5 * 32;
      expect(viewport.scrollLeft).toBe(todayCenter - (358 - 215) / 2);
      expect(todayCenter - viewport.scrollLeft).toBeGreaterThan(0);
      expect(todayCenter - viewport.scrollLeft).toBeLessThan(143);
      viewport.scrollLeft = 1400;
      await userEvent.click(screen.getByRole('button', { name: 'Hoy' }));
      expect(viewport.scrollLeft).toBe(todayCenter - (358 - 215) / 2);
      width = 800;
      labelWidth = 290;
      notifyResize?.();
      expect(viewport.scrollLeft).toBe(todayCenter - (800 - 290) / 2);
      labelWidth = 215;
      notifyResize?.();
      expect(viewport.scrollLeft).toBe(todayCenter - (800 - 215) / 2);
      expect(observe).toHaveBeenCalledTimes(2);
      rendered.unmount();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      clientWidth.mockRestore();
      bounds.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it('keeps the original version and all other fields while confirming only the edited dates', async () => {
    const user = userEvent.setup();
    const original = task('Preparar', {
      scheduled_start_at: '2026-10-28T10:00:00Z',
      scheduled_end_at: '2026-10-28T11:00:00Z',
      scheduled_time_zone: 'America/Santo_Domingo',
    });
    const value = props({ data: summaryProps({ tasks: [original] }) });
    render(<Timeline {...value} />);
    await user.click(screen.getByRole('button', { name: 'Reprogramar Preparar' }));
    fireEvent.change(screen.getByLabelText('Fecha de inicio'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('Fecha de vencimiento'), { target: { value: '2026-11-04' } });
    expect(value.onReschedule).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirmar fechas' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(value.onReschedule).toHaveBeenCalledExactlyOnceWith(original, { start_date: '2026-11-01', due_date: '2026-11-04' });
    expect(original.version).toBe(7);
    expect(original.scheduled_start_at).toBe('2026-10-28T10:00:00Z');
  });
  it('retains a failed draft for retry and never silently replaces its expected version', async () => {
    const user = userEvent.setup();
    const callback = vi.fn().mockRejectedValueOnce(new Error('La tarea cambió en otro dispositivo.')).mockResolvedValueOnce(undefined);
    const value = props({ onReschedule: callback });
    const rendered = render(<Timeline {...value} />);
    await user.click(screen.getByRole('button', { name: 'Reprogramar Preparar' }));
    fireEvent.change(screen.getByLabelText('Fecha de vencimiento'), { target: { value: '2026-11-05' } });
    await user.click(screen.getByRole('button', { name: 'Confirmar fechas' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La tarea cambió en otro dispositivo.');
    rendered.rerender(<Timeline {...value} data={{ ...value.data, tasks: [{ ...value.data.tasks[0], version: 8 }] }} />);
    expect(screen.getByLabelText('Fecha de vencimiento')).toHaveValue('2026-11-05');
    await user.click(screen.getByRole('button', { name: 'Confirmar fechas' }));
    await waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
    expect(callback.mock.calls[1][0].version).toBe(7);
  });
  it('previews a pointer move but saves nothing until the confirmation is accepted', async () => {
    const value = props();
    render(<Timeline {...value} />);
    const bar = screen.getByRole('button', { name: /^Preparar, .*Abrir tarea$/ });
    pointer(bar, 'pointerdown', 100);
    pointer(bar, 'pointermove', 164);
    expect(bar).toHaveClass('is-preview');
    expect(value.onReschedule).not.toHaveBeenCalled();
    pointer(bar, 'pointerup', 164);
    expect(screen.getByRole('dialog', { name: 'Reprogramar: Preparar' })).toBeInTheDocument();
    expect(screen.getByLabelText('Fecha de inicio')).toHaveValue('2026-10-30');
    expect(screen.getByLabelText('Fecha de vencimiento')).toHaveValue('2026-11-01');
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(value.onReschedule).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Preparar, .*Abrir tarea$/ })).not.toHaveClass('is-preview');
  });
  it('offers keyboard scheduling and allows cancel without altering any task', async () => {
    const value = props();
    render(<Timeline {...value} />);
    const bar = screen.getByRole('button', { name: /^Preparar, .*Abrir tarea$/ });
    fireEvent.keyDown(bar, { key: 'r' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(value.onReschedule).not.toHaveBeenCalled();
  });
  it('resizes an endpoint in preview and confirms a single day without moving related tasks', async () => {
    const value = props();
    render(<Timeline {...value} />);
    const bar = screen.getByRole('button', { name: /^Preparar, .*Abrir tarea$/ });
    const handle = bar.querySelector('.pwt-resize-start')!;
    pointer(handle, 'pointerdown', 100);
    pointer(handle, 'pointermove', 260);
    pointer(handle, 'pointerup', 260);
    expect(screen.getByLabelText('Fecha de inicio')).toHaveValue('2026-10-30');
    expect(screen.getByLabelText('Fecha de vencimiento')).toHaveValue('2026-10-30');
    expect(value.onReschedule).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar fechas' }));
    expect(value.onReschedule).toHaveBeenCalledExactlyOnceWith(value.data.tasks[0], { start_date: '2026-10-30', due_date: '2026-10-30' });
  });
  it('keeps undated tasks separate and presents single-date tasks as one day', async () => {
    const user = userEvent.setup();
    render(
      <Timeline
        {...props({
          data: summaryProps({
            tasks: [
              task('Solo inicio', { due_date: null }),
              task('Solo vencimiento', { start_date: null }),
              task('Sin fecha', { start_date: null, due_date: null }),
            ],
          }),
        })}
      />,
    );
    expect(screen.getByRole('button', { name: /^Solo inicio, .*Abrir tarea$/ })).toHaveStyle({ width: '32px' });
    expect(screen.getByRole('button', { name: /^Solo vencimiento, .*Abrir tarea$/ })).toHaveStyle({ width: '32px' });
    await user.click(screen.getByText('Sin programar', { selector: 'summary' }));
    await user.click(screen.getByRole('button', { name: 'Programar' }));
    expect(screen.getByLabelText('Fecha de inicio')).toHaveValue(today);
    expect(screen.getByLabelText('Fecha de vencimiento')).toHaveValue(today);
  });
  it('draws inclusive-date conflicts only while both endpoints remain visible', async () => {
    const user = userEvent.setup();
    render(
      <Timeline
        {...props({
          data: summaryProps({ tasks: [task('Preparar'), task('Publicar', { status: 'review' })] }),
          planning: planning({ dependencies: [edge], milestones: [] }),
        })}
      />,
    );
    expect(screen.getByTestId('timeline-conflicting-dependency')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 dependencia con fechas solapadas');
    await user.selectOptions(screen.getByLabelText('Estado en el cronograma'), 'review');
    expect(screen.queryByTestId('timeline-conflicting-dependency')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    await user.click(screen.getByRole('button', { name: /Por hacer/ }));
    expect(screen.queryByTestId('timeline-conflicting-dependency')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Por hacer/ })).toHaveAttribute('aria-expanded', 'false');
  });
  it('warns about dependency overlap without adjusting or blocking the proposed dates', async () => {
    const user = userEvent.setup();
    const value = props({
      data: summaryProps({ tasks: [task('Preparar'), task('Publicar', { start_date: '2026-11-01', due_date: '2026-11-02' })] }),
      planning: planning({ dependencies: [edge], milestones: [] }),
    });
    render(<Timeline {...value} />);
    await user.click(screen.getByRole('button', { name: 'Reprogramar Publicar' }));
    fireEvent.change(screen.getByLabelText('Fecha de inicio'), { target: { value: today } });
    expect(within(screen.getByRole('dialog')).getByText(/Estas fechas se solapan con 1 dependencia/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirmar fechas' }));
    expect(value.onReschedule).toHaveBeenCalledExactlyOnceWith(value.data.tasks[1], { start_date: today, due_date: '2026-11-02' });
  });
  it('draws cross-project dependencies in the global view only while both readable endpoints are present', async () => {
    const user = userEvent.setup();
    const otherProject = { ...summaryProject, id: 'distribution', name: 'Distribución' };
    const value = props({
      data: summaryProps({
        projects: [summaryProject, otherProject],
        tasks: [task('Preparar'), task('Publicar', { project_id: otherProject.id, start_date: '2026-11-01', due_date: '2026-11-02' })],
      }),
      planning: planning({ dependencies: [edge], milestones: [] }),
    });
    const rendered = render(<Timeline {...value} />);
    expect(screen.getByTestId('timeline-dependency')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Proyecto en el cronograma'), otherProject.id);
    expect(screen.queryByTestId('timeline-dependency')).not.toBeInTheDocument();
    rendered.rerender(<Timeline {...value} project={summaryProject} />);
    expect(screen.queryByTestId('timeline-dependency')).not.toBeInTheDocument();
  });
  it('groups same-day milestones into one colored marker and expands their management panel', async () => {
    const user = userEvent.setup();
    render(
      <Timeline
        {...props({
          planning: planning({ dependencies: [], milestones: [milestone, { ...milestone, id: 'second', name: 'Revisión', completed: true }] }),
          milestoneContent: <p>Administración de hitos</p>,
        })}
      />,
    );
    expect(screen.getAllByRole('button', { name: /^2 hitos:/ })).toHaveLength(1);
    expect(screen.queryByText('Administración de hitos')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hitos' }));
    expect(screen.getByText('Administración de hitos')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hitos' })).toHaveAttribute('aria-expanded', 'true');
  });
  it('disables scheduling for read-only, archived, or unauthorized tasks and hides unreadable directories', async () => {
    const archived = { ...summaryProject, archived_at: today };
    const value = props({ data: summaryProps({ projects: [archived], tasks: [task('Preparar')], currentUserId: 'not-owner' }), project: archived });
    const rendered = render(<Timeline {...value} />);
    expect(screen.queryByRole('button', { name: 'Reprogramar Preparar' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Responsable en el cronograma')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Agrupar: Responsable' })).not.toBeInTheDocument();
    expect(screen.queryByText(summaryMember.display_name)).not.toBeInTheDocument();
    rendered.rerender(<Timeline {...value} project={summaryProject} data={summaryProps({ tasks: [task('Preparar')], readOnly: true })} />);
    expect(screen.queryByRole('button', { name: 'Reprogramar Preparar' })).not.toBeInTheDocument();
  });
  it('prevents a pending draft from saving after edit rights change', async () => {
    const user = userEvent.setup();
    const value = props();
    const rendered = render(<Timeline {...value} />);
    await user.click(screen.getByRole('button', { name: 'Reprogramar Preparar' }));
    rendered.rerender(<Timeline {...value} data={{ ...value.data, readOnly: true }} />);
    expect(screen.getByRole('button', { name: 'Confirmar fechas' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Esta tarea ya no se puede editar');
    expect(value.onReschedule).not.toHaveBeenCalled();
  });
  it('clears filters, expansion and draft when switching workspace scopes', async () => {
    const user = userEvent.setup();
    const value = props({ milestoneContent: <p>Administración de hitos</p> });
    const rendered = render(<Timeline {...value} />);
    await user.type(screen.getByLabelText('Buscar en el cronograma'), 'Preparar');
    await user.click(screen.getByRole('button', { name: 'Hitos' }));
    await user.click(screen.getByRole('button', { name: 'Reprogramar Preparar' }));
    const other = { ...value.data.workspace!, id: 'other-space' };
    rendered.rerender(<Timeline {...value} data={{ ...value.data, workspace: other, projects: [], tasks: [] }} />);
    expect(screen.getByLabelText('Buscar en el cronograma')).toHaveValue('');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Administración de hitos')).not.toBeInTheDocument();
    expect(screen.queryByText('Preparar')).not.toBeInTheDocument();
  });
  it('clears an old draft when the planning API revision changes in the same workspace', async () => {
    const user = userEvent.setup();
    const api = {
      scopeKey: ['planning', 'user', summaryProject.workspace_id, 'revision-1'],
      load: vi.fn(),
      addDependency: vi.fn(),
      removeDependency: vi.fn(),
      createMilestone: vi.fn(),
      updateMilestone: vi.fn(),
      deleteMilestone: vi.fn(),
    };
    const value = props({ data: summaryProps({ tasks: [task('Preparar')], planning: api }) });
    const rendered = render(<Timeline {...value} />);
    await user.click(screen.getByRole('button', { name: 'Reprogramar Preparar' }));
    rendered.rerender(
      <Timeline {...value} data={{ ...value.data, planning: { ...api, scopeKey: ['planning', 'user', summaryProject.workspace_id, 'revision-2'] } }} />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(value.onReschedule).not.toHaveBeenCalled();
  });
});
