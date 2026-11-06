import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { NotesApi } from '../notes-types';
import type { WorkspaceProps } from '../types';
import Workspace from './Workspace';
import { summaryProject, summaryProps } from './summary-test-fixtures';

function notesApi(scope: string): NotesApi {
  return {
    scopeKey: ['notes', scope],
    list: vi.fn().mockResolvedValue({ notes: [], has_more: false }),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  };
}

function mount(props: WorkspaceProps, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (next: WorkspaceProps) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Workspace {...next} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree(props));
  return { switchScope: (next: WorkspaceProps) => view.rerender(tree(next)) };
}

describe('Notas integradas al espacio y al proyecto', () => {
  it('usa la API del espacio seleccionado sin confundir las notas personales y de equipo', async () => {
    const user = userEvent.setup();
    const team = notesApi('team');
    const personal = notesApi('personal');
    const props = summaryProps({ notes: team });
    const { switchScope } = mount(props, '/');
    expect(team.list).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('complementary')).getByRole('link', { name: 'Notas' }));
    await waitFor(() => expect(team.list).toHaveBeenCalledWith(null, { archived: false, query: '', offset: 0 }, expect.any(AbortSignal)));
    expect(personal.list).not.toHaveBeenCalled();

    switchScope({
      ...props,
      workspace: { ...props.workspace!, id: 'personal-space', name: 'Mi espacio personal', kind: 'personal' },
      projects: [],
      tasks: [],
      notes: personal,
    });
    await waitFor(() => expect(personal.list).toHaveBeenCalledWith(null, { archived: false, query: '', offset: 0 }, expect.any(AbortSignal)));
    expect(team.list).toHaveBeenCalledTimes(1);
  });

  it('abre la vista de notas del proyecto sin mezclarla con las de su espacio', async () => {
    const user = userEvent.setup();
    const api = notesApi('project');
    mount(summaryProps({ notes: api }), `/projects/${summaryProject.id}`);
    expect(api.list).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Nueva tarea' })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Cambiar vista de tareas' }), 'notes');
    await waitFor(() => expect(api.list).toHaveBeenCalledWith(summaryProject.id, { archived: false, query: '', offset: 0 }, expect.any(AbortSignal)));
    expect(screen.queryByRole('button', { name: 'Nueva tarea' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: `Vistas de ${summaryProject.name}` })).getByRole('link', { name: 'Notas' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('evita consultar una URL de notas de proyecto sin permiso de lectura', () => {
    const api = notesApi('unavailable-project');
    mount(summaryProps({ notes: api, capabilities: {} }), `/projects/${summaryProject.id}?view=notes`);
    expect(screen.queryByRole('button', { name: 'Notas' })).not.toBeInTheDocument();
    expect(api.list).not.toHaveBeenCalled();
  });
});
