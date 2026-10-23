export const AUTH_STORAGE_KEY = 'tr8.auth.v1';
export const AUTH_STORAGE_MIGRATION_KEY = 'tr8.auth.migrated.v1';

// One-time compatibility bridge for accounts created before the TR8 rename.
const LEGACY_STORAGE_KEY = 'gr8r.auth.v1';
const SUFFIXES = ['-code-verifier', '-user', ''] as const;
const FLOW_INDEX_SUFFIX = '-flows-code-verifier';
const FLOW_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;
type AuthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function flowIndex(value: string | null): string[] {
  try {
    const parsed: unknown = value === null ? [] : JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && FLOW_ID_PATTERN.test(id)) : [];
  } catch {
    return [];
  }
}

export function migrateAuthStorage(providedStorage?: AuthStorage): void {
  let storage: AuthStorage | undefined;
  const written: { key: string; previous: string | null }[] = [];
  try {
    storage = providedStorage ?? window.localStorage;
    const alreadyMigrated = storage.getItem(AUTH_STORAGE_MIGRATION_KEY) !== null;
    const hasCurrentSession = storage.getItem(AUTH_STORAGE_KEY) !== null;
    const legacy = SUFFIXES.map(suffix => ({
      source: `${LEGACY_STORAGE_KEY}${suffix}`,
      target: `${AUTH_STORAGE_KEY}${suffix}`,
      value: storage!.getItem(`${LEGACY_STORAGE_KEY}${suffix}`),
    }));
    const legacyIndexKey = `${LEGACY_STORAGE_KEY}${FLOW_INDEX_SUFFIX}`;
    const legacyIndex = storage.getItem(legacyIndexKey);
    const legacyFlowIds = new Set(flowIndex(legacyIndex));
    const legacyFlowPrefix = `${LEGACY_STORAGE_KEY}-flow-`;

    // auth-js also stores a verifier per flow. Enumerate the legacy namespace
    // because concurrent SDK writes can leave a valid slot out of its index.
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(legacyFlowPrefix) || !key.endsWith('-code-verifier')) continue;
      const id = key.slice(legacyFlowPrefix.length, -'-code-verifier'.length);
      if (FLOW_ID_PATTERN.test(id)) legacyFlowIds.add(id);
    }
    const legacyFlows = [...legacyFlowIds]
      .map(id => ({
        id,
        source: `${LEGACY_STORAGE_KEY}-flow-${id}-code-verifier`,
        target: `${AUTH_STORAGE_KEY}-flow-${id}-code-verifier`,
        value: storage!.getItem(`${LEGACY_STORAGE_KEY}-flow-${id}-code-verifier`),
      }))
      .filter(item => item.value !== null);

    if (!alreadyMigrated && !hasCurrentSession) {
      // Copy flow slots and PKCE/user state before the session. Existing target
      // slots belong to newer flows and must retain their own verifier.
      const itemsBeforeSession = [...legacyFlows, ...legacy.slice(0, -1)];
      for (const item of itemsBeforeSession) {
        if (item.value !== null && storage.getItem(item.target) === null) {
          storage.setItem(item.target, item.value);
          written.push({ key: item.target, previous: null });
        }
      }

      if (legacyFlows.length) {
        const targetIndexKey = `${AUTH_STORAGE_KEY}${FLOW_INDEX_SUFFIX}`;
        const previous = storage.getItem(targetIndexKey);
        const currentFlowIds = flowIndex(previous);
        const currentSet = new Set(currentFlowIds);
        // Legacy flows are older. Keep the newer index ordering at the end,
        // matching auth-js's oldest-first eviction and sign-out cleanup.
        const merged = [...new Set([...legacyFlows.map(item => item.id).filter(id => !currentSet.has(id)), ...currentFlowIds])];
        const value = JSON.stringify(merged);
        if (value !== previous) {
          storage.setItem(targetIndexKey, value);
          written.push({ key: targetIndexKey, previous });
        }
      }

      const session = legacy.at(-1)!;
      if (session.value !== null && storage.getItem(session.target) === null) {
        storage.setItem(session.target, session.value);
        written.push({ key: session.target, previous: null });
      }
    }

    if (!alreadyMigrated) {
      // Commit before cleanup so an old session left behind by blocked removal
      // can never be restored after the user signs out of the new namespace.
      storage.setItem(AUTH_STORAGE_MIGRATION_KEY, '1');
      written.push({ key: AUTH_STORAGE_MIGRATION_KEY, previous: null });
    }

    // Only remove the old keys after every required write has succeeded.
    for (const item of [...legacyFlows, ...legacy, { source: legacyIndexKey, value: legacyIndex }]) {
      if (item.value !== null) {
        try {
          storage.removeItem(item.source);
        } catch {
          // The completed new state remains valid even if old-key cleanup is blocked.
        }
      }
    }
  } catch {
    // Storage can be blocked or full. Keep the original session available to retry.
    if (storage) {
      for (const { key, previous } of written.reverse()) {
        try {
          if (previous === null) storage.removeItem(key);
          else storage.setItem(key, previous);
        } catch {
          // A blocked storage implementation may also reject cleanup.
        }
      }
    }
  }
}
