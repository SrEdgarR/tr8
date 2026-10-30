import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarApi, CalendarItem, CalendarPreferences, Project, Task, WorkspaceSummary } from '../types';
import Calendar from './Calendar';
import CalendarSchedule from './CalendarSchedule';
import TaskForm from './TaskForm';
import { addCivilDays, addCivilMonths, dateInTimeZone, formatCivilDate, monthStart } from './CalendarTime';

const project: Project = {
  id: 'project-a',
  workspace_id: 'personal-a',
  owner_id: 'owner-a',
  code: 'A',
  name: 'Revista',
  description: '',
  color: '#5A67D8',
  status: 'active',
  archived_at: null,
  version: 1,
  created_at: '2026-10-23T12:00:00Z',
  updated_at: '2026-10-23T12:00:00Z',
};
const task: Task = {
  id: 'task-a',
  workspace_id: project.workspace_id,
  owner_id: project.owner_id,
  project_id: project.id,
  assignee_member_id: null,
  task_number: 14,
  title: 'Editar portada',
  description: 'Borrador original',
  status: 'todo',
  priority: 'high',
  start_date: null,
  due_date: '2026-10-23',
  position: 1,
  version: 4,
  created_at: '2026-10-23T12:00:00Z',
  updated_at: '2026-10-23T12:00:00Z',
  scheduled_start_at: null,
  scheduled_end_at: null,
  scheduled_time_zone: null,
};
const spaces: WorkspaceSummary[] = [
  { id: project.workspace_id, kind: 'personal', name: 'Personal', owner_id: project.owner_id, version: 1, permissions: ['project.read', 'task.read'] },
  { id: 'team-a', kind: 'team', name: 'Editorial', owner_id: project.owner_id, version: 1, permissions: ['project.read', 'task.read'] },
  { id: 'hidden-a', kind: 'team', name: 'Sin tareas', owner_id: 'other', version: 1, permissions: ['project.read'] },
];
const profile: CalendarPreferences = { time_zone: 'America/La_Paz', version: 1, updated_at: '2026-10-23T12:00:00Z' };
const item: CalendarItem = {
  id: 'task-a:due',
  kind: 'due',
  workspace_id: project.workspace_id,
  workspace_name: 'Personal',
  project_id: project.id,
  project_name: project.name,
  project_color: project.color,
  project_archived_at: null,
  task_id: task.id,
  title: task.title,
  status: task.status,
  priority: task.priority,
  version: task.version,
  assignee_member_id: null,
  assignee_name: null,
  start_date: null,
  due_date: task.due_date,
  scheduled_start_at: null,
  scheduled_end_at: null,
  scheduled_time_zone: null,
  date: task.due_date,
  start_at: null,
  end_at: null,
  can_edit: true,
};

function calendarApi(overrides: Partial<CalendarApi> = {}): CalendarApi {
  return {
    scopeKey: ['calendar-test', 'owner-a', 'revision-a'],
    profile: vi.fn().mockResolvedValue(profile),
    saveProfile: vi.fn().mockResolvedValue(profile),
    items: vi.fn().mockResolvedValue({ items: [item], next_cursor: null }),
    scheduleTask: vi.fn().mockImplementation((before, input) => Promise.resolve({ ...before, ...input, version: before.version + 1 })),
    ...overrides,
  };
}

function mount(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return { ...render(ui, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> }), client };
}

