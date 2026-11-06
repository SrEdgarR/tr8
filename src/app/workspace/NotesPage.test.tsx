import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataError } from '../data/errors';
import type { Note, NotesApi } from '../notes-types';
import NotesPage from './NotesPage';

const original: Note = {
  id: 'note',
  workspace_id: 'workspace',
  project_id: null,
  title: 'Ideas',
  body: 'Texto de prueba',
  tags: ['café, azúcar'],
  pinned: false,
  archived_at: null,
  created_at: '2026-11-06T12:00:00Z',
  updated_at: '2026-11-06T12:00:00Z',
  version: 1,
  can_edit: true,
};

function fixture(initial: Note[] = [original]) {
  let notes = initial;
  const list = vi.fn<NotesApi['list']>().mockImplementation(async (_project, options) => ({
    notes: notes.filter(note => Boolean(note.archived_at) === options.archived && (!options.query || note.tags.includes(options.query))),
    has_more: false,
  }));
  const create = vi.fn<NotesApi['create']>().mockImplementation(async (_project, id, draft) => {
    const note = { ...original, ...draft, id };
    notes = [...notes, note];
    return note;
  });
  const update = vi.fn<NotesApi['update']>().mockImplementation(async (_project, previous, change) => {
    const { archived, ...content } = change;
    const note = { ...previous, ...content, archived_at: archived ? original.updated_at : null, version: previous.version + 1 };
    notes = notes.map(item => (item.id === note.id ? note : item));
    return note;
  });
  const remove = vi.fn<NotesApi['remove']>().mockImplementation(async (_project, note) => {
    notes = notes.filter(item => item.id !== note.id);
  });
  return { scopeKey: ['notes', 'workspace'], list, create, update, remove };
}

function mount(api = fixture(), canCreate = true) {
  const client = new QueryClient();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <NotesPage api={api} projectId={null} scopeLabel="Mi espacio personal" canCreate={canCreate} />
    </QueryClientProvider>,
  );
  return { client, user, api };
}

describe('Notas', () => {
  it('conserva el identificador en un reintento y muestra el contenido de la nota como texto', async () => {
    const { api, user } = mount(fixture([]));
    api.create.mockRejectedValueOnce(new Error('Problema de conexión.'));
    await user.click(await screen.findByRole('button', { name: 'Nueva nota' }));
    const dialog = within(screen.getByRole('dialog'));
    const body = '<img src=x onerror=alert(1)>';
    await user.type(dialog.getByRole('textbox', { name: 'Título' }), 'Apuntes');
    await user.type(dialog.getByRole('textbox', { name: 'Contenido' }), body);
    await user.type(dialog.getByRole('textbox', { name: /Etiquetas/ }), 'café, azúcar{Enter}');
    await user.click(dialog.getByRole('button', { name: 'Vista previa' }));
    expect(dialog.getByText(body)).toBeInTheDocument();
    expect(dialog.queryByRole('img')).not.toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Guardar nota' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('Problema de conexión');
    await user.click(dialog.getByRole('button', { name: 'Guardar nota' }));
    expect(await screen.findByRole('button', { name: 'Abrir nota Apuntes' })).toBeInTheDocument();
    expect(api.create.mock.calls[0]).toEqual(api.create.mock.calls[1]);
    expect(api.create.mock.calls[0]?.[2]).toEqual({ title: 'Apuntes', body, tags: ['café, azúcar'] });
  });

  it('fija, archiva, restaura y exige confirmación al eliminar definitivamente', async () => {
    const { api, user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Fijar nota Ideas' }));
    expect(await screen.findByRole('button', { name: 'Desfijar nota Ideas' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Archivar nota Ideas' }));
    expect(await screen.findByText('Todavía no hay notas')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Archivadas' }));
    await user.click(await screen.findByRole('button', { name: 'Restaurar nota Ideas' }));
    expect(await screen.findByText('Sin notas archivadas')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Activas' }));
    await user.click(await screen.findByRole('button', { name: 'Archivar nota Ideas' }));
    await user.click(screen.getByRole('button', { name: 'Archivadas' }));
    await user.click(await screen.findByRole('button', { name: 'Eliminar nota Ideas' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('button', { name: 'Eliminar definitivamente' })).toBeDisabled();
    expect(api.remove).not.toHaveBeenCalled();
    await user.type(dialog.getByRole('textbox', { name: /Escribe ELIMINAR/ }), 'ELIMINAR');
    await user.click(dialog.getByRole('button', { name: 'Eliminar definitivamente' }));
    expect(await screen.findByText('Sin notas archivadas')).toBeInTheDocument();
    expect(api.remove).toHaveBeenCalledWith(null, expect.objectContaining({ id: original.id, version: 5, archived_at: original.updated_at }));
  });

  it('mantiene el borrador tras un conflicto y lo cierra si se revoca el acceso', async () => {
    const { api, client, user } = mount();
    api.update.mockRejectedValueOnce(new DataError('Conflicto', 'PT409'));
    await user.click(await screen.findByRole('button', { name: 'Abrir nota Ideas' }));
    const dialog = within(screen.getByRole('dialog'));
    const title = dialog.getByRole('textbox', { name: 'Título' });
    await user.type(title, ' nuevas');
    await user.click(dialog.getByRole('button', { name: 'Guardar nota' }));
    expect(await dialog.findByText(/Conservamos tu borrador/)).toBeInTheDocument();
    expect(title).toHaveValue('Ideas nuevas');
    api.list.mockRejectedValue(new DataError('Acceso revocado.', '42501'));
    await act(() => client.invalidateQueries({ queryKey: api.scopeKey }));
    await screen.findByText('Acceso revocado.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Abrir nota Ideas' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nueva nota' })).not.toBeInTheDocument();
  });

  it('permite buscar y leer en un proyecto restringido sin ofrecer escrituras', async () => {
    const { api, user } = mount(fixture(), false);
    await user.type(await screen.findByRole('searchbox', { name: 'Buscar notas' }), 'café, azúcar');
    await waitFor(() => expect(api.list).toHaveBeenCalledWith(null, { archived: false, query: 'café, azúcar', offset: 0 }, expect.any(AbortSignal)));
    await user.click(await screen.findByRole('button', { name: 'Abrir nota Ideas' }));
    expect(screen.getByRole('dialog', { name: 'Ver nota' })).toHaveTextContent(original.body);
    expect(screen.queryByRole('button', { name: 'Guardar nota' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fijar nota Ideas' })).not.toBeInTheDocument();
  });
});
