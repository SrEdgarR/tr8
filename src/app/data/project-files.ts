import type { SupabaseClient } from '@supabase/supabase-js';
import {
  FILE_FORMATS,
  FILE_MAX_BYTES,
  PROJECT_FILES_BUCKET,
  PROJECT_FILES_MAX_BYTES,
  PROJECT_FILES_MAX_COUNT,
  type ProjectFile,
  type ProjectFileList,
  type ProjectFilesApi,
} from '../project-files-types';
import type { Project } from '../types';
import { DataError, dataError } from './errors';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const version = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 999999999;
const malformed = () => new DataError('La respuesta de archivos no corresponde a esta versión de TR8. Actualiza los datos.', 'CLIENT_UPGRADE_REQUIRED');
const invalid = (message = 'Revisa el nombre, el formato y el tamaño del archivo.') => new DataError(message, '22023');

function extension(name: string) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}
export function validateProjectFileName(name: string, contentType?: string): string {
  if (typeof name !== 'string') throw invalid();
  const normalized = name.trim();
  const ext = extension(normalized);
  const mime = FILE_FORMATS[ext as keyof typeof FILE_FORMATS];
  const unsafe = Array.from(normalized).some(character => {
    const point = character.codePointAt(0)!;
    return point < 32 || (point >= 127 && point <= 159) || character === '/' || character === '\\';
  });
  if (!normalized || Array.from(normalized).length > 180 || unsafe || !mime)
    throw invalid('Usa un nombre de hasta 180 caracteres con una extensión admitida, sin rutas ni caracteres de control.');
  if (contentType && mime !== contentType) throw invalid('Conserva una extensión que corresponda al formato del archivo.');
  return normalized;
}
export function validateProjectFile(file: File): { name: string; content_type: string; size: number } {
  if (!file || typeof file.name !== 'string' || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > FILE_MAX_BYTES)
    throw invalid('El archivo debe contener datos y ocupar como máximo 5 MiB.');
  const name = validateProjectFileName(file.name);
  const content_type = FILE_FORMATS[extension(name) as keyof typeof FILE_FORMATS];
  const reported = file.type?.toLowerCase().split(';')[0].trim();
  const alias =
    (content_type === 'application/zip' && reported === 'application/x-zip-compressed') ||
    (content_type === 'text/csv' && reported === 'application/vnd.ms-excel');
  if (reported && reported !== content_type && reported !== 'application/octet-stream' && !alias)
    throw invalid('La extensión y el tipo del archivo no coinciden.');
  return { name, content_type, size: file.size };
}
function fileError(cause: unknown): DataError {
  if (cause instanceof DataError) return cause;
  const value = record(cause) ? cause : {};
  const code = typeof value.code === 'string' ? value.code : undefined;
  if (code === 'PT422' || code === 'PT413')
    return new DataError('No hay capacidad disponible para esta carga. Revisa los archivos y sus límites antes de volver a intentarlo.', code);
  if (code === '55000') return new DataError('La carga aún no está completa o el proyecto está archivado. Actualiza los archivos antes de continuar.', code);
  if (code === '22023' || code === '23514' || code === '22P02')
    return invalid('Revisa los campos y los límites del archivo. El proyecto admite hasta 100 archivos y 50 MiB.');
  if (String(value.statusCode) === '403' || String(value.status) === '403')
    return new DataError('Ya no tienes permiso para acceder a este archivo. Actualiza los datos.', '42501');
  return dataError(cause);
}
function isFile(value: unknown, workspaceId: string): value is ProjectFile {
  if (
    !record(value) ||
    !closed(value, ['id', 'workspace_id', 'project_id', 'name', 'content_type', 'size', 'status', 'object_path', 'version', 'created_by', 'created_at']) ||
    !id(value.id) ||
    value.workspace_id !== workspaceId ||
    !id(value.project_id) ||
    !id(value.created_by) ||
    !version(value.version) ||
    !['pending', 'ready', 'deleting'].includes(String(value.status)) ||
    typeof value.name !== 'string' ||
    typeof value.content_type !== 'string' ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > FILE_MAX_BYTES ||
    value.object_path !== `${workspaceId}/${value.project_id}/${value.id}` ||
    typeof value.created_at !== 'string' ||
    value.created_at.length > 50 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.created_at) ||
    !Number.isFinite(Date.parse(value.created_at))
  )
    return false;
  try {
    return validateProjectFileName(value.name, value.content_type) === value.name;
  } catch {
    return false;
  }
}
function deleted(value: unknown, fileId: string) {
  return record(value) && closed(value, ['id', 'deleted']) && value.id === fileId && value.deleted === true;
}