describe('calendario interno', () => {
  it('selecciona un día de la agenda móvil sin reprogramar ni volver a consultar sus tareas', async () => {
    const user = userEvent.setup();
    const month = monthStart(dateInTimeZone(new Date(), profile.time_zone!));
    const first = addCivilDays(month, 5),
      second = addCivilDays(month, 12);
    const firstItem = { ...item, date: first },
      secondItem = { ...item, id: 'another:due', task_id: 'another', title: 'Revisar el presupuesto', date: second };
    const api = calendarApi({ items: vi.fn().mockResolvedValue({ items: [firstItem, secondItem], next_cursor: null }) });
    const onOpen = vi.fn();
    mount(<Calendar api={api} workspaces={spaces} projects={[project]} onOpen={onOpen} />);
    const agenda = await screen.findByRole('region', { name: 'Agenda móvil del mes' });
    expect(within(agenda).getByText(secondItem.title)).toBeInTheDocument();
    const initialRequests = vi.mocked(api.items).mock.calls.length;
    await user.click(screen.getByRole('button', { name: `Ver el ${formatCivilDate(first)}, 1 elemento` }));
    expect(within(agenda).getByText(firstItem.title)).toBeInTheDocument();
    expect(within(agenda).queryByText(secondItem.title)).not.toBeInTheDocument();
    await user.click(within(agenda).getByRole('button', { name: /Vencimiento de Editar portada/ }));
    expect(onOpen).toHaveBeenCalledWith(firstItem);
    await user.click(within(agenda).getByRole('button', { name: 'Ver todo el mes' }));
    expect(within(agenda).getByText(secondItem.title)).toBeInTheDocument();
    expect(api.items).toHaveBeenCalledTimes(initialRequests);
    expect(api.scheduleTask).not.toHaveBeenCalled();
  });

  it('conserva los filtros del calendario al plegar sus opciones y devuelve el foco con Escape', async () => {
    const user = userEvent.setup();
    const api = calendarApi();
    mount(<Calendar api={api} workspaces={spaces} projects={[project]} onOpen={vi.fn()} />);
    const toggle = await screen.findByRole('button', { name: 'Filtros del calendario' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    await user.selectOptions(screen.getByLabelText('Estado'), 'done');
    await user.keyboard('{Escape}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
    await user.click(toggle);
    expect(screen.getByLabelText('Estado')).toHaveValue('done');
    expect(api.items).toHaveBeenLastCalledWith(expect.objectContaining({ statuses: ['done'] }), expect.any(AbortSignal));
    expect(api.scheduleTask).not.toHaveBeenCalled();
  });

  it('no afirma que un día está vacío mientras quedan páginas por cargar', async () => {
    const user = userEvent.setup();
    const month = monthStart(dateInTimeZone(new Date(), profile.time_zone!));
    const first = addCivilDays(month, 5),
      second = addCivilDays(month, 12);
    const secondItem = { ...item, id: 'later:due', task_id: 'later', title: 'Tarea de una página posterior', date: second };
    const items = vi
      .fn()
      .mockImplementation(query =>
        Promise.resolve(query.cursor ? { items: [secondItem], next_cursor: null } : { items: [{ ...item, date: first }], next_cursor: 'page-two' }),
      );
    const api = calendarApi({ items });
    mount(<Calendar api={api} workspaces={spaces} projects={[project]} onOpen={vi.fn()} />);
    const day = await screen.findByRole('button', { name: `Ver el ${formatCivilDate(second)}, 0 elementos cargados` });
    await user.click(day);
    const agenda = screen.getByRole('region', { name: 'Agenda móvil del mes' });
    expect(within(agenda).queryByText('No hay fechas para este día.')).not.toBeInTheDocument();
    expect(within(agenda).getByRole('status')).toHaveTextContent('Carga el resto del período para comprobarlo');
    await user.click(screen.getByRole('button', { name: 'Cargar más elementos' }));
    expect(await within(agenda).findByText(secondItem.title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Ver el ${formatCivilDate(second)}, 1 elemento` })).toHaveAttribute('aria-pressed', 'true');
    expect(items).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'page-two' }), expect.any(AbortSignal));
    expect(api.scheduleTask).not.toHaveBeenCalled();
  });

  it('detecta y guarda la zona del dispositivo antes de consultar fechas en el primer acceso', async () => {
    const detectedZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const api = calendarApi({
      profile: vi.fn().mockResolvedValue({ time_zone: null, version: 1, updated_at: null }),
      saveProfile: vi.fn().mockImplementation(zone => Promise.resolve({ time_zone: zone, version: 2, updated_at: null })),
    });
    mount(<Calendar api={api} workspaces={spaces} projects={[]} onOpen={vi.fn()} />);
    await waitFor(() => expect(api.items).toHaveBeenCalled());
    expect(api.saveProfile).toHaveBeenCalledExactlyOnceWith(detectedZone, 1);
    expect(api.items).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_ids: ['personal-a', 'team-a'], time_zone: detectedZone }),
      expect.any(AbortSignal),
    );
  });

  it('consulta ventana civil y páginas adicionales, manteniendo bloque y vencimiento diferenciados', async () => {
    const user = userEvent.setup();
    const day = new Date().toISOString().slice(0, 10);
    const block: CalendarItem = {
      ...item,
      id: 'task-a:block',
      kind: 'block',
      date: null,
      scheduled_start_at: `${day}T14:00:00Z`,
      scheduled_end_at: `${day}T15:00:00Z`,
      scheduled_time_zone: 'UTC',
      start_at: `${day}T14:00:00Z`,
      end_at: `${day}T15:00:00Z`,
    };
    const items = vi
      .fn()
      .mockImplementation(input =>
        Promise.resolve(input.cursor ? { items: [block], next_cursor: null } : { items: [{ ...item, date: day }], next_cursor: 'second-page' }),
      );
    const onOpen = vi.fn();
    mount(<Calendar api={calendarApi({ items })} workspaces={spaces} projects={[]} onOpen={onOpen} />);
    await screen.findByRole('button', { name: 'Cargar más elementos' });
    await user.click(screen.getByRole('button', { name: 'Agenda' }));
    await user.click(await screen.findByRole('button', { name: 'Cargar más elementos' }));
    expect(await screen.findByText('Bloque')).toBeInTheDocument();
    expect(screen.getByText('Vencimiento')).toBeInTheDocument();
    expect(items).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'second-page', limit: 100 }), expect.any(AbortSignal));
    const last = items.mock.calls.at(-1)![0];
    expect(Date.parse(last.date_to) - Date.parse(last.date_from)).toBeLessThanOrEqual(93 * 86400000);
    await user.click(screen.getAllByRole('button', { name: /Vencimiento de Editar portada/ })[0]);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ task_id: task.id, workspace_id: 'personal-a' }));
  });

  it('envía filtros al servidor y consulta Sin programar separadamente', async () => {
    const user = userEvent.setup();
    const api = calendarApi();
    mount(<Calendar api={api} workspaces={spaces} projects={[project]} onOpen={vi.fn()} />);
    await screen.findByRole('combobox', { name: 'Espacios del calendario' });
    await user.selectOptions(screen.getByLabelText('Espacios del calendario'), 'personal-a');
    await user.selectOptions(screen.getByLabelText('Proyecto'), project.id);
    await user.selectOptions(screen.getByLabelText('Estado'), 'done');
    await user.click(screen.getByLabelText('Solo mías'));
    await user.click(screen.getByLabelText('Incluir proyectos archivados'));
    await user.click(screen.getByRole('button', { name: 'Ver tareas sin programar' }));
    await waitFor(() =>
      expect(api.items).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_ids: ['personal-a'],
          project_ids: [project.id],
          statuses: ['done'],
          mine: true,
          include_archived: true,
          unscheduled: true,
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(screen.queryByRole('option', { name: 'Sin tareas' })).not.toBeInTheDocument();
  });

  it('oculta contenido anterior al fallar una actualización y al perder el acceso global', async () => {
    const user = userEvent.setup();
    const items = vi.fn().mockResolvedValue({ items: [{ ...item, date: new Date().toISOString().slice(0, 10) }], next_cursor: null });
    const api = calendarApi({ items });
    const { rerender } = mount(<Calendar api={api} workspaces={spaces} projects={[]} onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText(task.title).length).toBeGreaterThan(0));
    items.mockRejectedValue(new Error('Ya no tienes acceso'));
    await user.click(screen.getByRole('button', { name: 'Actualizar calendario' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ya no tienes acceso');
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    rerender(<Calendar api={{ ...api, accessError: 'Revisa tus espacios' }} workspaces={spaces} projects={[]} onOpen={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Revisa tus espacios');
    expect(screen.queryByLabelText('Proyecto')).not.toBeInTheDocument();
  });

  it('mantiene el proyecto fijo al cambiar el período dentro de un proyecto', async () => {
    const user = userEvent.setup();
    const api = calendarApi();
    mount(<Calendar api={api} project={project} workspaces={spaces} projects={[project]} onOpen={vi.fn()} />);
    await screen.findByRole('button', { name: 'Mes siguiente' });
    await user.click(screen.getByRole('button', { name: 'Mes siguiente' }));
    expect(api.items).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspace_ids: [project.workspace_id], project_ids: [project.id] }),
      expect.any(AbortSignal),
    );
    expect(screen.queryByLabelText('Espacios del calendario')).not.toBeInTheDocument();
  });

  it('explica que la próxima tarea del proyecto está en otro mes y permite abrirlo sin modificarla', async () => {
    const user = userEvent.setup();
    const currentMonth = monthStart(dateInTimeZone(new Date(), profile.time_zone!));
    const nextMonth = addCivilMonths(currentMonth, 1);
    const nextDate = addCivilDays(nextMonth, 1);
    const futureItem = { ...item, date: nextDate, due_date: nextDate };
    const items = vi
      .fn()
      .mockResolvedValueOnce({ items: [], next_cursor: null })
      .mockResolvedValue({ items: [futureItem], next_cursor: null });
    const api = calendarApi({ items });
    const onOpen = vi.fn();
    mount(<Calendar api={api} project={project} workspaces={spaces} projects={[project]} nextTaskDate={nextDate} onOpen={onOpen} />);
    const jump = await screen.findByRole('button', { name: `Ir a ${formatCivilDate(nextMonth, { month: 'long' })}` });
    expect(screen.getByRole('heading', { name: formatCivilDate(currentMonth, { month: 'long', year: 'numeric' }) })).toBeInTheDocument();
    expect(screen.getByLabelText('Próxima fecha del proyecto')).toHaveTextContent('está en otro mes');
    expect(screen.getByLabelText('Próxima fecha del proyecto')).toHaveTextContent(
      formatCivilDate(nextDate, { day: 'numeric', month: 'long', year: 'numeric' }),
    );
    await user.click(jump);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Vencimiento de Editar portada/ }).length).toBeGreaterThan(0));
    expect(items).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspace_ids: [project.workspace_id], project_ids: [project.id], time_zone: profile.time_zone, limit: 100 }),
      expect.any(AbortSignal),
    );
    expect(screen.getByRole('heading', { name: formatCivilDate(nextMonth, { month: 'long', year: 'numeric' }) })).toBeInTheDocument();
    expect(screen.queryByLabelText('Próxima fecha del proyecto')).not.toBeInTheDocument();
    expect(api.scheduleTask).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('no ofrece una fecha que contradiga filtros activos ni amplía la consulta para buscarla', async () => {
    const user = userEvent.setup();
    const nextDate = addCivilDays(addCivilMonths(monthStart(dateInTimeZone(new Date(), profile.time_zone!)), 1), 1);
    const api = calendarApi({ items: vi.fn().mockResolvedValue({ items: [], next_cursor: null }) });
    mount(<Calendar api={api} project={project} workspaces={spaces} projects={[project]} nextTaskDate={nextDate} onOpen={vi.fn()} />);
    await screen.findByLabelText('Próxima fecha del proyecto');
    await user.selectOptions(screen.getByLabelText('Estado'), 'done');
    expect(screen.queryByLabelText('Próxima fecha del proyecto')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(api.items).toHaveBeenLastCalledWith(expect.objectContaining({ project_ids: [project.id], statuses: ['done'] }), expect.any(AbortSignal)),
    );
    await user.selectOptions(screen.getByLabelText('Estado'), '');
    await screen.findByLabelText('Próxima fecha del proyecto');
    await user.click(screen.getByLabelText('Solo mías'));
    expect(screen.queryByLabelText('Próxima fecha del proyecto')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(api.items).toHaveBeenLastCalledWith(expect.objectContaining({ project_ids: [project.id], mine: true }), expect.any(AbortSignal)),
    );
    expect(api.scheduleTask).not.toHaveBeenCalled();
  });

  it.each(['not-a-date', '2026-02-30', null])('ignora una pista de fecha inválida o ausente: %s', async nextTaskDate => {
    const api = calendarApi({ items: vi.fn().mockResolvedValue({ items: [], next_cursor: null }) });
    mount(<Calendar api={api} project={project} workspaces={spaces} projects={[project]} nextTaskDate={nextTaskDate} onOpen={vi.fn()} />);
    await screen.findByText('Sin fechas en este período');
    expect(screen.queryByLabelText('Próxima fecha del proyecto')).not.toBeInTheDocument();
  });

  it('no muestra la pista del proyecto al fallar el acceso, en calendario general ni con páginas pendientes', async () => {
    const nextDate = addCivilDays(addCivilMonths(monthStart(dateInTimeZone(new Date(), profile.time_zone!)), 1), 1);
    const api = calendarApi({ items: vi.fn().mockResolvedValue({ items: [], next_cursor: 'more' }) });
    const { rerender } = mount(<Calendar api={api} project={project} workspaces={spaces} projects={[project]} nextTaskDate={nextDate} onOpen={vi.fn()} />);
    await screen.findByRole('button', { name: 'Cargar más elementos' });
    expect(screen.queryByLabelText('Próxima fecha del proyecto')).not.toBeInTheDocument();
    rerender(
      <Calendar
        api={{ ...api, accessError: 'Acceso retirado' }}
        project={project}
        workspaces={spaces}
        projects={[project]}
        nextTaskDate={nextDate}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Acceso retirado');
    expect(screen.queryByLabelText('Próxima fecha del proyecto')).not.toBeInTheDocument();
    rerender(
      <Calendar
        api={calendarApi({ items: vi.fn().mockResolvedValue({ items: [], next_cursor: null }) })}
        workspaces={spaces}
        projects={[project]}
        nextTaskDate={nextDate}
        onOpen={vi.fn()}
      />,
    );
    await screen.findByText('Sin fechas en este período');
    expect(screen.queryByLabelText('Próxima fecha del proyecto')).not.toBeInTheDocument();
  });
});

describe('programación independiente de tareas', () => {
  const scheduled: Task = { ...task, scheduled_start_at: '2026-10-24T14:00:30Z', scheduled_end_at: '2026-10-24T15:00:45Z', scheduled_time_zone: 'UTC' };

  it('cambia la zona conservando literalmente los instantes exactos, incluidos microsegundos', async () => {
    const user = userEvent.setup();
    const api = calendarApi();
    const onSaved = vi.fn();
    const precise = { ...scheduled, scheduled_start_at: '2026-10-24T14:00:30.123456Z', scheduled_end_at: '2026-10-24T15:00:45.654321Z' };
    mount(<CalendarSchedule task={precise} api={api} disabled={false} onSaved={onSaved} />);
    await user.clear(screen.getByLabelText('Zona del bloque'));
    await user.type(screen.getByLabelText('Zona del bloque'), 'America/La_Paz');
    await user.click(screen.getByRole('button', { name: 'Aplicar zona' }));
    expect(screen.getByLabelText('Inicio del bloque')).toHaveValue('2026-10-24T10:00');
    await user.click(screen.getByRole('button', { name: 'Guardar bloque horario' }));
    expect(api.scheduleTask).toHaveBeenCalledWith(precise, {
      scheduled_start_at: precise.scheduled_start_at,
      scheduled_end_at: precise.scheduled_end_at,
      scheduled_time_zone: 'America/La_Paz',
    });
    expect(onSaved).toHaveBeenCalledWith(precise, expect.objectContaining({ version: 5 }));
  });

  it('mueve el bloque conservando duración exacta y sin tocar vencimiento', async () => {
    const user = userEvent.setup();
    const api = calendarApi();
    mount(<CalendarSchedule task={scheduled} api={api} disabled={false} onSaved={vi.fn()} />);
    await user.click(screen.getByText('Mover el bloque conservando su duración'));
    fireEvent.change(screen.getByLabelText('Nuevo inicio del bloque'), { target: { value: '2026-11-01T05:30' } });
    await user.click(screen.getByRole('button', { name: 'Aplicar nuevo inicio' }));
    await user.click(screen.getByRole('button', { name: 'Guardar bloque horario' }));
    expect(api.scheduleTask).toHaveBeenCalledWith(scheduled, {
      scheduled_start_at: '2026-11-01T05:30:00.000Z',
      scheduled_end_at: '2026-11-01T06:30:15.000Z',
      scheduled_time_zone: 'UTC',
    });
  });

  it('rechaza huecos DST y exige seleccionar una hora repetida antes de guardar', async () => {
    const user = userEvent.setup();
    const api = calendarApi();
    mount(<CalendarSchedule task={{ ...task, scheduled_time_zone: 'America/New_York' }} api={api} disabled={false} onSaved={vi.fn()} />);
    await user.click(screen.getByLabelText('Programar un bloque horario'));
    fireEvent.change(screen.getByLabelText('Inicio del bloque'), { target: { value: '2026-03-08T02:30' } });
    fireEvent.change(screen.getByLabelText('Fin del bloque'), { target: { value: '2026-03-08T04:00' } });
    await user.click(screen.getByRole('button', { name: 'Guardar bloque horario' }));
    expect(screen.getByRole('alert')).toHaveTextContent('no existe');
    expect(api.scheduleTask).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Inicio del bloque'), { target: { value: '2026-11-01T01:30' } });
    fireEvent.change(screen.getByLabelText('Fin del bloque'), { target: { value: '2026-11-01T03:00' } });
    await user.click(screen.getByRole('button', { name: 'Guardar bloque horario' }));
    expect(screen.getByRole('alert')).toHaveTextContent('desplazamiento');
    await user.selectOptions(screen.getByLabelText('Desplazamiento del inicio'), '2026-11-01T06:30:00.000Z');
    await user.click(screen.getByRole('button', { name: 'Guardar bloque horario' }));
    expect(api.scheduleTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scheduled_start_at: '2026-11-01T06:30:00.000Z', scheduled_end_at: '2026-11-01T08:00:00.000Z' }),
    );
  });

  it('conserva el borrador y la versión original si la tarea cambia externamente', async () => {
    const user = userEvent.setup();
    const api = calendarApi({ scheduleTask: vi.fn().mockRejectedValue(new Error('Conflicto de versión')) });
    const { rerender } = mount(<CalendarSchedule task={scheduled} api={api} disabled={false} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Fin del bloque'), { target: { value: '2026-10-24T16:00' } });
    rerender(<CalendarSchedule task={{ ...scheduled, title: 'Cambio remoto', version: 5 }} api={api} disabled={false} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('Fin del bloque')).toHaveValue('2026-10-24T16:00');
    await user.click(screen.getByRole('button', { name: 'Guardar bloque horario' }));
    expect(api.scheduleTask).toHaveBeenLastCalledWith(expect.objectContaining({ version: 4 }), expect.anything());
    expect(screen.getByRole('alert')).toHaveTextContent('Conflicto de versión');
    await user.click(screen.getByRole('button', { name: 'Revisé la tarea; usar la versión actual para el bloque' }));
    await user.click(screen.getByRole('button', { name: 'Guardar bloque horario' }));
    expect(api.scheduleTask).toHaveBeenLastCalledWith(expect.objectContaining({ version: 5 }), expect.anything());
  });

  it('guardar programación avanza versión del formulario conservando su borrador de contenido', async () => {
    const user = userEvent.setup();
    const api = calendarApi();
    const onUpdate = vi.fn().mockResolvedValue(task);
    const form = (live: Task) => (
      <TaskForm task={live} projects={[project]} calendar={api} pending={false} onCreate={vi.fn()} onUpdate={onUpdate} onDelete={vi.fn()} onClose={vi.fn()} />
    );
    const { rerender } = mount(form(scheduled));
    await user.clear(screen.getByLabelText('Título'));
    await user.type(screen.getByLabelText('Título'), 'Borrador sin guardar');
    fireEvent.change(screen.getByLabelText('Fin del bloque'), { target: { value: '2026-10-24T16:00' } });
    await user.click(screen.getByRole('button', { name: 'Guardar bloque horario' }));
    expect(await screen.findByText('Bloque horario guardado.')).toBeInTheDocument();
    rerender(form({ ...scheduled, version: 5, scheduled_end_at: '2026-10-24T16:00:00.000Z' }));
    expect(screen.queryByText(/La tarea cambió desde que abriste/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Título')).toHaveValue('Borrador sin guardar');
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: 5, scheduled_end_at: '2026-10-24T16:00:00.000Z' }),
      expect.objectContaining({ title: 'Borrador sin guardar', due_date: task.due_date }),
    );
  });

  it('revisar un cambio remoto para el bloque no acepta ese cambio para el borrador de contenido', async () => {
    const user = userEvent.setup();
    const api = calendarApi();
    const onUpdate = vi.fn().mockRejectedValue(new Error('Conflicto de contenido'));
    const form = (live: Task) => (
      <TaskForm task={live} projects={[project]} calendar={api} pending={false} onCreate={vi.fn()} onUpdate={onUpdate} onDelete={vi.fn()} onClose={vi.fn()} />
    );
    const { rerender } = mount(form(scheduled));
    await user.clear(screen.getByLabelText('Título'));
    await user.type(screen.getByLabelText('Título'), 'Mi borrador local');
    fireEvent.change(screen.getByLabelText('Fin del bloque'), { target: { value: '2026-10-24T16:00' } });
    const remote = { ...scheduled, title: 'Título remoto', version: 5 };
    rerender(form(remote));
    await user.click(screen.getByRole('button', { name: 'Revisé la tarea; usar la versión actual para el bloque' }));
    await user.click(screen.getByRole('button', { name: 'Guardar bloque horario' }));
    expect(await screen.findByText('Bloque horario guardado.')).toBeInTheDocument();
    expect(api.scheduleTask).toHaveBeenCalledWith(expect.objectContaining({ version: 5 }), expect.anything());
    rerender(form({ ...remote, version: 6, scheduled_end_at: '2026-10-24T16:00:00.000Z' }));
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ version: 4 }), expect.objectContaining({ title: 'Mi borrador local' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Conflicto de contenido');
    expect(screen.getByLabelText('Título')).toHaveValue('Mi borrador local');
  });

  it('un cambio remoto posterior al guardado horario conserva el conflicto de contenido', async () => {
    const user = userEvent.setup();
    const api = calendarApi();
    const onUpdate = vi.fn().mockRejectedValue(new Error('Conflicto posterior'));
    const form = (live: Task) => (
      <TaskForm task={live} projects={[project]} calendar={api} pending={false} onCreate={vi.fn()} onUpdate={onUpdate} onDelete={vi.fn()} onClose={vi.fn()} />
    );
    const { rerender } = mount(form(scheduled));
    await user.clear(screen.getByLabelText('Título'));
    await user.type(screen.getByLabelText('Título'), 'Contenido pendiente');
    fireEvent.change(screen.getByLabelText('Fin del bloque'), { target: { value: '2026-10-24T16:00' } });
    await user.click(screen.getByRole('button', { name: 'Guardar bloque horario' }));
    expect(await screen.findByText('Bloque horario guardado.')).toBeInTheDocument();
    rerender(form({ ...scheduled, title: 'Otra edición remota', version: 6, scheduled_end_at: '2026-10-24T16:00:00.000Z' }));
    expect(screen.getByText(/La tarea cambió desde que abriste el formulario/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ version: 5 }), expect.objectContaining({ title: 'Contenido pendiente' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Conflicto posterior');
  });

  it('quitar el bloque no borra el vencimiento ni los datos del formulario', async () => {
    const user = userEvent.setup();
    const api = calendarApi();
    const onUpdate = vi.fn().mockResolvedValue(task);
    mount(
      <TaskForm
        task={scheduled}
        projects={[project]}
        calendar={api}
        pending={false}
        onCreate={vi.fn()}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByLabelText('Programar un bloque horario'));
    await user.click(screen.getByRole('button', { name: 'Guardar bloque horario' }));
    expect(await screen.findByText('Bloque horario guardado.')).toBeInTheDocument();
    expect(api.scheduleTask).toHaveBeenCalledWith(scheduled, { scheduled_start_at: null, scheduled_end_at: null, scheduled_time_zone: null });
    expect(screen.getByLabelText('Vencimiento')).toHaveValue(task.due_date);
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: 5, due_date: task.due_date, scheduled_start_at: null }),
      expect.objectContaining({ title: task.title, due_date: task.due_date }),
    );
  });

  it('el permiso de asignar no permite programar ni editar el bloque', () => {
    const api = calendarApi();
    mount(
      <TaskForm
        task={scheduled}
        projects={[project]}
        calendar={api}
        readOnly
        canAssign
        pending={false}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const panel = screen.getByRole('region', { name: 'Programación de la tarea' });
    expect(within(panel).getByRole('button', { name: 'Guardar bloque horario' })).toBeDisabled();
    expect(within(panel).getByLabelText('Inicio del bloque')).toBeDisabled();
  });

  it('un borrador horario ambiguo no bloquea el guardado independiente del contenido', async () => {
    const user = userEvent.setup();
    const api = calendarApi();
    const onUpdate = vi.fn().mockResolvedValue(task);
    mount(
      <TaskForm
        task={{ ...task, scheduled_time_zone: 'America/New_York' }}
        projects={[project]}
        calendar={api}
        pending={false}
        onCreate={vi.fn()}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByLabelText('Programar un bloque horario'));
    fireEvent.change(screen.getByLabelText('Inicio del bloque'), { target: { value: '2026-11-01T01:30' } });
    fireEvent.change(screen.getByLabelText('Fin del bloque'), { target: { value: '2026-11-01T03:00' } });
    expect(screen.getByLabelText('Desplazamiento del inicio')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ version: task.version }), expect.objectContaining({ title: task.title }));
    expect(api.scheduleTask).not.toHaveBeenCalled();
  });
});
