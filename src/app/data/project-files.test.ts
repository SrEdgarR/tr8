import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';
import { FILE_MAX_BYTES, PROJECT_FILES_MAX_BYTES, type ProjectFile } from '../project-files-types';
import { createProjectFilesRepository, validateProjectFile, validateProjectFileName } from './project-files';

const uid = (n: number) => `f9600000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspace = uid(1),
  projectId = uid(2),
  fileId = uid(3);
const project = { id: projectId, workspace_id: workspace, version: 1 } as Project;
const bytes = new Uint8Array([1, 2, 3]);
const file = () => new File([bytes], 'Entrega.pdf', { type: 'application/pdf' });
const row: ProjectFile = {
  id: fileId,
  workspace_id: workspace,
  project_id: projectId,
  name: 'Entrega.pdf',
  content_type: 'application/pdf',
  size: bytes.length,
  status: 'ready',
  object_path: `${workspace}/${projectId}/${fileId}`,
  version: 2,
  created_by: uid(4),
  created_at: '2026-10-28T12:00:00Z',
};
const reservation = { ...row, status: 'pending' as const, version: 1 };
const ticket = { ...row, status: 'deleting' as const, version: 3 };
const listing = { items: [row], used_bytes: row.size, max_bytes: PROJECT_FILES_MAX_BYTES, max_file_bytes: FILE_MAX_BYTES, max_files: 100 };
function setup() {
  let uploaded = false;
  const response = (data: unknown, error: unknown = null) => ({ data, error });
  const handler = vi.fn((action: string): { data: unknown; error: unknown } => {
    if (action === 'reserve') return response(reservation);
    if (action === 'complete') return uploaded ? response(row) : response(null, { code: '55000' });
    if (action === 'list') return response(listing);
    if (action === 'begin_delete') return response(ticket);
    if (action === 'finish_delete') return response({ id: fileId, deleted: true });
    return response({ ...row, name: 'Renombrado.pdf', version: 3 });
  });
  const rpc = vi.fn((_name: string, args: { p_action: string; p_input: Record<string, unknown> }) => Promise.resolve(handler(args.p_action)));
  const upload = vi.fn(async () => {
    uploaded = true;
    return response({ path: row.object_path });
  });
  const download = vi.fn(async () => response(new Blob([bytes], { type: row.content_type })));
  const remove = vi.fn(async () => response([{ name: row.object_path }]));
  const from = vi.fn(() => ({ upload, download, remove }));
  const client = { rpc, storage: { from } } as unknown as SupabaseClient;
  return { repository: createProjectFilesRepository(client, workspace), rpc, handler, upload, download, remove, from, client, response };
}

describe('project files browser contract', () => {
  it('validates size and supported names, canonicalizes missing/Windows MIME types', () => {
    expect(validateProjectFile(file())).toEqual({ name: 'Entrega.pdf', content_type: 'application/pdf', size: 3 });
    expect(validateProjectFile(new File([bytes], ' Tabla.CSV ', { type: 'application/vnd.ms-excel' }))).toEqual({
      name: 'Tabla.CSV',
      content_type: 'text/csv',
      size: 3,
    });
    expect(validateProjectFile(new File([bytes], 'archivo.zip', { type: 'application/x-zip-compressed' })).content_type).toBe('application/zip');
    expect(validateProjectFile(new File([bytes], 'Imagen.PNG')).content_type).toBe('image/png');
    expect(validateProjectFileName(' Documento.pdf ', 'application/pdf')).toBe('Documento.pdf');
    for (const name of ['../x.pdf', 'x\\a.pdf', 'x\n.pdf', '.pdf', 'sin extensión', 'x.html', 'x.svg', 'x.exe', 'a'.repeat(181) + '.pdf'])
      expect(() => validateProjectFileName(name)).toThrow();
    expect(() => validateProjectFileName('x.png', 'application/pdf')).toThrow();
    expect(() => validateProjectFile(new File([], 'vacío.pdf'))).toThrow('contener datos');
    expect(() => validateProjectFile(new File([new Uint8Array(FILE_MAX_BYTES + 1)], 'grande.pdf'))).toThrow('5 MiB');
    expect(() => validateProjectFile(new File([bytes], 'foto.png', { type: 'application/pdf' }))).toThrow('no coinciden');
  });
  it('lists only the project in the bound workspace, with bounded totals and cancellation', async () => {
    const value = setup();
    expect(await value.repository.list(project)).toEqual(listing);
    expect(value.rpc).toHaveBeenCalledWith('tr8_v2_project_files', { p_workspace_id: workspace, p_action: 'list', p_input: { project_id: projectId } });
    const controller = new AbortController(),
      abortSignal = vi.fn().mockResolvedValue(value.response(listing));
    value.rpc.mockReturnValueOnce({ abortSignal } as unknown as ReturnType<typeof value.rpc>);
    expect(await value.repository.list(project, controller.signal)).toEqual(listing);
    expect(abortSignal).toHaveBeenCalledWith(controller.signal);
  });
  it('uses the same Unicode character limit as PostgreSQL and still requires a basename before the extension', async () => {
    const accepted = '😀'.repeat(176) + '.pdf';
    expect(validateProjectFileName(accepted)).toBe(accepted);
    expect(() => validateProjectFileName('😀'.repeat(177) + '.pdf')).toThrow('180');
    expect(() => validateProjectFileName('.pdf')).toThrow();
    const value = setup();
    value.handler.mockReturnValueOnce(value.response({ ...listing, items: [{ ...row, name: accepted }] }));
    expect((await value.repository.list(project)).items[0].name).toBe(accepted);
  });
  it('accepts bounded conservative pending allocations without accepting arbitrary or leaked global usage', async () => {
    const value = setup();
    value.handler.mockReturnValueOnce(value.response({ ...listing, items: [reservation], used_bytes: FILE_MAX_BYTES }));
    expect((await value.repository.list(project)).used_bytes).toBe(FILE_MAX_BYTES);
    value.handler.mockReturnValueOnce(value.response({ ...listing, items: [ticket], used_bytes: row.size }));
    expect((await value.repository.list(project)).used_bytes).toBe(row.size);
    value.handler.mockReturnValueOnce(value.response({ ...listing, items: [reservation], used_bytes: FILE_MAX_BYTES + 1 }));
    await expect(value.repository.list(project)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    value.handler.mockReturnValueOnce(value.response({ ...listing, used_bytes: FILE_MAX_BYTES }));
    await expect(value.repository.list(project)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });
  it('rejects foreign projects, invalid requests and unsafe content before any network call', async () => {
    const value = setup();
    await expect(value.repository.list({ ...project, workspace_id: uid(9) })).rejects.toMatchObject({ code: '22023' });
    await expect(value.repository.upload(project, file(), 'bad')).rejects.toMatchObject({ code: '22023' });
    await expect(value.repository.upload(project, new File([bytes], 'run.exe'), fileId)).rejects.toMatchObject({ code: '22023' });
    expect(value.rpc).not.toHaveBeenCalled();
    expect(value.from).not.toHaveBeenCalled();
  });
  it.each([
    { ...listing, max_files: 101 },
    { ...listing, max_bytes: 999999999 },
    { ...listing, max_file_bytes: FILE_MAX_BYTES + 1 },
    { ...listing, items: [row, row], used_bytes: 6 },
    { ...listing, used_bytes: 1 },
    { ...listing, extra: true },
    { ...listing, items: [{ ...row, project_id: uid(9) }] },
    { ...listing, items: [{ ...row, workspace_id: uid(9) }] },
    { ...listing, items: [{ ...row, object_path: '../escape' }] },
    { ...listing, items: [{ ...row, extra: true }] },
    { ...listing, items: [{ ...row, size: Infinity }] },
    { ...listing, items: [{ ...row, version: 0 }] },
  ])('does not accept malformed or substituted listing metadata: %j', async data => {
    const value = setup();
    value.handler.mockReturnValue(value.response(data));
    await expect(value.repository.list(project)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });
  it('reserves, reconciles, uploads without overwrite and completes one stable identity', async () => {
    const value = setup(),
      source = file();
    expect(await value.repository.upload(project, source, fileId)).toEqual(row);
    expect(value.rpc.mock.calls.map(call => call[1].p_action)).toEqual(['reserve', 'complete', 'complete']);
    expect(value.rpc.mock.calls[0][1].p_input).toEqual({ id: fileId, project_id: projectId, name: row.name, content_type: row.content_type, size: row.size });
    expect(value.from).toHaveBeenCalledWith('tr8-project-files');
    expect(value.upload).toHaveBeenCalledExactlyOnceWith(row.object_path, source, { upsert: false, contentType: 'application/pdf', cacheControl: '0' });
    expect(await value.repository.upload(project, source, fileId)).toEqual(row);
    expect(value.upload).toHaveBeenCalledTimes(1);
  });
  it('accepts an exact ready reservation without sending another binary', async () => {
    const value = setup();
    value.handler.mockReturnValue(value.response(row));
    expect(await value.repository.upload(project, file(), fileId)).toEqual(row);
    expect(value.upload).not.toHaveBeenCalled();
    expect(value.rpc).toHaveBeenCalledOnce();
  });
  it('preserves a later metadata rename when replaying an already confirmed upload', async () => {
    const value = setup();
    value.handler.mockReturnValue(value.response({ ...row, name: 'Renombrado por otra sesión.pdf', version: 3 }));
    expect(await value.repository.upload(project, file(), fileId)).toMatchObject({ id: fileId, name: 'Renombrado por otra sesión.pdf', version: 3 });
    expect(value.upload).not.toHaveBeenCalled();
  });
  it('reconciles a committed upload after its response was lost', async () => {
    const value = setup();
    value.handler
      .mockReturnValueOnce(value.response(reservation))
      .mockReturnValueOnce(value.response(null, { code: '55000' }))
      .mockReturnValueOnce(value.response(row));
    value.upload.mockResolvedValueOnce(value.response(null, { message: 'Network timeout' }));
    expect(await value.repository.upload(project, file(), fileId)).toEqual(row);
    expect(value.upload).toHaveBeenCalledTimes(1);
  });
  it('preserves a failed upload reservation for retry and does not send remove or overwrite', async () => {
    const value = setup();
    value.upload.mockResolvedValueOnce(value.response(null, { message: 'Network timeout' }));
    await expect(value.repository.upload(project, file(), fileId)).rejects.toThrow('conexión');
    expect(value.remove).not.toHaveBeenCalled();
    expect(value.rpc.mock.calls.map(call => call[1].p_action)).toEqual(['reserve', 'complete', 'complete']);
    expect(await value.repository.upload(project, file(), fileId)).toEqual(row);
    expect(value.rpc.mock.calls[3][1].p_input.id).toBe(fileId);
  });
  it('does not upload when completing the reservation loses authorization', async () => {
    const value = setup();
    value.handler.mockReturnValueOnce(value.response(reservation)).mockReturnValueOnce(value.response(null, { code: '42501' }));
    await expect(value.repository.upload(project, file(), fileId)).rejects.toMatchObject({ code: '42501' });
    expect(value.upload).not.toHaveBeenCalled();
  });
  it.each(['PT413', 'PT422'])('explains capacity %s without confusing it with deleting a project or exposing global usage', async code => {
    const value = setup();
    value.handler.mockReturnValueOnce(value.response(null, { code, message: 'Global private budget: 209715200' }));
    await expect(value.repository.upload(project, file(), fileId)).rejects.toMatchObject({
      code,
      message: 'No hay capacidad disponible para esta carga. Revisa los archivos y sus límites antes de volver a intentarlo.',
    });
    expect(value.upload).not.toHaveBeenCalled();
  });
  it('rejects a substituted reservation or completion without choosing another path', async () => {
    for (const patch of [{ id: uid(9) }, { project_id: uid(9) }, { name: 'otro.pdf' }, { content_type: 'text/plain' }, { size: 4 }]) {
      const value = setup();
      value.handler.mockReturnValue(value.response({ ...reservation, ...patch }));
      await expect(value.repository.upload(project, file(), fileId)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
      expect(value.upload).not.toHaveBeenCalled();
    }
  });
  it('downloads through the private SDK only after local scope validation', async () => {
    const value = setup();
    const blob = await value.repository.download(row);
    expect(blob.size).toBe(3);
    expect(value.download).toHaveBeenCalledExactlyOnceWith(row.object_path, { cacheNonce: expect.stringMatching(/^[a-f0-9-]{36}$/) }, { cache: 'no-store' });
    await expect(value.repository.download({ ...row, status: 'pending' })).rejects.toMatchObject({ code: '22023' });
    await expect(value.repository.download({ ...row, workspace_id: uid(9) })).rejects.toMatchObject({ code: '22023' });
    expect(value.download).toHaveBeenCalledTimes(1);
  });
  it('does not confirm corrupted binary downloads and translates Storage permission failures', async () => {
    const value = setup();
    value.download.mockResolvedValueOnce(value.response(new Blob(['bad size'], { type: row.content_type })));
    await expect(value.repository.download(row)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    value.download.mockResolvedValueOnce(value.response(new Blob([bytes], { type: 'text/html' })));
    await expect(value.repository.download(row)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    value.download.mockResolvedValueOnce(value.response(null, { statusCode: '403', message: 'denied' }));
    await expect(value.repository.download(row)).rejects.toMatchObject({ code: '42501' });
  });
  it('uses a fresh private CDN nonce on every download so old grants are never reused', async () => {
    const value = setup();
    await value.repository.download(row);
    await value.repository.download(row);
    expect(value.download).toHaveBeenCalledTimes(2);
    const calls = value.download.mock.calls as unknown as [string, { cacheNonce: string }][];
    expect(calls[0][1].cacheNonce).not.toBe(calls[1][1].cacheNonce);
  });
  it('renames metadata with CAS while preserving binary identity and content type', async () => {
    const value = setup();
    expect(await value.repository.rename(row, ' Renombrado.pdf ')).toEqual({ ...row, name: 'Renombrado.pdf', version: 3 });
    expect(value.rpc).toHaveBeenCalledWith('tr8_v2_project_files', {
      p_workspace_id: workspace,
      p_action: 'rename',
      p_input: { id: fileId, version: 2, name: 'Renombrado.pdf' },
    });
    expect(value.from).not.toHaveBeenCalled();
    await expect(value.repository.rename(row, 'Renombrado.png')).rejects.toMatchObject({ code: '22023' });
  });
  it('preserves stale-rename errors and rejects version substitution', async () => {
    const value = setup();
    value.handler.mockReturnValueOnce(value.response(null, { code: 'PT409' }));
    await expect(value.repository.rename(row, 'Renombrado.pdf')).rejects.toMatchObject({ code: 'PT409' });
    value.handler.mockReturnValueOnce(value.response({ ...row, name: 'Renombrado.pdf', version: 8 }));
    await expect(value.repository.rename(row, 'Renombrado.pdf')).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });
  it('coordinates exact deletion ticket, Storage binary removal and metadata completion', async () => {
    const value = setup();
    await value.repository.remove(row);
    expect(value.rpc.mock.calls.map(call => call[1])).toEqual([
      { p_workspace_id: workspace, p_action: 'begin_delete', p_input: { id: fileId, version: 2 } },
      { p_workspace_id: workspace, p_action: 'finish_delete', p_input: { id: fileId, version: 3 } },
    ]);
    expect(value.remove).toHaveBeenCalledExactlyOnceWith([row.object_path]);
  });
  it('does not release reservation metadata when binary removal fails', async () => {
    const value = setup();
    value.remove.mockResolvedValueOnce(value.response(null, { message: 'Network timeout' }));
    await expect(value.repository.remove(row)).rejects.toThrow('conexión');
    expect(value.rpc.mock.calls.map(call => call[1].p_action)).toEqual(['begin_delete']);
    await value.repository.remove(ticket);
    expect(value.rpc.mock.calls[1][1].p_input.version).toBe(3);
    expect(value.rpc.mock.calls.at(-1)?.[1].p_action).toBe('finish_delete');
  });
  it('accepts authorized deletion receipts without another Storage request; missing access is an error', async () => {
    const value = setup();
    value.handler.mockReturnValueOnce(value.response({ id: fileId, deleted: true }));
    await value.repository.remove(row);
    expect(value.remove).not.toHaveBeenCalled();
    value.handler.mockReturnValueOnce(value.response(null, { code: 'PT404' }));
    await expect(value.repository.remove(row)).rejects.toMatchObject({ code: 'PT404' });
    expect(value.remove).not.toHaveBeenCalled();
  });
  it('does not remove another file when the deletion ticket is substituted', async () => {
    const value = setup();
    value.handler.mockReturnValueOnce(value.response({ ...ticket, id: uid(9) }));
    await expect(value.repository.remove(row)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    expect(value.remove).not.toHaveBeenCalled();
  });
});
