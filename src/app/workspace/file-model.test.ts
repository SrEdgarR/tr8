import { describe, expect, it } from 'vitest';
import type { ProjectFile } from '../project-files-types';
import { fileSize, projectFileKind, visibleProjectFiles } from './file-model';
const file = (id: string, name: string, content_type: string, created_at = '2026-10-28T12:00:00Z'): ProjectFile => ({
  id,
  name,
  content_type,
  created_at,
  workspace_id: 'workspace',
  project_id: 'project',
  size: 1,
  status: 'ready',
  object_path: '',
  created_by: 'user',
  version: 1,
});
describe('modelo visual de archivos', () => {
  it.each([
    ['image/png', 'image'],
    ['application/pdf', 'pdf'],
    ['text/csv', 'sheet'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet'],
    ['text/plain', 'document'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'presentation'],
    ['application/zip', 'archive'],
    ['unknown', 'other'],
  ])('clasifica el tipo confirmado %s', (content_type, category) => expect(projectFileKind({ content_type })).toBe(category));
  it('busca y ordena sin mutar el snapshot original', () => {
    const rows = [
      file('a', 'Zeta.pdf', 'application/pdf'),
      file('b', 'Alfa.pdf', 'application/pdf', '2026-10-29T12:00:00Z'),
      file('c', 'Alfa.txt', 'text/plain'),
    ];
    expect(visibleProjectFiles(rows, '  ALFA ', 'pdf', 'date').map(row => row.id)).toEqual(['b']);
    expect(visibleProjectFiles(rows, '', '', 'name').map(row => row.id)).toEqual(['b', 'c', 'a']);
    expect(rows.map(row => row.id)).toEqual(['a', 'b', 'c']);
  });
  it('ordena tipos y desempata por nombre e identidad', () => {
    const rows = [file('b', 'Zeta.pdf', 'application/pdf'), file('a', 'Zeta.pdf', 'application/pdf'), file('c', 'Agenda.txt', 'text/plain')];
    expect(visibleProjectFiles(rows, '', '', 'type').map(row => row.id)).toEqual(['c', 'a', 'b']);
  });
  it('muestra tamaños reales con unidades legibles', () => {
    expect(fileSize(0)).toBe('0 B');
    expect(fileSize(120)).toBe('120 B');
    expect(fileSize(1024)).toBe('1 KB');
    expect(fileSize(5 * 1024 * 1024)).toBe('5 MB');
    expect(fileSize(Number.NaN)).toBe('0 B');
  });
});
