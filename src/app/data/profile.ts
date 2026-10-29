import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProfileApi, UserProfile } from '../profile-types';
import { validCivilDate } from '../workspace/CalendarTime';
import { DataError, dataError } from './errors';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const instant = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  validCivilDate(value.slice(0, 10)) &&
  Number.isFinite(Date.parse(value));
const validName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  Array.from(value.trim()).length <= 120 &&
  !Array.from(value).some(character => {
    const code = character.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159);
  });
const invalid = () => new DataError('Escribe un nombre de 1 a 120 caracteres, sin saltos de línea ni caracteres de control.', '22023');
const malformed = () => new DataError('No pudimos confirmar el perfil de esta cuenta. Vuelve a consultar sus datos.', 'CLIENT_UPGRADE_REQUIRED');

function ownProfile(value: unknown, userId: string): value is UserProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 3 && row.user_id === userId && validName(row.display_name) && instant(row.updated_at);
}

export function createProfileRepository(client: SupabaseClient, userId: string): Omit<ProfileApi, 'scopeKey'> {
  if (!uuid.test(userId)) throw invalid();
  async function rpc(name: string | null, expected: string | null, signal?: AbortSignal): Promise<UserProfile> {
    let result: unknown;
    try {
      const query = client.rpc('tr8_v2_profile', { p_name: name, p_expected_updated_at: expected });
      const { data, error } = await (signal ? query.abortSignal(signal) : query);
      if (error) throw dataError(error);
      result = data;
    } catch (cause) {
      throw dataError(cause);
    }
    if (!ownProfile(result, userId)) throw malformed();
    return result;
  }
  return {
    load: signal => rpc(null, null, signal),
    save: async (profile, name) => {
      if (!ownProfile(profile, userId) || !validName(name)) throw invalid();
      return rpc(name.trim(), profile.updated_at);
    },
  };
}
