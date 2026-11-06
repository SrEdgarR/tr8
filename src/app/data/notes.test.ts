import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { Note } from '../notes-types';
import { createNotesRepository } from './notes';

const workspaceId = 'c3f00000-0000-4000-8000-000000000001';
const projectId = 'c3f00000-0000-4000-8000-000000000002';
const noteId = 'c3f00000-0000-4000-8000-000000000003';
const timestamp = '2026-11-06T12:00:00+00:00';
const content = { title: 'Decisiones', body: '  Conserva la sangría.\n', tags: ['equipo'] };
const note: Note = {
  id: noteId,
  workspace_id: workspaceId,
  project_id: projectId,
  ...content,
  pinned: false,
  archived_at: null,
  created_at: timestamp,
  updated_at: timestamp,
  version: 2,
  can_edit: true,
};
const scope = { p_workspace_id: workspaceId, p_project_id: projectId };
const options = { query: '', archived: false, offset: 0 };

function setup(data: unknown, error: unknown = null) {
  const response = { data, error };
  const abortSignal = vi.fn().mockResolvedValue(response);
  const rpc = vi.fn().mockReturnValue(Object.assign(Promise.resolve(response), { abortSignal }));
  return { rpc, abortSignal, repository: createNotesRepository({ rpc } as unknown as SupabaseClient, workspaceId) };
}

describe('notes data adapter', () => {
  it('loads the exact scope and forwards paging, search and cancellation', async () => {
    const data = { notes: [{ ...note, project_id: null, can_edit: false }], has_more: false };
    const { repository, rpc, abortSignal } = setup(data);
    const { signal } = new AbortController();

    await expect(repository.list(null, { ...options, query: ' equipo ', offset: 30 }, signal)).resolves.toEqual(data);
    expect(rpc).toHaveBeenCalledWith('tr8_notes_list', {
      p_workspace_id: workspaceId,
      p_project_id: null,
      p_archived: false,
      p_query: 'equipo',
      p_offset: 30,
    });
    expect(abortSignal).toHaveBeenCalledWith(signal);
  });

  it.each([
    [{ ...note, workspace_id: projectId }],
    [{ ...note, project_id: null }],
    [{ ...note, archived_at: timestamp }],
    [{ ...note, version: 0 }],
    [note, note],
  ])('rejects a substituted, invalid or duplicate list response', async (...notes) => {
    const { repository } = setup({ notes, has_more: false });
    await expect(repository.list(projectId, options)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('reuses the caller ID for a create retry, keeping body whitespace and Unicode content', async () => {
    const title = '🗒'.repeat(120);
    const { repository, rpc } = setup({ ...note, title });
    const input = { ...content, title: ` ${title} `, tags: [' equipo '] };

    await expect(repository.create(projectId, noteId, input)).resolves.toMatchObject({ id: noteId, version: 2 });
    expect(rpc).toHaveBeenCalledWith('tr8_notes_create', {
      ...scope,
      p_id: noteId,
      p_title: title,
      p_body: content.body,
      p_tags: content.tags,
    });
  });

  it('sends the exact note version and desired state for updates', async () => {
    const updated = { ...note, version: 3, pinned: true, archived_at: timestamp };
    const { repository, rpc } = setup(updated);
    await expect(repository.update(projectId, note, { ...content, pinned: true, archived: true })).resolves.toEqual(updated);
    expect(rpc).toHaveBeenCalledWith('tr8_notes_update', {
      ...scope,
      p_id: noteId,
      p_version: 2,
      p_title: content.title,
      p_body: content.body,
      p_tags: content.tags,
      p_pinned: true,
      p_archived: true,
    });
  });

  it('keeps optimistic-write conflict and unexpected version errors distinct', async () => {
    const update = { ...content, pinned: false, archived: false };
    const rejected = setup(null, { code: 'PT409', message: 'stale' });
    await expect(rejected.repository.update(projectId, note, update)).rejects.toMatchObject({ code: 'PT409' });
    const stale = setup(note);
    await expect(stale.repository.update(projectId, note, update)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('deletes only an archived note in the selected scope and checks the void response', async () => {
    const { repository, rpc } = setup(null);
    const archived = { ...note, archived_at: timestamp };

    await expect(repository.remove(projectId, note)).rejects.toMatchObject({ code: '55000' });
    await expect(repository.remove(null, archived)).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();

    await expect(repository.remove(projectId, archived)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith('tr8_notes_delete', { ...scope, p_id: noteId, p_version: 2 });
    const unexpected = setup({ id: noteId, deleted: true });
    await expect(unexpected.repository.remove(projectId, archived)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });
});
