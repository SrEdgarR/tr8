import { useEffect, useState } from 'react';
import { CircleAlert, CloudOff, CloudUpload, LockKeyhole, RefreshCw } from 'lucide-react';
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
export default function SyncStatus({
  state,
  scope,
  onRefresh,
  refreshDisabled = false,
}: {
  state: DataSyncState;
  scope: string;
  onRefresh?: () => void;
  refreshDisabled?: boolean;
}) {
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
    status === 'offline' ? CloudOff : status === 'error' ? CircleAlert : status === 'locked' ? LockKeyhole : status === 'pending' ? CloudUpload : RefreshCw;
  const label = status === 'offline' ? 'Sin conexión' : descriptions[status];
  const title = `${scope}: ${status === 'synced' ? 'la información visible coincide con la última versión confirmada en TR8.' : label}`;
  const icon = <Icon size={13} className={status === 'checking' || status === 'saving' ? 'pw-spin' : undefined} aria-hidden="true" />;
  if (onRefresh)
    return (
      <button
        type="button"
        className="pw-sync pw-sync-button"
        data-state={status}
        aria-label="Actualizar datos"
        disabled={refreshDisabled || state === 'checking' || state === 'saving' || !online}
        onClick={() => onRefresh()}
        title={`${title} Pulsa para actualizar los datos.`}
      >
        {icon}
        <span role="status" aria-live="polite">
          {label}
        </span>
      </button>
    );
  return (
    <span className="pw-sync" data-state={status} role="status" aria-live="polite" title={title}>
      {icon}
      {label}
    </span>
  );
}
