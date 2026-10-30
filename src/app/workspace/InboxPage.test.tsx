import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommunicationApi, InboxNotification, InboxState } from '../communication-types';
import { DataError } from '../data/errors';
import InboxPage from './InboxPage';

afterEach(() => vi.unstubAllGlobals());

const notification: InboxNotification = {
  id: 'notice-a',
  workspace_id: 'workspace-a',
  project_id: 'project-a',
  task_id: 'task-a',
  comment_id: 'comment-a',
  kind: 'mention',
  actor_name: 'Ana',
  project_name: 'TR8',
  project_color: '#5A67D8',
  project_icon: 'globe',
  task_title: 'Revisar portada',
  created_at: '2026-10-28T12:00:00Z',
  read_at: null,
};
const assignment: InboxNotification = {
  ...notification,
  id: 'notice-b',
  task_id: 'task-b',
  comment_id: null,
  kind: 'assignment',
  task_title: 'Organizar ideas',
  actor_name: 'Edgar',
  read_at: '2026-10-28T12:01:00Z',
};
const commentNotice: InboxNotification = {
  ...notification,
  id: 'notice-c',
  task_id: 'task-c',
  kind: 'comment',
  task_title: 'Completar revisión',
  created_at: '2026-10-27T12:00:00Z',
};
function source(initial = [notification, assignment, commentNotice]): CommunicationApi {
  let rows = initial;
  return {
    scopeKey: ['communication', 'user-a', 'workspace-a', 'acl1'],
    thread: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    react: vi.fn(),
    inbox: vi.fn().mockImplementation(async () => ({ items: rows, unread_count: rows.filter(row => row.read_at === null).length })),
    setRead: vi.fn().mockImplementation(async (id: string, read: boolean) => {
      rows = rows.map(row => (row.id === id ? { ...row, read_at: read ? '2026-10-28T13:00:00Z' : null } : row));
    }),
    readAll: vi.fn().mockImplementation(async () => {
      rows = rows.map(row => ({ ...row, read_at: '2026-10-28T13:00:00Z' }));
    }),
    dismiss: vi.fn().mockImplementation(async (id: string) => {
      rows = rows.filter(row => row.id !== id);
    }),
  };
}
function provider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { client, wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
async function mount(api = source(), props: Partial<React.ComponentProps<typeof InboxPage>> = {}) {
  const supplied = provider();
  const open = vi.fn();
  const view = render(<InboxPage api={api} onOpenTask={open} {...props} />, { wrapper: supplied.wrapper });
  await waitFor(() => expect(api.inbox).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText('Cargando tus avisos…')).not.toBeInTheDocument());
  return { api, open, ...supplied, ...view };
}
describe('bandeja compartida de notificaciones internas', () => {
  it('opens only the tapped notice in a mobile dialog and restores focus without marking it read', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const { api, open } = await mount();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const row = within(screen.getByLabelText('Avisos del espacio')).getByRole('button', { name: /Revisar portada/ });
    await userEvent.click(row);
    const dialog = screen.getByRole('dialog', { name: 'Detalle del aviso' });
    expect(within(dialog).getByRole('heading', { name: notification.task_title })).toBeInTheDocument();
    expect(api.setRead).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cerrar ventana' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(row).toHaveFocus();
    expect(api.setRead).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  it('keeps a mobile notice error inside its dialog and preserves the explicit open action', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const api = source();
    vi.mocked(api.setRead).mockRejectedValue(new Error('No se pudo guardar el aviso.'));
    const { open } = await mount(api);
    await userEvent.click(within(screen.getByLabelText('Avisos del espacio')).getByRole('button', { name: /Revisar portada/ }));
    const dialog = screen.getByRole('dialog', { name: 'Detalle del aviso' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Abrir tarea y responder' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('No se pudo guardar el aviso.');
    expect(open).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Abrir tarea y responder' })).toBeEnabled();
    expect(api.update).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
  });
  it('returns to the selected row on desktop resize and removes the mobile dialog when access is lost', async () => {
    let listener = () => {};
    const media = {
      matches: true,
      addEventListener: vi.fn((_event: string, callback: () => void) => {
        listener = callback;
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(media));
    const api = source();
    const { client } = await mount(api);
    const row = within(screen.getByLabelText('Avisos del espacio')).getByRole('button', { name: /Revisar portada/ });
    await userEvent.click(row);
    expect(screen.getByRole('dialog', { name: 'Detalle del aviso' })).toBeInTheDocument();
    act(() => {
      media.matches = false;
      listener();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(row).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Detalle del aviso' })).toHaveTextContent(notification.task_title);
    act(() => {
      media.matches = true;
      listener();
    });
    expect(screen.getByRole('dialog', { name: 'Detalle del aviso' })).toBeInTheDocument();
    vi.mocked(api.inbox).mockRejectedValue(new DataError('Acceso retirado', 'PT404'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: api.scopeKey });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText(notification.task_title)).not.toBeInTheDocument();
    expect(api.setRead).not.toHaveBeenCalled();
  });
  it('muestra avisos reales, su contexto, iconos y detalle sin activar servicios externos', async () => {
    await mount();
    expect(screen.getByRole('heading', { name: 'Bandeja de entrada' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Detalle del aviso' })).toHaveTextContent(notification.task_title);
    expect(screen.getByLabelText('Avisos del espacio').querySelectorAll('.ci-row')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /Marcar todas como leídas/ })).toBeEnabled();
    expect(screen.getByText(/últimos 200 avisos/)).toBeInTheDocument();
  });
  it('filtra menciones, asignaciones, comentarios y solo no leídos', async () => {
    await mount();
    await userEvent.click(screen.getByRole('button', { name: 'Asignaciones 1' }));
    expect(screen.getByLabelText('Avisos del espacio').querySelectorAll('.ci-row')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Detalle del aviso' })).toHaveTextContent(assignment.task_title);
    await userEvent.click(screen.getByRole('checkbox', { name: /Solo no leídos/ }));
    expect(screen.getByRole('heading', { name: 'Todo al día' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Comentarios 1' }));
    expect(screen.getByRole('region', { name: 'Detalle del aviso' })).toHaveTextContent(commentNotice.task_title);
    await userEvent.click(screen.getByRole('button', { name: 'Menciones 1' }));
    expect(screen.getByRole('region', { name: 'Detalle del aviso' })).toHaveTextContent(notification.task_title);
  });
  it('marcar leído/no leído cambia el estado compartido con el badge', async () => {
    const { api, client } = await mount();
    await userEvent.click(screen.getByRole('button', { name: 'Marcar aviso como leído' }));
    await screen.findByText('Aviso marcado como leído.');
    expect(api.setRead).toHaveBeenCalledWith(notification.id, true);
    expect(client.getQueryData<InboxState>([...api.scopeKey, 'inbox'])?.unread_count).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: 'Marcar aviso como no leído' }));
    await screen.findByText('Aviso marcado como no leído.');
    expect(api.setRead).toHaveBeenLastCalledWith(notification.id, false);
    expect(client.getQueryData<InboxState>([...api.scopeKey, 'inbox'])?.unread_count).toBe(2);
  });
  it('abre la tarea para responder después de confirmar su aviso leído', async () => {
    const { api, open } = await mount();
    await userEvent.click(screen.getByRole('button', { name: 'Abrir tarea y responder' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(notification.task_id, notification.project_id));
    expect(api.setRead).toHaveBeenCalledWith(notification.id, true);
  });
  it('puede abrir avisos ya leídos sin generar otra escritura', async () => {
    const { api, open } = await mount(source([assignment]));
    await userEvent.click(screen.getByRole('button', { name: 'Abrir tarea y responder' }));
    expect(open).toHaveBeenCalledWith(assignment.task_id, assignment.project_id);
    expect(api.setRead).not.toHaveBeenCalled();
  });
  it('marca todas como leídas sin modificar tareas ni comentarios', async () => {
    const { api, client } = await mount();
    await userEvent.click(screen.getByRole('button', { name: 'Marcar todas como leídas' }));
    await screen.findByText('Todos los avisos disponibles están leídos.');
    expect(api.readAll).toHaveBeenCalledOnce();
    expect(client.getQueryData<InboxState>([...api.scopeKey, 'inbox'])?.unread_count).toBe(0);
    expect(api.update).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
  });
  it('retira únicamente el aviso elegido y conserva los demás', async () => {
    const { api } = await mount();
    await userEvent.click(screen.getByRole('button', { name: 'Retirar aviso' }));
    await screen.findByText('Aviso retirado. La tarea y sus comentarios se conservan.');
    expect(api.dismiss).toHaveBeenCalledWith(notification.id);
    expect(screen.getByLabelText('Avisos del espacio').querySelectorAll('.ci-row')).toHaveLength(2);
    expect(api.remove).not.toHaveBeenCalled();
  });
  it('la vista de notificaciones agrupa por día y usa la misma consulta de Inbox', async () => {
    const { api, client } = await mount(source(), { mode: 'notifications' });
    expect(screen.getByRole('heading', { name: 'Notificaciones' })).toBeInTheDocument();
    expect(screen.getByLabelText('Avisos del espacio').querySelectorAll('.ci-day')).toHaveLength(2);
    expect(client.getQueryData([...api.scopeKey, 'inbox'])).toBeDefined();
  });
  it('en lectura permite abrir tareas sin cambios de estados de avisos', async () => {
    const { api, open } = await mount(source(), { readOnly: true });
    expect(screen.getByRole('button', { name: 'Marcar todas como leídas' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Marcar aviso como leído' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retirar aviso' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Abrir tarea y responder' }));
    expect(open).toHaveBeenCalledWith(notification.task_id, notification.project_id);
    expect(api.setRead).not.toHaveBeenCalled();
  });
  it('muestra un estado vacío real sin datos de ejemplo', async () => {
    await mount(source([]));
    expect(screen.getByRole('heading', { name: 'Tu bandeja está al día' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Detalle del aviso' })).not.toBeInTheDocument();
  });
  it('retira títulos cacheados cuando la consulta pierde autorización', async () => {
    const api = source();
    await mount(api);
    vi.mocked(api.inbox).mockRejectedValue(new DataError('Sin acceso', '42501'));
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    await screen.findByRole('alert');
    expect(screen.queryByText(notification.task_title)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Detalle del aviso' })).not.toBeInTheDocument();
  });
  it('una operación denegada no abre la tarea y oculta la bandeja anterior', async () => {
    const api = source();
    vi.mocked(api.setRead).mockRejectedValue(new DataError('Sin acceso', '42501'));
    const { open } = await mount(api);
    await userEvent.click(screen.getByRole('button', { name: 'Abrir tarea y responder' }));
    await screen.findByText('Actualiza la bandeja para comprobar tu acceso.');
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByText(notification.task_title)).not.toBeInTheDocument();
  });
  it('el cambio de cuenta no conserva selección ni títulos del espacio anterior', async () => {
    const { rerender } = await mount();
    const next = source([]);
    next.scopeKey = ['communication', 'other-account'];
    rerender(<InboxPage api={next} onOpenTask={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Tu bandeja está al día' });
    expect(screen.queryByText(notification.task_title)).not.toBeInTheDocument();
  });
  it('un envío tardío no llama al abridor de tarea después de desmontar', async () => {
    const api = source();
    let resolve!: () => void;
    vi.mocked(api.setRead).mockReturnValue(
      new Promise<void>(done => {
        resolve = done;
      }),
    );
    const { unmount, open } = await mount(api);
    await userEvent.click(screen.getByRole('button', { name: 'Abrir tarea y responder' }));
    unmount();
    await act(async () => resolve());
    expect(open).not.toHaveBeenCalled();
  });
  it('no interpreta nombres o títulos de proyectos como HTML', async () => {
    const api = source([{ ...notification, task_title: '<script>run()</script>', actor_name: '<img src=x>' }]);
    const { container } = await mount(api);
    expect(screen.getAllByText('<script>run()</script>')).toHaveLength(2);
    expect(container.querySelector('script,img')).toBeNull();
  });
});
