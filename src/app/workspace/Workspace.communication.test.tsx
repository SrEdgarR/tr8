import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { CommunicationApi, InboxNotification, TaskComment } from '../communication-types';
import type { WorkManagementApi } from '../work-management-types';
import type { WorkspaceProps } from '../types';
import { DataError } from '../data/errors';
import Workspace from './Workspace';
import { summaryProject, summaryProps, summaryTask } from './summary-test-fixtures';

const comment: TaskComment = {
  id: 'comment-integration',
  workspace_id: summaryProject.workspace_id,
  task_id: summaryTask.id,
  author_id: summaryProject.owner_id,
  author_name: 'Tú',
  body: 'Revisar los márgenes de la portada.',
  mentions: [],
  reactions: [],
  version: 1,
  sequence: 1,
  created_at: '2026-10-28T14:00:00Z',
  updated_at: '2026-10-28T14:00:00Z',
  can_edit: true,
  can_delete: true,
};
const notification: InboxNotification = {
  id: 'notice-integration',
  workspace_id: summaryProject.workspace_id,
  project_id: summaryProject.id,
  task_id: summaryTask.id,
  comment_id: comment.id,
  kind: 'mention',
  actor_name: 'Edición',
  project_name: summaryProject.name,
  project_color: summaryProject.color,
  project_icon: 'globe',
  task_title: summaryTask.title,
  created_at: '2026-10-28T14:00:00Z',
  read_at: null,
};
function communication(): CommunicationApi {
  let items = [notification];
  return {
    scopeKey: ['communication', 'integration', summaryProject.workspace_id],
    thread: vi.fn().mockResolvedValue({ items: [comment], next_before_id: null, participants: [] }),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    react: vi.fn(),
    inbox: vi.fn().mockImplementation(async () => ({ items, unread_count: items.filter(row => !row.read_at).length })),
    setRead: vi.fn().mockImplementation(async (id, read) => {
      items = items.map(row => (row.id === id ? { ...row, read_at: read ? '2026-10-28T14:05:00Z' : null } : row));
    }),
    readAll: vi.fn(),
    dismiss: vi.fn(),
  };
}
function work(): WorkManagementApi {
  return {
    scopeKey: ['work', 'integration'],
    createProject: vi.fn(),
    updateProject: vi.fn(),
    duplicateProject: vi.fn(),
    updateTaskDetails: vi.fn(),
    duplicateTask: vi.fn(),
    moveTask: vi.fn(),
    archiveTask: vi.fn(),
  };
}
function mount(props: WorkspaceProps, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrap = (data: WorkspaceProps) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Workspace {...data} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(wrap(props));
  return { ...result, client, replace: (next: WorkspaceProps) => result.rerender(wrap(next)) };
}

describe('comunicación integrada por cuenta y proyecto', () => {
  it('comparte una consulta entre badge y bandeja y abre la conversación correcta al responder', async () => {
    const user = userEvent.setup(),
      api = communication();
    mount(summaryProps({ communication: api, workManagement: work() }), `/inbox?workspace=${summaryProject.workspace_id}`);
    await screen.findByRole('button', { name: 'Abrir tarea y responder' });
    expect(api.inbox).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Notificaciones, 1 sin leer' })).toBeInTheDocument();
    expect(api.thread).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Abrir tarea y responder' }));
    // Opening the drawer mounts a lazy section before its thread query renders.
    // Wait for that whole UI boundary, including cold module loading on CI.
    await waitFor(
      () => {
        const dialog = screen.getByRole('dialog', { name: 'Detalle de tarea' });
        const conversation = within(dialog).getByRole('region', { name: 'Comentarios' });
        expect(api.thread).toHaveBeenCalledWith(summaryTask, null, expect.any(AbortSignal));
        expect(within(conversation).getByText(comment.body)).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    expect(api.setRead).toHaveBeenCalledWith(notification.id, true);
    expect(api.thread).toHaveBeenCalledWith(summaryTask, null, expect.any(AbortSignal));
    expect(screen.getByRole('dialog', { name: 'Detalle de tarea' })).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  }, 10000);
  it('navega entre bandeja y notificaciones con una única página y sin modificar las tareas', async () => {
    const user = userEvent.setup(),
      api = communication(),
      props = summaryProps({ communication: api });
    const result = mount(props, `/inbox?workspace=${summaryProject.workspace_id}`);
    await screen.findByRole('button', { name: 'Abrir tarea y responder' });
    const sidebar = screen.getByRole('complementary', { name: 'Navegación principal' });
    await user.click(within(sidebar).getByRole('link', { name: 'Notificaciones' }));
    await screen.findByRole('heading', { level: 1, name: 'Notificaciones' });
    expect(result.container.querySelectorAll('.ci-page')).toHaveLength(1);
    await user.click(within(sidebar).getByRole('link', { name: 'Bandeja de entrada 1 sin leer' }));
    await screen.findByRole('heading', { level: 1, name: 'Bandeja de entrada' });
    expect(result.container.querySelectorAll('.ci-page')).toHaveLength(1);
    expect(api.inbox).toHaveBeenCalledTimes(1);
    expect(props.onUpdateTask).not.toHaveBeenCalled();
  });
  it('retira avisos y enlaces de la interfaz en cuanto desaparece el acceso', async () => {
    const api = communication(),
      props = summaryProps({ communication: api });
    const result = mount(props, `/inbox?workspace=${summaryProject.workspace_id}`);
    await screen.findByRole('button', { name: 'Abrir tarea y responder' });
    result.replace({ ...props, accessUnavailable: true, capabilities: {}, projects: [], tasks: [] });
    expect(screen.queryByRole('button', { name: 'Abrir tarea y responder' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Notificaciones, 1 sin leer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Bandeja de entrada/ })).not.toBeInTheDocument();
  });
  it('no conserva el contador anterior cuando falla la actualización de acceso', async () => {
    const api = communication();
    const result = mount(summaryProps({ communication: api }), `/inbox?workspace=${summaryProject.workspace_id}`);
    await screen.findByRole('link', { name: 'Notificaciones, 1 sin leer' });
    vi.mocked(api.inbox).mockRejectedValue(new DataError('Acceso retirado', 'PT404'));
    await result.client.invalidateQueries({ queryKey: api.scopeKey });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Abrir tarea y responder' })).not.toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Notificaciones, 1 sin leer' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Notificaciones' })).toHaveLength(2);
  });
});