export function createProjectFilesRepository(client: SupabaseClient, workspaceId: string): Omit<ProjectFilesApi, 'scopeKey'> {
  if (!id(workspaceId)) throw invalid();
  const storage = () => client.storage.from(PROJECT_FILES_BUCKET);
  async function request(action: string, input: Record<string, unknown>, signal?: AbortSignal) {
    let query = client.rpc('tr8_v2_project_files', { p_workspace_id: workspaceId, p_action: action, p_input: input });
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw fileError(error);
    return data as unknown;
  }
  function requireProject(project: Project) {
    if (!record(project) || project.workspace_id !== workspaceId || !id(project.id) || !version(project.version)) throw invalid();
  }
  function requireFile(file: ProjectFile) {
    if (!isFile(file, workspaceId)) throw invalid();
  }
  function checked(value: unknown, fileId: string, projectId: string): ProjectFile {
    if (!isFile(value, workspaceId) || value.id !== fileId || value.project_id !== projectId) throw malformed();
    return value;
  }
  function sameContent(value: ProjectFile, descriptor: { name: string; content_type: string; size: number }) {
    // A confirmed file may have been renamed after an earlier upload response was lost.
    if ((value.status !== 'ready' && value.name !== descriptor.name) || value.content_type !== descriptor.content_type || value.size !== descriptor.size)
      throw malformed();
    return value;
  }
  async function complete(fileId: string, projectId: string, descriptor: { name: string; content_type: string; size: number }) {
    const result = sameContent(checked(await request('complete', { id: fileId }), fileId, projectId), descriptor);
    if (result.status !== 'ready') throw malformed();
    return result;
  }
  return {
    async list(project, signal): Promise<ProjectFileList> {
      requireProject(project);
      const value = await request('list', { project_id: project.id }, signal);
      if (
        !record(value) ||
        !closed(value, ['items', 'used_bytes', 'max_bytes', 'max_file_bytes', 'max_files']) ||
        value.max_bytes !== PROJECT_FILES_MAX_BYTES ||
        value.max_file_bytes !== FILE_MAX_BYTES ||
        value.max_files !== PROJECT_FILES_MAX_COUNT ||
        !Array.isArray(value.items) ||
        value.items.length > PROJECT_FILES_MAX_COUNT ||
        !value.items.every(row => isFile(row, workspaceId) && row.project_id === project.id) ||
        new Set(value.items.map(row => row.id)).size !== value.items.length ||
        typeof value.used_bytes !== 'number' ||
        !Number.isSafeInteger(value.used_bytes) ||
        value.used_bytes < 0 ||
        value.used_bytes > PROJECT_FILES_MAX_BYTES ||
        value.items.reduce((total, row) => total + row.size, 0) > value.used_bytes ||
        value.items.reduce((total, row) => total + (row.status === 'ready' ? row.size : FILE_MAX_BYTES), 0) < value.used_bytes
      )
        throw malformed();
      return value as unknown as ProjectFileList;
    },
    async upload(project, file, requestId) {
      requireProject(project);
      if (!id(requestId)) throw invalid();
      const descriptor = validateProjectFile(file);
      const reserved = sameContent(
        checked(await request('reserve', { id: requestId, project_id: project.id, ...descriptor }), requestId, project.id),
        descriptor,
      );
      if (reserved.status === 'ready') return reserved;
      if (reserved.status !== 'pending') throw new DataError('La carga está siendo retirada. Actualiza los archivos.', 'PT409');
      try {
        return await complete(requestId, project.id, descriptor);
      } catch (error) {
        if (!(error instanceof DataError) || error.code !== '55000') throw error;
      }
      let uploadError: unknown;
      try {
        const { data, error } = await storage().upload(reserved.object_path, file, { upsert: false, contentType: descriptor.content_type, cacheControl: '0' });
        if (error) uploadError = error;
        else if (!data || data.path !== reserved.object_path) throw malformed();
      } catch (error) {
        uploadError = error;
      }
      if (uploadError) {
        // A lost response may have committed the object. Reconcile its exact ID before retrying bytes.
        try {
          return await complete(requestId, project.id, descriptor);
        } catch (error) {
          if (error instanceof DataError && error.code !== '55000') throw error;
          throw fileError(uploadError);
        }
      }
      return complete(requestId, project.id, descriptor);
    },
    async download(file) {
      requireFile(file);
      if (file.status !== 'ready') throw invalid('Espera a que termine la carga antes de descargar.');
      // Recheck current ACL instead of reusing a previously authorized private CDN response.
      const { data, error } = await storage().download(file.object_path, { cacheNonce: crypto.randomUUID() }, { cache: 'no-store' });
      if (error) throw fileError(error);
      if (
        !data ||
        typeof data.size !== 'number' ||
        data.size !== file.size ||
        typeof data.arrayBuffer !== 'function' ||
        data.type.split(';')[0] !== file.content_type
      )
        throw malformed();
      return data;
    },
    async rename(file, name) {
      requireFile(file);
      if (file.status !== 'ready') throw invalid('Solo se puede renombrar un archivo cuya carga terminó.');
      const normalized = validateProjectFileName(name, file.content_type);
      const value = checked(await request('rename', { id: file.id, version: file.version, name: normalized }), file.id, file.project_id);
      if (
        value.status !== 'ready' ||
        value.name !== normalized ||
        value.content_type !== file.content_type ||
        value.size !== file.size ||
        value.created_by !== file.created_by ||
        value.created_at !== file.created_at ||
        value.version !== file.version + 1
      )
        throw malformed();
      return value;
    },
    async remove(file) {
      requireFile(file);
      const result = await request('begin_delete', { id: file.id, version: file.version });
      if (deleted(result, file.id)) return;
      const ticket = checked(result, file.id, file.project_id);
      if (
        ticket.status !== 'deleting' ||
        ticket.content_type !== file.content_type ||
        ticket.size !== file.size ||
        ticket.version !== file.version + (file.status === 'deleting' ? 0 : 1)
      )
        throw malformed();
      const { error } = await storage().remove([ticket.object_path]);
      if (error) throw fileError(error);
      if (!deleted(await request('finish_delete', { id: ticket.id, version: ticket.version }), ticket.id)) throw malformed();
    },
  };
}
