/** Project identity vocabulary inherited from the original Gr8r Studio design. */
export const PROJECT_ICONS = [
  { id: 'globe', label: 'Globo' },
  { id: 'smartphone', label: 'Móvil' },
  { id: 'megaphone', label: 'Megáfono' },
  { id: 'rocket', label: 'Cohete' },
  { id: 'component', label: 'Componente' },
  { id: 'building-2', label: 'Edificio' },
  { id: 'layout-grid', label: 'Cuadrícula' },
  { id: 'palette', label: 'Paleta' },
  { id: 'code', label: 'Código' },
  { id: 'briefcase', label: 'Maletín' },
  { id: 'target', label: 'Objetivo' },
  { id: 'layers', label: 'Capas' },
  { id: 'zap', label: 'Rayo' },
  { id: 'heart', label: 'Corazón' },
  { id: 'folder', label: 'Carpeta' },
  { id: 'sparkles', label: 'Destellos' },
] as const;

export type ProjectIconName = (typeof PROJECT_ICONS)[number]['id'];

export function isProjectIcon(value: unknown): value is ProjectIconName {
  return typeof value === 'string' && PROJECT_ICONS.some(icon => icon.id === value);
}

export function projectIconName(value: unknown): ProjectIconName {
  return isProjectIcon(value) ? value : 'folder';
}
