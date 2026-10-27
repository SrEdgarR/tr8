import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import {
  applyAppearance,
  appearanceStorageKey,
  DEFAULT_APPEARANCE,
  parseAppearance,
  readAppearance,
  type AppearancePatch,
  type AppearancePreferences,
} from './appearance';

interface AppearanceSnapshot {
  preferences: AppearancePreferences;
  persisted: boolean;
}

export interface AppearanceController extends AppearanceSnapshot {
  update: (patch: AppearancePatch) => void;
  reset: () => void;
}

function createAppearanceStore(key: string | null) {
  let snapshot: AppearanceSnapshot = { preferences: DEFAULT_APPEARANCE, persisted: false };
  if (key && typeof window !== 'undefined') {
    try {
      snapshot = { preferences: readAppearance(window.localStorage.getItem(key)), persisted: true };
    } catch {
      // Storage restrictions must never prevent opening the authenticated app.
    }
  }
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (!key || (event.key !== key && event.key !== null)) return;
    try {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
    } catch {
      return;
    }
    snapshot = { preferences: readAppearance(event.newValue), persisted: true };
    notify();
  };
  const update = (patch: AppearancePatch) => {
    const preferences = parseAppearance({ ...snapshot.preferences, ...patch });
    if (!preferences) return;
    let persisted = false;
    if (key) {
      try {
        window.localStorage.setItem(key, JSON.stringify(preferences));
        persisted = true;
      } catch {
        // Keep applying the preference in this open tab when storage is full.
      }
    }
    snapshot = { preferences, persisted };
    notify();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      if (!listeners.size && typeof window !== 'undefined') {
        window.addEventListener('storage', onStorage);
        // A user can return after another tab changed preferences while this
        // account had no mounted workspace. Read again at subscription time.
        if (key) {
          try {
            const preferences = readAppearance(window.localStorage.getItem(key));
            if (JSON.stringify(preferences) !== JSON.stringify(snapshot.preferences) || !snapshot.persisted) snapshot = { preferences, persisted: true };
          } catch {
            // Retain the in-memory preference when storage becomes unavailable.
          }
        }
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
      };
    },
    update,
    reset: () => update(DEFAULT_APPEARANCE),
  };
}

const stores = new Map<string, ReturnType<typeof createAppearanceStore>>();

export default function useAppearance(userKey?: string): AppearanceController {
  const key = appearanceStorageKey(userKey);
  const store = useMemo(() => {
    if (!key) return createAppearanceStore(null);
    let existing = stores.get(key);
    if (!existing) {
      existing = createAppearanceStore(key);
      stores.set(key, existing);
    }
    return existing;
  }, [key]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useLayoutEffect(() => applyAppearance(snapshot.preferences, document.documentElement), [snapshot.preferences]);
  return useMemo(() => ({ ...snapshot, update: store.update, reset: store.reset }), [snapshot, store]);
}
