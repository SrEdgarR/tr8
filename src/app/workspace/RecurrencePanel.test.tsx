import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarApi, Task } from '../types';
import type { RecurrenceApi, RecurrenceRule, RecurrenceSeries, RecurrenceState } from '../recurrence-types';
import type { WorkManagementApi } from '../work-management-types';
import RecurrencePanel from './RecurrencePanel';
import TaskDetail from './TaskDetail';
import TaskMetadata from './TaskMetadata';
import { summaryProject, summaryTask } from './summary-test-fixtures';

vi.mock('./TimeZonePicker', () => ({
  default: ({ label, value, onChange, disabled }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean }) => (
    <label>
      {label}
      <input aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} />
    </label>
  ),
}));

const task = { ...summaryTask, due_date: '2090-01-31' };
const rule: RecurrenceRule = { frequency: 'daily', interval: 1, weekdays: [], time_zone: 'America/Santo_Domingo', until_date: null };
const empty = (value: Task = task): RecurrenceState => ({ task_id: value.id, series: null, occurrence_date: null, successor_task_id: null });
function series(overrides: Partial<RecurrenceSeries> = {}): RecurrenceSeries {
  return {
    id: 'series-one',
    workspace_id: task.workspace_id,
    project_id: task.project_id,
    version: 4,
    rule,
    anchor_date: task.due_date,
    state: 'active',
    reason: null,
    current_task_id: task.id,
    current_task_created_at: task.created_at,
    current_occurrence_date: task.due_date,
    ...overrides,
  };
}
function existing(value: RecurrenceSeries = series()): RecurrenceState {
  return { task_id: task.id, series: value, occurrence_date: task.due_date, successor_task_id: null };
}
function api(initial: RecurrenceState = empty()): RecurrenceApi {
  return {
    scopeKey: ['recurrence', 'account-a', task.workspace_id, 'acl-a'],
    state: vi.fn().mockResolvedValue(initial),
    summaries: vi.fn().mockResolvedValue([]),
    save: vi
      .fn()
      .mockImplementation(async (_task: Task, _version: number | null, next: RecurrenceRule | null) =>
        existing(series({ rule: next ?? rule, state: next ? 'active' : 'paused' })),
      ),
  };
}
const makeClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
function renderPanel(value: RecurrenceApi, options: Partial<Parameters<typeof RecurrencePanel>[0]> = {}) {
  const client = makeClient();
  const props = { task, api: value, canEdit: true, canCreate: true, ...options };
  const tree = (overrides: Partial<typeof props> = {}) => (
    <QueryClientProvider client={client}>
      <RecurrencePanel {...props} {...overrides} />
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, client, rerenderPanel: (overrides: Partial<typeof props>) => view.rerender(tree(overrides)) };
}
async function configure() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Configurar repetición' }));
  return user;
}

