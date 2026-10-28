import type { Project } from './types';

export const FILE_MAX_BYTES = 5 * 1024 * 1024;
export const PROJECT_FILES_MAX_BYTES = 50 * 1024 * 1024;
export const PROJECT_FILES_MAX_COUNT = 100;
export const PROJECT_FILES_BUCKET = 'tr8-project-files';
export const FILE_FORMATS = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
} as const;
export const PROJECT_FILE_ACCEPT = Object.keys(FILE_FORMATS)
  .map(extension => `.${extension}`)
  .join(',');

export interface ProjectFile {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  content_type: string;
  size: number;
  status: 'pending' | 'ready' | 'deleting';
  object_path: string;
  version: number;
  created_by: string;
  created_at: string;
}
export interface ProjectFileList {
  items: ProjectFile[];
  used_bytes: number;
  max_bytes: number;
  max_file_bytes: number;
  max_files: number;
}
export interface ProjectFilesApi {
  scopeKey: string[];
  list(project: Project, signal?: AbortSignal): Promise<ProjectFileList>;
  upload(project: Project, file: File, requestId: string): Promise<ProjectFile>;
  download(file: ProjectFile): Promise<Blob>;
  rename(file: ProjectFile, name: string): Promise<ProjectFile>;
  remove(file: ProjectFile): Promise<void>;
}
