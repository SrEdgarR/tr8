import { useEffect, useRef, useState } from 'react';
import { Clock3, Link2, RefreshCw, Unplug } from 'lucide-react';
import SettingsDisclosure from '../../workspace/SettingsDisclosure';
import { ErrorNotice } from '../../workspace/ui';
import type { OAuthConnectionGrant, OAuthConsentApi } from './consent-api';
import '../integration/finance-mcp-panel.css';

export default function OAuthConnectionsPanel({ api }: { api: OAuthConsentApi }) {
  return <ScopedConnections key={api.ownerId} api={api} />;
}
function ScopedConnections({ api }: { api: OAuthConsentApi }) {
  const [grants, setGrants] = useState<OAuthConnectionGrant[]>([]),
    [error, setError] = useState('');
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [revoking, setRevoking] = useState<string | null>(null);
  const lifecycle = useRef({ active: true, ticket: 0 }),
    locked = useRef(false);
  useEffect(() => {
    const state = lifecycle.current;
    state.active = true;
    return () => {
      state.active = false;
      state.ticket++;
    };
  }, [api]);
  async function load() {
    const ticket = ++lifecycle.current.ticket;
    setLoading(true);
    setError('');
    setRevoking(null);
    try {
      const values = await api.list();
      if (lifecycle.current.active && lifecycle.current.ticket === ticket) setGrants(values);
    } catch {
      if (lifecycle.current.active && lifecycle.current.ticket === ticket) setError('No pudimos comprobar los asistentes conectados. Vuelve a consultar.');
    } finally {
      if (lifecycle.current.active && lifecycle.current.ticket === ticket) setLoading(false);
    }
  }
  async function revoke(id: string) {
    if (locked.current || loading) return;
    locked.current = true;
    setBusy(true);
    setError('');
    const ticket = lifecycle.current.ticket;
    try {
      await api.revoke(id);
      if (lifecycle.current.active && lifecycle.current.ticket === ticket) {
        setGrants(values => values.filter(g => g.grant_id !== id));
        setRevoking(null);
      }
    } catch {
      if (lifecycle.current.active && lifecycle.current.ticket === ticket)
        setError('No se pudo confirmar la revocación. Actualiza la lista antes de reintentar.');
    } finally {
      locked.current = false;
      if (lifecycle.current.active && lifecycle.current.ticket === ticket) setBusy(false);
    }
  }
  return (
    <SettingsDisclosure
      title="Asistentes conectados"
      description="Consulta y revoca las conexiones OAuth a tus finanzas."
      icon={<Link2 size={18} />}
      disabled={busy}
      onExpandedChange={expanded => {
        if (expanded) void load();
        else {
          lifecycle.current.ticket++;
          setLoading(false);
          setRevoking(null);
          setGrants([]);
        }
      }}
    >
      <div className="tf-mcp-content">
        <p className="muted">Estos accesos no activan la importación automática. Revocarlos conserva tus movimientos.</p>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <button className="btn btn-secondary" disabled={loading || busy} onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />
          {loading ? 'Comprobando…' : 'Actualizar asistentes'}
        </button>
        {!loading && !error && !grants.filter(g => !g.revoked_at).length && <p>No hay asistentes conectados mediante OAuth.</p>}
        <ul className="tf-mcp-grants">
          {grants
            .filter(g => !g.revoked_at)
            .map(g => (
              <li key={g.grant_id}>
                <strong>{g.client_name}</strong>
                <span>{g.scopes.includes('finance:write') ? 'Consulta y registro de ingresos o compras confirmados' : 'Solo consulta'}</span>
                <p className="muted">
                  <Clock3 size={14} aria-hidden="true" /> Hasta{' '}
                  {new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(g.expires_at))}
                </p>
                {revoking === g.grant_id ? (
                  <div className="tf-mcp-confirm" role="group" aria-label={`Confirmar revocación de ${g.client_name}`}>
                    <p>El asistente perderá este acceso y sus tokens de renovación. Tus datos permanecen guardados.</p>
                    <button className="btn btn-secondary" disabled={busy} onClick={() => setRevoking(null)}>
                      Cancelar
                    </button>
                    <button className="btn btn-secondary" disabled={busy} onClick={() => void revoke(g.grant_id)}>
                      Confirmar revocación
                    </button>
                  </div>
                ) : (
                  <button className="btn btn-secondary" disabled={busy || loading} onClick={() => setRevoking(g.grant_id)}>
                    <Unplug size={15} aria-hidden="true" />
                    Revocar acceso de {g.client_name}
                  </button>
                )}
              </li>
            ))}
        </ul>
      </div>
    </SettingsDisclosure>
  );
}
