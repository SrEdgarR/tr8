import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { GlobalSearchApi, GlobalSearchResult } from '../search-types';
import type { WorkspaceProps } from '../types';
import Workspace from './Workspace';
import { summaryProject, summaryProps, summaryTask } from './summary-test-fixtures';

const base: GlobalSearchResult = {
  id: summaryTask.id,
  kind: 'task',
  workspace_id: summaryProject.workspace_id,
  project_id: summaryProject.id,
  task_id: summaryTask.id,
  title: summaryTask.title,
  snippet: 'Márgenes y tipografía',
  project_name: summaryProject.name,
  project_color: summaryProject.color,
  project_icon: 'globe',
  status: 'todo',
  priority: 'urgent',
  content_type: null,
  member_id: null,
  author_name: null,
  updated_at: '2026-10-28T12:00:00Z',
  archived: false,
};
function api(rows = [base]): GlobalSearchApi {
  return {
    scopeKey: ['search', 'integration', summaryProject.workspace_id],
    search: vi.fn().mockImplementation(async input => ({
      workspace_id: summaryProject.workspace_id,
      query: input.query,
      kind: input.kind,
      include_archived: input.include_archived,
      items: rows.filter(row => input.kind === 'all' || row.kind === input.kind),
      counts: {
        project: 0,
        task: rows.filter(row => row.kind === 'task').length,
        member: rows.filter(row => row.kind === 'member').length,
        file: rows.filter(row => row.kind === 'file').length,
        comment: rows.filter(row => row.kind === 'comment').length,
      },
      next_offset: null,
    })),
  };
}
function Location() {
  const location = useLocation();
  return (
    <output aria-label="Ruta actual">
      {location.pathname}
      {location.search}
    </output>
  );
}
function mount(props: WorkspaceProps, path = `/projects?workspace=${summaryProject.workspace_id}`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = (data: WorkspaceProps) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Workspace {...data} />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(wrapper(props));
  return { ...view, replace: (next: WorkspaceProps) => view.rerender(wrapper(next)) };
}
async function searchFor(text = 'portada') {
  await userEvent.click(screen.getByRole('button', { name: 'Buscar o ir a…' }));
  await userEvent.type(screen.getByRole('combobox', { name: 'Buscar en TR8' }), text);
  return await screen.findByRole('option', { name: new RegExp(summaryTask.title) });
}

describe('búsqueda y atajos integrados de TR8', () => {
  it('abre con CtrlK y CmdK sin consultar hasta escribir y restaura el foco con Escape', async () => {
    const source = api();
    mount(summaryProps({ globalSearch: source }));
    const trigger = screen.getByRole('button', { name: 'Buscar o ir a…' });
    trigger.focus();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'Buscar en TR8' })).toBeInTheDocument();
    expect(source.search).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Buscar en TR8' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog', { name: 'Buscar en TR8' })).toBeInTheDocument();
  });
  it('abre una tarea conservando espacio y proyecto y no modifica datos', async () => {
    const source = api(),
      props = summaryProps({ globalSearch: source });
    mount(props);
    await userEvent.click(await searchFor());
    expect(screen.getByLabelText('Ruta actual')).toHaveTextContent(
      `/projects/${summaryProject.id}?workspace=${summaryProject.workspace_id}&task=${summaryTask.id}`,
    );
    expect(props.onRetry).toHaveBeenCalled();
    expect(props.onUpdateTask).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Buscar en TR8' })).not.toBeInTheDocument();
  });
  it('abre un comentario con ancla exacta y un archivo en su pestaña sin descargarlos', async () => {
    const source = api([
      { ...base, id: 'comment-search', kind: 'comment', priority: null, author_name: 'Tú' },
      { ...base, id: 'file-search', kind: 'file', task_id: null, status: 'ready', priority: null, content_type: 'application/pdf' },
    ]);
    mount(summaryProps({ globalSearch: source }));
    await userEvent.click(screen.getByRole('button', { name: 'Buscar o ir a…' }));
    await userEvent.type(screen.getByRole('combobox', { name: 'Buscar en TR8' }), 'portada');
    const options = await screen.findAllByRole('option', { name: new RegExp(summaryTask.title) });
    await userEvent.click(options.find(row => row.id.includes('comment-'))!);
    expect(screen.getByLabelText('Ruta actual')).toHaveTextContent('comment=comment-search');
    await userEvent.click(screen.getByRole('button', { name: 'Buscar o ir a…' }));
    await userEvent.type(screen.getByRole('combobox', { name: 'Buscar en TR8' }), 'portada');
    const files = await screen.findAllByRole('option', { name: new RegExp(summaryTask.title) });
    await userEvent.click(files.find(row => row.id.includes('file-'))!);
    expect(screen.getByLabelText('Ruta actual')).toHaveTextContent('view=files&file=file-search');
  });
  it('lleva a la página completa sin colocar la consulta en la URL', async () => {
    mount(summaryProps({ globalSearch: api() }));
    await searchFor();
    await userEvent.click(screen.getByRole('button', { name: 'Ver todos los resultados' }));
    await screen.findByRole('region', { name: 'Búsqueda global' });
    expect(screen.getByRole('combobox', { name: 'Buscar en TR8' })).toHaveValue('portada');
    expect(screen.getByLabelText('Ruta actual')).toHaveTextContent(`/search?workspace=${summaryProject.workspace_id}`);
    expect(screen.getByLabelText('Ruta actual')).not.toHaveTextContent('portada');
  });
  it('no dispara atajos dentro de formularios ni abre otra ventana sobre un modal', async () => {
    const source = api();
    mount(summaryProps({ globalSearch: source }));
    const input = screen.getByRole('searchbox', { name: 'Buscar proyectos' });
    await userEvent.type(input, 'np/?g h');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'p' });
    expect(screen.getByRole('dialog', { name: 'Nuevo proyecto' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(source.search).not.toHaveBeenCalled();
  });
  it('navega con G P y ofrece guía de atajos sin recargar la aplicación', async () => {
    mount(summaryProps({ globalSearch: api() }), `/?workspace=${summaryProject.workspace_id}`);
    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'p' });
    expect(screen.getByLabelText('Ruta actual')).toHaveTextContent(`/projects?workspace=${summaryProject.workspace_id}`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: 'Atajos de teclado' }));
    expect(screen.getByRole('dialog', { name: 'Atajos de teclado' })).toHaveTextContent('Ctrl / ⌘ K');
  });
  it('retira la paleta inmediatamente al perder acceso y no deja comandos de escritura a lectores', async () => {
    const source = api(),
      props = summaryProps({ globalSearch: source, readOnly: true });
    const view = mount(props);
    await userEvent.click(screen.getByRole('button', { name: 'Buscar o ir a…' }));
    expect(screen.queryByRole('option', { name: /Crear proyecto/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Crear tarea/ })).not.toBeInTheDocument();
    view.replace({ ...props, accessUnavailable: true });
    expect(screen.queryByRole('dialog', { name: 'Buscar en TR8' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Buscar o ir a…' })).not.toBeInTheDocument();
  });
  it('no muestra nombres anteriores después de cambiar el ámbito de permisos', async () => {
    const source = api(),
      props = summaryProps({ globalSearch: source });
    const view = mount(props);
    await searchFor();
    await act(async () => view.replace({ ...props, globalSearch: { ...api([]), scopeKey: ['search', 'integration', 'acl-next'] } }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Buscar en TR8' })).not.toBeInTheDocument());
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('combobox', { name: 'Buscar en TR8' })).toHaveValue('');
    expect(screen.queryByRole('option', { name: new RegExp(summaryTask.title) })).not.toBeInTheDocument();
  });
});
