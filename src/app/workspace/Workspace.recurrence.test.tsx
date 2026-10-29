import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { BulkTasksApi } from '../bulk-task-types';
import type { RecurrenceApi, RecurrenceRule, RecurrenceState } from '../recurrence-types';
import type { WorkspaceProps } from '../types';
import type { WorkManagementApi } from '../work-management-types';
import Workspace from './Workspace';
import { summaryProject, summaryProps, summaryTask } from './summary-test-fixtures';

const uid = (suffix: number) => `f9840000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const project = { ...summaryProject, id: uid(20), workspace_id: uid(10), owner_id: uid(1) };
const task = { ...summaryTask, id: uid(30), workspace_id: project.workspace_id, project_id: project.id, owner_id: project.owner_id };
const daily: RecurrenceRule = { frequency: 'daily', interval: 1, weekdays: [], time_zone: 'UTC', until_date: null };
const noRecurrence: RecurrenceState = { task_id: task.id, series: null, occurrence_date: null, successor_task_id: null };
const configured: RecurrenceState = {
  task_id: task.id,
  occurrence_date: task.due_date,
  successor_task_id: null,
  series: {
    id: uid(100),
    workspace_id: project.workspace_id,
    project_id: project.id,
    version: 1,
    rule: daily,
    anchor_date: task.due_date!,
    state: 'active',
    reason: null,
    current_task_id: task.id,
    current_task_created_at: task.created_at,
    current_occurrence_date: task.due_date!,
  },
};

function recurrence(state: RecurrenceState = noRecurrence): RecurrenceApi {
  return {
    scopeKey: ['recurrence', project.owner_id, project.workspace_id, 'acl-1'],
    state: vi.fn().mockResolvedValue(state),
    summaries: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue(configured),
  };
}
function management(): WorkManagementApi {
  return {
    scopeKey: ['work', project.owner_id, project.workspace_id, 'acl-1'],
    createProject: vi.fn(),
    updateProject: vi.fn(),
    duplicateProject: vi.fn(),
    updateTaskDetails: vi.fn(),
    duplicateTask: vi.fn(),
    moveTask: vi.fn(),
    archiveTask: vi.fn(),
  };
}
function fixture(overrides: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return summaryProps({
    currentUserId: project.owner_id,
    workspace: { id: project.workspace_id, owner_id: project.owner_id, kind: 'team', name: 'Synthetic recurrence QA', version: 1, permissions: [] },
    projects: [project],
    tasks: [task],
    members: [],
    workManagement: management(),
    recurrence: recurrence(),
    ...overrides,
  });
}
function mount(data: WorkspaceProps, path = `/projects/${project.id}?workspace=${project.workspace_id}&task=${task.id}`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = (value: WorkspaceProps) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Workspace {...value} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const rendered = render(view(data));
  return { ...rendered, update: (next: WorkspaceProps) => rendered.rerender(view(next)) };
}

describe('recurrence inside the authorized task detail', () => {
  it('keeps recurrence display metadata out of the existing bulk mutation contract', async () => {
    const user = userEvent.setup();
    const bulkTasks: BulkTasksApi = {
      scopeKey: ['bulk', project.owner_id, project.workspace_id],
      apply: vi.fn<BulkTasksApi['apply']>(async (_operation, items, request) => ({
        request_id: request.id,
        results: items.map(item => ({ id: item.id, outcome: 'applied', code: null })),
      })),
    };
    const data = fixture({
      tasks: [{ ...task, recurrence: { series_id: uid(100), task_id: task.id, frequency: 'daily', interval: 1, state: 'active' } }],
      bulkTasks,
    });
    mount(data, `/tasks?workspace=${project.workspace_id}&view=table`);
    expect(screen.getByTitle('Repetición activa')).toHaveTextContent('Diaria');
    await user.click(screen.getByRole('checkbox', { name: `Seleccionar ${task.title}` }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Nuevo estado' }), 'done');
    await user.click(screen.getByRole('button', { name: 'Revisar acción' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Cambiar estado' })).getByRole('button', { name: 'Confirmar acción' }));
    await waitFor(() => expect(bulkTasks.apply).toHaveBeenCalledOnce());
    expect(bulkTasks.apply).toHaveBeenCalledWith(
      { kind: 'status', status: 'done' },
      [{ id: task.id, project_id: project.id, version: task.version }],
      expect.any(Object),
    );
    expect(data.recurrence!.save).not.toHaveBeenCalled();
  });

  it('loads the selected task only and saves its recurrence independently from task and project edits', async () => {
    const user = userEvent.setup();
    const data = fixture();
    mount(data);
    const panel = await screen.findByRole('region', { name: 'Repetición de la tarea' });
    await user.click(await within(panel).findByRole('button', { name: 'Configurar repetición' }));
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Frecuencia de repetición' }), 'monthly');
    await user.click(within(panel).getByRole('button', { name: 'Guardar repetición' }));
    await waitFor(() => expect(data.recurrence!.save).toHaveBeenCalledOnce());
    expect(data.recurrence!.state).toHaveBeenCalledWith(task, expect.any(AbortSignal));
    expect(data.recurrence!.save).toHaveBeenCalledWith(
      task,
      null,
      expect.objectContaining({ frequency: 'monthly', interval: 1, weekdays: [], until_date: null }),
      expect.any(String),
    );
    expect(data.onUpdateTask).not.toHaveBeenCalled();
    expect(data.onCreateTask).not.toHaveBeenCalled();
    expect(data.onUpdateProject).not.toHaveBeenCalled();
    expect(data.workManagement!.updateTaskDetails).not.toHaveBeenCalled();
  });

  it('can show a series to a project reader without granting configuration or task mutation', async () => {
    const permissions = ['project.read', 'task.read'];
    const data = fixture({
      currentUserId: uid(3),
      recurrence: recurrence(configured),
      workspace: { id: project.workspace_id, owner_id: project.owner_id, kind: 'team', name: 'Synthetic recurrence QA', version: 1, permissions },
      capabilities: { [project.id]: { project_id: project.id, access_level: 'read', permissions } },
    });
    mount(data);
    const panel = await screen.findByRole('region', { name: 'Repetición de la tarea' });
    expect(await within(panel).findByText('Diaria')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Editar repetición' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Pausar repetición' })).not.toBeInTheDocument();
    expect(data.recurrence!.save).not.toHaveBeenCalled();
    expect(data.onUpdateTask).not.toHaveBeenCalled();
  });

  it('does not expose or fetch recurrence for a stale task after project reading access is removed', () => {
    const data = fixture({
      currentUserId: uid(3),
      capabilities: {},
      workspace: {
        id: project.workspace_id,
        owner_id: project.owner_id,
        kind: 'team',
        name: 'Synthetic recurrence QA',
        version: 1,
        permissions: ['project.read', 'task.read'],
      },
    });
    mount(data);
    expect(screen.queryByRole('region', { name: 'Repetición de la tarea' })).not.toBeInTheDocument();
    expect(data.recurrence!.state).not.toHaveBeenCalled();
    expect(data.recurrence!.save).not.toHaveBeenCalled();
  });

  it('replaces a recurrence draft when the authorization scope changes and ignores the retired response', async () => {
    const user = userEvent.setup();
    const retired = recurrence();
    let finish: ((value: RecurrenceState) => void) | undefined;
    retired.save = vi.fn().mockImplementation(
      () =>
        new Promise<RecurrenceState>(resolve => {
          finish = resolve;
        }),
    );
    const data = fixture({ recurrence: retired });
    const view = mount(data);
    const panel = await screen.findByRole('region', { name: 'Repetición de la tarea' });
    await user.click(await within(panel).findByRole('button', { name: 'Configurar repetición' }));
    await user.click(within(panel).getByRole('button', { name: 'Guardar repetición' }));
    await waitFor(() => expect(retired.save).toHaveBeenCalledOnce());
    const next = recurrence();
    next.scopeKey = [...retired.scopeKey.slice(0, -1), 'acl-2'];
    view.update({ ...data, recurrence: next });
    expect(await screen.findByRole('button', { name: 'Configurar repetición' })).toBeInTheDocument();
    finish?.(configured);
    await waitFor(() => expect(next.state).toHaveBeenCalledOnce());
    expect(screen.queryByText('Repetición guardada.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar repetición' })).not.toBeInTheDocument();
    expect(next.save).not.toHaveBeenCalled();
  });
});
