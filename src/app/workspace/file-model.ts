import type { ProjectFile } from '../project-files-types';

export const FILE_KINDS = {
  image: { label: 'Imágenes', singular: 'Imagen', color: '#23918A' },
  pdf: { label: 'PDF', singular: 'PDF', color: '#C4473A' },
  sheet: { label: 'Hojas de cálculo', singular: 'Hoja de cálculo', color: '#3D8E5F' },
  document: { label: 'Documentos', singular: 'Documento', color: '#3B82C4' },
  presentation: { label: 'Presentaciones', singular: 'Presentación', color: '#8662C9' },
  archive: { label: 'Comprimidos', singular: 'Comprimido', color: '#6B7280' },
  other: { label: 'Otros', singular: 'Archivo', color: '#6B7280' },
} as const;
export type FileKind = keyof typeof FILE_KINDS;
export type FileSort = 'date' | 'name' | 'type';
export function projectFileKind(file: Pick<ProjectFile, 'content_type'>): FileKind {
  const mime = file.content_type;
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/csv' || mime.includes('spreadsheetml')) return 'sheet';
  if (mime === 'text/plain' || mime.includes('wordprocessingml')) return 'document';
  if (mime.includes('presentationml')) return 'presentation';
  if (mime === 'application/zip') return 'archive';
  return 'other';
}
export function fileSize(bytes: number) {
  const amount = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (amount < 1024) return `${amount} B`;
  const formatter = new Intl.NumberFormat('es', { maximumFractionDigits: 1 });
  return amount < 1024 * 1024 ? `${formatter.format(amount / 1024)} KB` : `${formatter.format(amount / (1024 * 1024))} MB`;
}
export function visibleProjectFiles(files: readonly ProjectFile[], query: string, kind: FileKind | '', sort: FileSort): ProjectFile[] {
  const search = query.trim().toLocaleLowerCase('es');
  return files
    .filter(file => (!search || file.name.toLocaleLowerCase('es').includes(search)) && (!kind || projectFileKind(file) === kind))
    .sort((a, b) => {
      const comparison =
        sort === 'name'
          ? a.name.localeCompare(b.name, 'es')
          : sort === 'type'
            ? FILE_KINDS[projectFileKind(a)].singular.localeCompare(FILE_KINDS[projectFileKind(b)].singular, 'es')
            : b.created_at.localeCompare(a.created_at);
      return comparison || a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id);
    });
}