describe('recurring task configuration', () => {
  it('saves a separate rule with the task identity, chosen zone, optional end and stable request ID', async () => {
    const value = api();
    const calendar = {
      scopeKey: ['calendar', 'account-a'],
      profile: vi.fn().mockResolvedValue({ time_zone: 'America/Santo_Domingo', version: 1, updated_at: null }),
    } as unknown as CalendarApi;
    renderPanel(value, { calendar });
    const user = await configure();
    expect(screen.getByRole('textbox', { name: 'Zona horaria de repetición' })).toHaveValue('America/Santo_Domingo');
    expect(screen.getByText('Cada 1 día')).toBeInTheDocument();
    await user.clear(screen.getByRole('spinbutton', { name: 'Intervalo de repetición' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Intervalo de repetición' }), '2');
    await user.click(screen.getByRole('checkbox', { name: 'Finalizar en una fecha' }));
    await user.clear(screen.getByLabelText('Última fecha de repetición'));
    await user.type(screen.getByLabelText('Última fecha de repetición'), '2090-02-28');
    await user.click(screen.getByRole('button', { name: 'Guardar repetición' }));
    await waitFor(() => expect(value.save).toHaveBeenCalledTimes(1));
    expect(value.save).toHaveBeenCalledWith(task, null, { ...rule, interval: 2, until_date: '2090-02-28' }, expect.stringMatching(/^[\da-f-]{36}$/));
    expect(await screen.findByText('Repetición guardada.')).toBeInTheDocument();
    expect(task.version).toBe(1);
  });

  it.each([
    { due_date: null, status: 'todo' as const, message: /Añade un vencimiento/ },
    { due_date: '2090-01-31', status: 'done' as const, message: /Configura la repetición en una tarea pendiente/ },
  ])('requires a pending task with a due date before the first rule ($status/$due_date)', async ({ due_date, status, message }) => {
    const value = api();
    renderPanel(value, { task: { ...task, due_date, status } });
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Configurar repetición' })).not.toBeInTheDocument();
    expect(value.save).not.toHaveBeenCalled();
  });

  it('lets the user select weekly weekdays and requires at least one', async () => {
    const value = api();
    renderPanel(value);
    const user = await configure();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Frecuencia de repetición' }), 'weekly');
    expect(screen.getByText('Cada 1 semana')).toBeInTheDocument();
    const selected = screen.getByRole('button', { pressed: true });
    await user.click(selected);
    expect(screen.getByRole('button', { name: 'Guardar repetición' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Repetir los lunes' }));
    await user.click(screen.getByRole('button', { name: 'Repetir los viernes' }));
    await user.clear(screen.getByRole('textbox', { name: 'Zona horaria de repetición' }));
    await user.type(screen.getByRole('textbox', { name: 'Zona horaria de repetición' }), 'America/Santo_Domingo');
    await user.click(screen.getByRole('button', { name: 'Guardar repetición' }));
    await waitFor(() => expect(value.save).toHaveBeenCalledWith(task, null, { ...rule, frequency: 'weekly', weekdays: [1, 5] }, expect.any(String)));
  });

  it('previews monthly dates from the original day and clamps short months', async () => {
    renderPanel(api());
    const user = await configure();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Frecuencia de repetición' }), 'monthly');
    expect(screen.getByText('Cada 1 mes')).toBeInTheDocument();
    expect(screen.getByText(/Día 31 de cada mes seleccionado/)).toBeInTheDocument();
    const preview = screen.getByLabelText('Próximas fechas estimadas');
    expect(within(preview).getByText('28 de febrero de 2090')).toBeInTheDocument();
    expect(within(preview).getByText('31 de marzo de 2090')).toBeInTheDocument();
    expect(within(preview).getByText('30 de abril de 2090')).toBeInTheDocument();
    expect(screen.getByText(/sin copiar bloques horarios/)).toBeInTheDocument();
  });

  it('cancels a local draft without contacting the write API', async () => {
    const value = api();
    renderPanel(value);
    const user = await configure();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Frecuencia de repetición' }), 'weekly');
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('combobox', { name: 'Frecuencia de repetición' })).not.toBeInTheDocument();
    expect(value.save).not.toHaveBeenCalled();
  });

  it('does not offer changes until a failed state read has been retried explicitly', async () => {
    const value = api();
    vi.mocked(value.state).mockRejectedValueOnce(new Error('No se pudo cargar la repetición.'));
    renderPanel(value);
    const user = userEvent.setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar');
    expect(screen.queryByRole('button', { name: 'Configurar repetición' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar repetición' }));
    expect(await screen.findByRole('button', { name: 'Configurar repetición' })).toBeInTheDocument();
    expect(value.state).toHaveBeenCalledTimes(2);
    expect(value.save).not.toHaveBeenCalled();
  });

  it('permits pausing with edit permission even when creation is not allowed', async () => {
    const value = api(existing());
    renderPanel(value, { canCreate: false });
    const user = userEvent.setup();
    expect(await screen.findByText(/necesitas permiso para crear tareas/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar repetición' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pausar repetición' }));
    await waitFor(() => expect(value.save).toHaveBeenCalledWith(task, 4, null, expect.any(String)));
    expect(await screen.findByText('Repetición pausada.')).toBeInTheDocument();
  });

  it.each([
    { options: { canEdit: false }, state: existing() },
    { options: { task: { ...task, archived_at: '2090-02-01T00:00:00Z' } }, state: existing() },
    { options: { disabled: true }, state: existing() },
    { options: {}, state: existing(series({ state: 'finished' })) },
    { options: {}, state: existing(series({ current_task_id: 'successor-task' })) },
  ])('keeps inaccessible, archived, finished and historical series read-only ($options/$state.series.state)', async ({ options, state }) => {
    const value = api(state);
    renderPanel(value, options);
    expect(await screen.findByText('Diaria')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar repetición' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pausar repetición' })).not.toBeInTheDocument();
    expect(value.save).not.toHaveBeenCalled();
  });

  it('allows a blocked, completed head to correct the rule and request generation again', async () => {
    const value = api(existing(series({ state: 'blocked', reason: 'author_permission' })));
    const completed = { ...task, status: 'done' as const };
    renderPanel(value, { task: completed });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Editar repetición' }));
    await user.click(screen.getByRole('button', { name: 'Guardar y reintentar' }));
    await waitFor(() => expect(value.save).toHaveBeenCalledWith(completed, 4, rule, expect.any(String)));
  });

  it('preserves the exact request after an ambiguous write, even if the task changes meanwhile', async () => {
    const value = api();
    vi.mocked(value.save).mockRejectedValueOnce(new Error('Network timeout'));
    const view = renderPanel(value);
    const user = await configure();
    await user.click(screen.getByRole('button', { name: 'Guardar repetición' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Puede haberse aplicado');
    expect(value.save).toHaveBeenCalledTimes(1);
    const first = vi.mocked(value.save).mock.calls[0];
    view.rerenderPanel({ task: { ...task, version: 2, title: 'Cambio desde otra pestaña' } });
    const retry = await screen.findByRole('button', { name: 'Reintentar el mismo guardado' });
    expect(screen.getByRole('combobox', { name: 'Frecuencia de repetición' })).toBeDisabled();
    await user.click(retry);
    await waitFor(() => expect(value.save).toHaveBeenCalledTimes(2));
    expect(vi.mocked(value.save).mock.calls[1]).toEqual(first);
    expect(first[0].version).toBe(1);
    expect(await screen.findByText('Repetición guardada.')).toBeInTheDocument();
  });

  it('blocks a new payload when the task changes while a normal draft is open', async () => {
    const value = api();
    const view = renderPanel(value);
    await configure();
    view.rerenderPanel({ task: { ...task, version: 2 } });
    expect(await screen.findByText(/Tu borrador sigue aquí/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardar repetición' })).toBeDisabled();
    expect(value.save).not.toHaveBeenCalled();
  });

  it('retains an ambiguous pause while collapsed and reuses its original request when resumed', async () => {
    const value = api(existing());
    vi.mocked(value.save).mockRejectedValueOnce(new Error('No pudimos confirmar la pausa.'));
    renderPanel(value);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Pausar repetición' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Puede haberse aplicado');
    const first = vi.mocked(value.save).mock.calls[0];
    expect(screen.queryByRole('button', { name: 'Editar repetición' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retomar guardado' }));
    await user.click(screen.getByRole('button', { name: 'Comprobar más tarde' }));
    await user.click(screen.getByRole('button', { name: 'Retomar guardado' }));
    await user.click(screen.getByRole('button', { name: 'Reintentar el mismo guardado' }));
    await waitFor(() => expect(value.save).toHaveBeenCalledTimes(2));
    expect(vi.mocked(value.save).mock.calls[1]).toEqual(first);
    expect(first[2]).toBeNull();
    expect(await screen.findByText('Repetición pausada.')).toBeInTheDocument();
  });

  it('does not duplicate a write on a rapid double click in StrictMode', async () => {
    const value = api();
    let finish!: (state: RecurrenceState) => void;
    vi.mocked(value.save).mockReturnValueOnce(new Promise(resolve => (finish = resolve)));
    const client = makeClient();
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <RecurrencePanel task={task} api={value} canEdit canCreate />
        </QueryClientProvider>
      </StrictMode>,
    );
    const user = await configure();
    await user.dblClick(screen.getByRole('button', { name: 'Guardar repetición' }));
    expect(value.save).toHaveBeenCalledTimes(1);
    await act(async () => finish(existing()));
    expect(await screen.findByText('Repetición guardada.')).toBeInTheDocument();
  });

  it('does not replace an unsaved metadata draft when the independent recurrence saves', async () => {
    const value = api();
    const metadata = { scopeKey: ['metadata'], updateTaskDetails: vi.fn() } as unknown as WorkManagementApi;
    const client = makeClient();
    render(
      <QueryClientProvider client={client}>
        <TaskDetail
          task={{ ...task, labels: ['Diseño'] }}
          projects={[summaryProject]}
          pending={false}
          api={metadata}
          recurrence={value}
          recurrenceCanCreate
          onUpdate={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Nueva etiqueta' }), 'Borrador{Enter}');
    await user.type(screen.getByRole('textbox', { name: 'Nueva subtarea' }), 'Texto todavía sin añadir');
    await user.click(await screen.findByRole('button', { name: 'Configurar repetición' }));
    await user.click(screen.getByRole('button', { name: 'Guardar repetición' }));
    expect(await screen.findByText('Repetición guardada.')).toBeInTheDocument();
    expect(screen.getByText('Borrador')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Nueva subtarea' })).toHaveValue('Texto todavía sin añadir');
    expect(metadata.updateTaskDetails).not.toHaveBeenCalled();
  });

  it('shows a recurrence indicator in shared task metadata without adding occurrences', () => {
    render(<TaskMetadata task={{ ...task, recurrence: { series_id: 'series-one', task_id: task.id, frequency: 'weekly', interval: 2, state: 'active' } }} />);
    expect(screen.getByTitle('Repetición activa')).toHaveTextContent('Semanal · 2');
  });
});
