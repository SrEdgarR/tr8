import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CalendarApi } from '../types';
import { detectDeviceTimeZone, validTimeZone } from './CalendarTime';
import { errorMessage } from './helpers';

export default function useCalendarZonePreferences(api: CalendarApi, automatic = false) {
  const client = useQueryClient();
  const profileKey = useMemo(() => [...api.scopeKey, 'profile'], [api.scopeKey]);
  const profile = useQuery({ queryKey: profileKey, queryFn: ({ signal }) => api.profile(signal), retry: false });
  const [detectedZone] = useState(detectDeviceTimeZone);
  const automaticAttempt = useRef(false);
  const [zoneInput, setZoneInput] = useState<string | null>(null);
  const [zoneError, setZoneError] = useState<string | null>(null);
  const [zoneNotice, setZoneNotice] = useState('');
  const zone = profile.error ? null : (profile.data?.time_zone ?? null);
  const zoneDraft = zoneInput ?? zone ?? detectedZone ?? '';
  const { mutate: persistZone, isPending: savingZone } = useMutation({
    mutationFn: ({ nextZone, version }: { nextZone: string; version: number; automatic: boolean; key: string[] }) => api.saveProfile(nextZone, version),
    onMutate: async variables => {
      setZoneError(null);
      setZoneNotice('');
      await client.cancelQueries({ queryKey: variables.key, exact: true });
    },
    onSuccess: (saved, variables) => {
      client.setQueryData(variables.key, saved);
      setZoneInput(null);
      setZoneNotice(
        variables.automatic
          ? `Detectamos y guardamos la zona de tu dispositivo: ${saved.time_zone}. Puedes cambiarla en Configuración.`
          : 'Zona horaria guardada. Los vencimientos conservan su fecha y los bloques conservan sus instantes.',
      );
    },
    onError: async cause => {
      setZoneError(errorMessage(cause));
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'PT409') {
        // Adopt the other session's preference without retrying the stale write.
        const current = await profile.refetch();
        if (current.data?.time_zone) {
          setZoneError(null);
          setZoneNotice('Se cargó la zona guardada desde otra sesión. Revisa la hora antes de cambiarla.');
        }
      }
    },
    retry: false,
  });

  useEffect(() => {
    if (
      !automatic ||
      automaticAttempt.current ||
      !detectedZone ||
      !profile.data ||
      profile.data.time_zone !== null ||
      profile.error ||
      api.accessError ||
      zoneInput !== null
    )
      return;
    automaticAttempt.current = true;
    persistZone({ nextZone: detectedZone, version: profile.data.version, automatic: true, key: profileKey });
  }, [automatic, detectedZone, profile.data, profile.error, api.accessError, zoneInput, persistZone, profileKey]);

  function saveZone() {
    if (savingZone || !profile.data || profile.error || api.accessError) return;
    setZoneError(null);
    setZoneNotice('');
    if (!validTimeZone(zoneDraft)) {
      setZoneError('Selecciona una zona de los resultados o escribe una zona IANA válida.');
      return;
    }
    persistZone({ nextZone: zoneDraft, version: profile.data.version, automatic: false, key: profileKey });
  }

  return { profile, detectedZone, zone, zoneDraft, setZoneInput, zoneError, zoneNotice, savingZone, saveZone };
}
