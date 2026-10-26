import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, CloudOff, CloudUpload, LoaderCircle, LockKeyhole } from 'lucide-react';
import type { DataSyncState } from '../types';

const descriptions: Record<DataSyncState, string> = {
  checking: 'Comprobando…',
  saving: 'Guardando…',
  synced: 'Sincronizado',
  pending: 'Por confirmar',
  error: 'Error de sincronización',
  locked: 'Bóveda bloqueada',
};

/** A confirmation from TR8 is separate from the background Google integration. */
export default function SyncStatus({ state, scope }: { state: DataSyncState; scope: string }) {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [needsVerification, setNeedsVerification] = useState(() => !navigator.onLine);
  useEffect(() => {
    const disconnect = () => {
      setOnline(false);
      setNeedsVerification(true);
    };
    const reconnect = () => setOnline(true);
    window.addEventListener('offline', disconnect);
    window.addEventListener('online', reconnect);
    return () => {
      window.removeEventListener('offline', disconnect);
      window.removeEventListener('online', reconnect);
    };
  }, []);
  useEffect(() => {
    if (state === 'synced' && navigator.onLine) setNeedsVerification(false);
  }, [state]);
  const status = !online ? 'offline' : state === 'synced' && needsVerification ? 'pending' : state;
  const Icon =
    status === 'synced'
      ? CircleCheck
      : status === 'offline'
        ? CloudOff
        : status === 'error'
          ? CircleAlert
          : status === 'locked'
            ? LockKeyhole
            : status === 'pending'
              ? CloudUpload
              : LoaderCircle;
  const label = status === 'offline' ? 'Sin conexión' : descriptions[status];
  return (
    <span
      className="pw-sync"
      data-state={status}
      role="status"
      aria-live="polite"
      title={`${scope}: ${status === 'synced' ? 'la información visible coincide con la última versión confirmada en TR8.' : label}`}
    >
      <Icon size={13} className={status === 'checking' || status === 'saving' ? 'pw-spin' : undefined} aria-hidden="true" />
      {label}
    </span>
  );
}
