import { useEffect, useRef, useState } from 'react';
import { KeyRound, RefreshCw } from 'lucide-react';
import type { McpCredentialsApi } from '../../data/mcp';
import { DataError } from '../../data/errors';
import { ErrorNotice } from '../../workspace/ui';
import type { FinanceMcpApi } from './api';
import FinanceMcpPanel from './FinanceMcpPanel';

export interface FinanceMcpSettingsProps {
  api: FinanceMcpApi;
  accounts: { id: string; name: string; currency: string }[];
  connectionsApi: McpCredentialsApi;
  workspaceId: string;
  enabled?: boolean;
}

/** A workspace change remounts the permission/review UI before any old result can render. */
export default function FinanceMcpSettings({ enabled = false, ...props }: FinanceMcpSettingsProps) {
  if (!enabled) return <FinanceMcpPanel api={props.api} accounts={props.accounts} connections={[]} />;
  if (props.api.ownerId !== props.connectionsApi.ownerId)
    return <ErrorNotice>Tu sesión cambió. Vuelve a abrir Configuración antes de consultar conexiones financieras.</ErrorNotice>;
  return <ScopedFinanceMcpSettings key={`${props.api.ownerId}:${props.workspaceId}`} {...props} />;
}

function ScopedFinanceMcpSettings({ api, accounts, connectionsApi, workspaceId }: Omit<FinanceMcpSettingsProps, 'enabled'>) {
  const [connections, setConnections] = useState<{ id: string; name: string }[] | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const lifecycle = useRef({ active: true, epoch: 0 });
  useEffect(() => {
    const current = lifecycle.current;
    current.active = true;
    return () => {
      current.active = false;
      current.epoch++;
    };
  }, [connectionsApi]);
  async function load() {
    const epoch = ++lifecycle.current.epoch;
    setLoading(true);
    setError('');
    setConnections(null);
    try {
      const rows = await connectionsApi.list();
      if (!lifecycle.current.active || lifecycle.current.epoch !== epoch) return;
      const now = Date.now();
      setConnections(
        rows
          .filter(item => item.workspace_id === workspaceId && item.revoked_at === null && Date.parse(item.expires_at) > now)
          .map(({ id, name }) => ({ id, name })),
      );
    } catch (cause) {
      if (lifecycle.current.active && lifecycle.current.epoch === epoch)
        setError(cause instanceof DataError ? cause.message : 'No se pudieron consultar las conexiones de este espacio. Vuelve a intentarlo.');
    } finally {
      if (lifecycle.current.active && lifecycle.current.epoch === epoch) setLoading(false);
    }
  }
  return (
    <div className="tf-mcp-content">
      <div className="tf-mcp-row">
        <p className="muted">Selecciona una conexión existente del espacio actual. Esta vista no crea claves ni activa la importación automática.</p>
        <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => void load()}>
          {connections ? <RefreshCw size={15} aria-hidden="true" /> : <KeyRound size={15} aria-hidden="true" />}
          {connections ? 'Actualizar conexiones de este espacio' : 'Cargar conexiones de este espacio'}
        </button>
      </div>
      {loading && <p role="status">Consultando conexiones autorizadas…</p>}
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {connections?.length === 0 && <p>No hay conexiones activas en este espacio. Administra tus conexiones MCP antes de conceder permisos financieros.</p>}
      <FinanceMcpPanel key={connections ? 'ready' : 'unloaded'} api={api} accounts={accounts} connections={connections ?? []} enabled={connections !== null} />
    </div>
  );
}
