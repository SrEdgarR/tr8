import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CirclePause, Clock3, Link2, ShieldCheck, Wallet, X } from 'lucide-react';
import { Busy, ErrorNotice } from '../../workspace/ui';
import { DataError } from '../../data/errors';
import type { OAuthConsentApi, OAuthConsentDetails } from './consent-api';
import { consentRedirect } from './consent-api';
import './oauth-consent.css';

export default function OAuthConsentPage(props: { api: OAuthConsentApi; attempt: string; onComplete: (url: string) => void }) {
  return <ScopedConsent key={`${props.api.ownerId}:${props.attempt}`} {...props} />;
}
function ScopedConsent({ api, attempt, onComplete }: { api: OAuthConsentApi; attempt: string; onComplete: (url: string) => void }) {
  const [details, setDetails] = useState<OAuthConsentDetails | null>(null);
  const [selected, setSelected] = useState(''),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [now, setNow] = useState(Date.now),
    [reload, setReload] = useState(0);
  const lifecycle = useRef({ active: true, ticket: 0 }),
    locked = useRef(false);
  useEffect(() => {
    const state = lifecycle.current;
    state.active = true;
    const ticket = ++state.ticket;
    void api.details(attempt).then(
      value => {
        if (state.active && state.ticket === ticket) setDetails(value);
      },
      () => {
        if (state.active && state.ticket === ticket) setError('La solicitud no está disponible o ha caducado. Vuelve a iniciarla desde tu asistente.');
      },
    );
    return () => {
      state.active = false;
      state.ticket++;
    };
  }, [api, attempt, reload]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const connection = details?.connections.find(c => c.credential_id === selected);
  const expired = Boolean(details && Date.parse(details.expires_at) <= now);
  async function complete(approve: boolean) {
    if (!details || locked.current || expired || (approve && (!consent || !connection))) return;
    locked.current = true;
    setBusy(true);
    setError('');
    const ticket = lifecycle.current.ticket;
    try {
      const result = approve ? await api.approve(attempt, selected, connection!.grant_fingerprint) : await api.deny(attempt);
      if (lifecycle.current.active && ticket === lifecycle.current.ticket) onComplete(consentRedirect(details, result));
    } catch (cause) {
      if (lifecycle.current.active && ticket === lifecycle.current.ticket) {
        setConsent(false);
        setError(cause instanceof DataError ? cause.message : 'No se pudo confirmar el acceso. Revisa tus asistentes conectados antes de volver a intentarlo.');
      }
    } finally {
      locked.current = false;
      if (lifecycle.current.active && ticket === lifecycle.current.ticket) setBusy(false);
    }
  }
  return (
    <main className="oa-page">
      <section className="oa-card" aria-label="Autorizar asistente en TR8">
        <header className="oa-heading">
          <span className="oa-mark">
            <Link2 size={22} aria-hidden="true" />
          </span>
          <div>
            <p className="oa-eyebrow">TR8 · Conexión de asistentes</p>
            <h1>Revisa el acceso a tus finanzas</h1>
          </div>
        </header>
        <p>Elige qué permiso financiero existente podrá usar este asistente. Inicias sesión en TR8; el asistente no recibe tu contraseña.</p>
        <p className="oa-paused">
          <CirclePause size={15} aria-hidden="true" />
          La importación automática seguirá desactivada.
        </p>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {!details ? (
          !error ? (
            <Busy>Comprobando la solicitud…</Busy>
          ) : (
            <button
              className="btn btn-secondary"
              onClick={() => {
                setError('');
                setReload(v => v + 1);
              }}
            >
              Volver a consultar
            </button>
          )
        ) : (
          <>
            <dl className="oa-client">
              <div>
                <dt>Asistente</dt>
                <dd>{details.client_name}</dd>
              </div>
              <div>
                <dt>Regresarás a</dt>
                <dd>{new URL(details.redirect_uri).hostname}</dd>
              </div>
              <div>
                <dt>Permiso solicitado</dt>
                <dd>{details.scopes.includes('finance:write') ? 'Consultar y registrar ingresos o compras confirmados' : 'Solo consultar tus finanzas'}</dd>
              </div>
            </dl>
            {expired && <ErrorNotice>La solicitud caducó. Inicia una nueva conexión desde el asistente.</ErrorNotice>}
            <label className="pw-field oa-field">
              <span>Permiso financiero de TR8</span>
              <select
                disabled={busy || expired}
                value={selected}
                onChange={e => {
                  setSelected(e.target.value);
                  setConsent(false);
                }}
              >
                <option value="">Selecciona un permiso autorizado</option>
                {details.connections.map(c => (
                  <option key={c.credential_id} value={c.credential_id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {!details.connections.length && (
              <p>No hay permisos financieros compatibles. Revisa Finanzas → Seguridad antes de volver a conectar el asistente.</p>
            )}
            {connection && (
              <div className="oa-scope">
                <h2>
                  <Wallet size={17} aria-hidden="true" />
                  Cuentas incluidas
                </h2>
                <ul>
                  {connection.accounts.map(a => (
                    <li key={a.account_id}>
                      <strong>
                        {a.name} · {a.currency}
                      </strong>
                      {details.scopes.includes('finance:write') && (
                        <span>
                          Avisos desde {new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(a.start_at))}
                          {' · '}
                          {new Intl.DateTimeFormat().resolvedOptions().timeZone}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {details.scopes.includes('finance:write') ? (
                  <p>
                    {connection.mailbox_ids.length} {connection.mailbox_ids.length === 1 ? 'buzón autorizado' : 'buzones autorizados'}. Las categorías del
                    permiso limitan los nuevos registros.
                  </p>
                ) : (
                  <p>
                    Solo consulta del historial de las cuentas elegidas, sin acceso a buzones ni permiso para registrar movimientos. Las categorías no limitan
                    las consultas.
                  </p>
                )}
                <p>
                  <Clock3 size={14} aria-hidden="true" />
                  Acceso durante un máximo de 30 días, limitado por la caducidad de tu permiso (
                  {new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date(connection.expires_at))}). Puedes revocarlo en TR8.
                </p>
              </div>
            )}
            <p className="oa-boundary">
              <ShieldCheck size={17} aria-hidden="true" />
              Este acceso no incluye Gmail, bancos, proyectos, tareas, la administración de tu cuenta ni la bóveda cifrada. Consultará los movimientos de las
              cuentas elegidas{details.scopes.includes('finance:write') ? '; los casos ambiguos quedarán en revisión.' : '.'}
            </p>
            <label className="oa-consent">
              <input type="checkbox" disabled={busy || expired || !connection} checked={consent} onChange={e => setConsent(e.target.checked)} />
              Autorizo al asistente a usar únicamente el permiso financiero seleccionado.
            </label>
            <footer className="oa-actions">
              <button className="btn btn-secondary" disabled={busy || expired} onClick={() => void complete(false)}>
                <X size={15} aria-hidden="true" />
                Cancelar conexión
              </button>
              <button className="btn btn-primary" disabled={busy || expired || !consent || !connection} onClick={() => void complete(true)}>
                {busy ? <Clock3 size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}Autorizar asistente
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            </footer>
          </>
        )}
      </section>
    </main>
  );
}
