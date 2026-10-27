export const APPEARANCE_THEMES = ['system', 'light', 'dark'] as const;
export const APPEARANCE_ACCENTS = ['indigo', 'blue', 'violet', 'teal', 'rose', 'graphite'] as const;
export const APPEARANCE_DENSITIES = ['comfortable', 'compact'] as const;
export const APPEARANCE_MOTION = ['system', 'reduce'] as const;

export interface AppearancePreferences {
  version: 1;
  theme: (typeof APPEARANCE_THEMES)[number];
  accent: (typeof APPEARANCE_ACCENTS)[number];
  sidebarDensity: (typeof APPEARANCE_DENSITIES)[number];
  taskDensity: (typeof APPEARANCE_DENSITIES)[number];
  motion: (typeof APPEARANCE_MOTION)[number];
  sidebarCollapsed: boolean;
}

export type AppearancePatch = Partial<Omit<AppearancePreferences, 'version'>>;

export const DEFAULT_APPEARANCE: Readonly<AppearancePreferences> = Object.freeze({
  version: 1,
  theme: 'system',
  accent: 'indigo',
  sidebarDensity: 'comfortable',
  taskDensity: 'comfortable',
  motion: 'system',
  sidebarCollapsed: false,
});

const fields = ['version', 'theme', 'accent', 'sidebarDensity', 'taskDensity', 'motion', 'sidebarCollapsed'];

export function parseAppearance(value: unknown): AppearancePreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== fields.length ||
    Object.keys(record).some(key => !fields.includes(key)) ||
    record.version !== 1 ||
    !APPEARANCE_THEMES.includes(record.theme as AppearancePreferences['theme']) ||
    !APPEARANCE_ACCENTS.includes(record.accent as AppearancePreferences['accent']) ||
    !APPEARANCE_DENSITIES.includes(record.sidebarDensity as AppearancePreferences['sidebarDensity']) ||
    !APPEARANCE_DENSITIES.includes(record.taskDensity as AppearancePreferences['taskDensity']) ||
    !APPEARANCE_MOTION.includes(record.motion as AppearancePreferences['motion']) ||
    typeof record.sidebarCollapsed !== 'boolean'
  )
    return null;
  return {
    version: 1,
    theme: record.theme as AppearancePreferences['theme'],
    accent: record.accent as AppearancePreferences['accent'],
    sidebarDensity: record.sidebarDensity as AppearancePreferences['sidebarDensity'],
    taskDensity: record.taskDensity as AppearancePreferences['taskDensity'],
    motion: record.motion as AppearancePreferences['motion'],
    sidebarCollapsed: record.sidebarCollapsed,
  };
}

export function appearanceStorageKey(userKey?: string): string | null {
  // Only the authenticated user's stable ID is supplied by the workspace. Never
  // derive appearance state from the prototype store or a user's email address.
  return userKey && /^[a-zA-Z0-9_-]{1,160}$/.test(userKey) ? `tr8.appearance.v1.${userKey}` : null;
}

export function readAppearance(value: string | null): AppearancePreferences {
  if (value === null || value.length > 2048) return DEFAULT_APPEARANCE;
  try {
    return parseAppearance(JSON.parse(value)) ?? DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function applyAppearance(preferences: AppearancePreferences, root: HTMLElement): () => void {
  const attributes = {
    'data-theme': preferences.theme === 'system' ? null : preferences.theme,
    'data-accent': preferences.accent === 'indigo' ? null : preferences.accent,
    'data-side': preferences.sidebarDensity,
    'data-density': preferences.taskDensity,
    'data-motion': preferences.motion === 'reduce' ? 'reduce' : null,
  };
  const previous = Object.keys(attributes).map(name => [name, root.getAttribute(name)] as const);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === null) root.removeAttribute(name);
      else root.setAttribute(name, value);
    }
  };
}
