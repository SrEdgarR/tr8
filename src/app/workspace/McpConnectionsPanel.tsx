import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Bot, Check, Copy, ExternalLink, KeyRound, Plus, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import type { McpAccess, McpCredential, McpCredentialsApi } from '../data/mcp';
import { DataError } from '../data/errors';
import SettingsDisclosure from './SettingsDisclosure';
import { Dialog, ErrorNotice } from './ui';
import './mcp-connections.css';

const endpoint = 'https://tr8.vercel.app/api/mcp';
const documentation = 'https://github.com/SrEdgarR/tr8/blob/main/docs/mcp/README.md';
const httpConfiguration = JSON.stringify(
  {
    mcpServers: { tr8: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer <TU_CLAVE_TR8>' } } },
  },
  null,
  2,
);
const stdioConfiguration = JSON.stringify(
  {
    mcpServers: { tr8: { command: 'node', args: ['<RUTA_A_TR8>/scripts/mcp/stdio.mjs'], env: { TR8_MCP_URL: endpoint, TR8_MCP_TOKEN: '<TU_CLAVE_TR8>' } } },
  },
  null,
  2,
);
const date = (value: string) => new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date(value));
const failure = (cause: unknown) => (cause instanceof DataError ? cause.message : 'No se pudo confirmar la operación. Actualiza la lista antes de continuar.');

export default function McpConnectionsPanel({ api, workspaceId, workspaceName }: { api: McpCredentialsApi; workspaceId: string; workspaceName: string }) {
  const prefix = useId();
  const [credentials, setCredentials] = useState<McpCredential[]>([]);
  const [name, setName] = useState('');
  const [access, setAccess] = useState<McpAccess>('read');
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<McpCredential | null>(null);
  const [configuration, setConfiguration] = useState<'http' | 'stdio'>('http');
  const lifecycle = useRef({ active: true, epoch: 0 });
  const locked = useRef(false);
  useEffect(() => {
    const scope = lifecycle.current;
    scope.active = true;
    return () => {
      scope.active = false;
      scope.epoch++;
    };
  }, []);
  const ownSpace = credentials.filter(credential => credential.workspace_id === workspaceId);
  async function load() {
    const current = ++lifecycle.current.epoch;
    setLoading(true);
    setError('');
    try {
      const result = await api.list();
      if (lifecycle.current.active && current === lifecycle.current.epoch) setCredentials(result);
    } catch (cause) {
      if (lifecycle.current.active && current === lifecycle.current.epoch) setError(failure(cause));
    } finally {
      if (lifecycle.current.active && current === lifecycle.current.epoch) setLoading(false);
    }
  }
  function expanded(next: boolean) {
    setToken(null);
    setRevealed(false);
    setCopied(false);
    setNotice('');
    if (next) void load();
    else {
      lifecycle.current.epoch++;
      setLoading(false);
      setRevoking(null);
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current || loading || token) return;
    locked.current = true;
    const current = lifecycle.current.epoch;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const created = await api.create({ name, workspace_id: workspaceId, access, expires_in_days: days });
      if (!lifecycle.current.active || current !== lifecycle.current.epoch) return;
      const { token: secret, ...metadata } = created;
      setCredentials(previous => [metadata, ...previous.filter(item => item.id !== metadata.id)]);
      setToken(secret);
      setRevealed(false);
      setCopied(false);
      setName('');
      setAccess('read');
      setNotice('Conexión creada. La clave se mostrará solo en esta pantalla.');
    } catch (cause) {
      if (lifecycle.current.active && current === lifecycle.current.epoch) setError(failure(cause));
    } finally {
      locked.current = false;
      if (lifecycle.current.active) setBusy(false);
    }
  }
  async function revoke() {
    if (!revoking || locked.current) return;
    locked.current = true;
    const selected = revoking,
      current = lifecycle.current.epoch;
    setBusy(true);
    setError('');
    try {
      const revoked = await api.revoke(selected.id);
      if (!lifecycle.current.active || current !== lifecycle.current.epoch) return;
      setCredentials(previous => previous.map(item => (item.id === revoked.id ? revoked : item)));
      setRevoking(null);
      setToken(null);
      setNotice('Conexión revocada. El agente ya no puede usar esa clave.');
    } catch (cause) {
      if (lifecycle.current.active && current === lifecycle.current.epoch) setError(failure(cause));
    } finally {
      locked.current = false;
      if (lifecycle.current.active) setBusy(false);
    }
  }
  async function copyToken() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      if (lifecycle.current.active) setCopied(true);
    } catch {
      if (lifecycle.current.active) setError('No pudimos copiar la clave. Puedes mostrarla y seleccionarla para copiarla manualmente.');
    }
  }
  return (
    <SettingsDisclosure
      title="Agentes de IA · MCP"
      description="Conecta asistentes con tus proyectos, tareas y calendario."
      icon={<Bot size={18} />}
      onExpandedChange={expanded}
      disabled={busy}
    >
      <div className="pw-mcp-panel">
        <div className="pw-mcp-scope">
          <ShieldCheck size={18} aria-hidden="true" />
          <div>
            <strong>{workspaceName}</strong>
            <p>Las claves de este espacio respetan tus permisos actuales. Finanzas y la administración de miembros quedan fuera del acceso MCP.</p>
          </div>
        </div>
        {error && !revoking && <ErrorNotice>{error}</ErrorNotice>}
        {notice && (
          <p role="status" className="pw-mcp-notice">
            <Check size={14} aria-hidden="true" />
            {notice}
          </p>
        )}
        {token ? (
          <section className="pw-mcp-token" aria-label="Clave de la nueva conexión">
            <h4>
              <KeyRound size={16} aria-hidden="true" /> Guarda tu clave
            </h4>
            <p>No podrás volver a consultarla. Compártela únicamente con el agente que quieres conectar.</p>
            <label className="pw-field" htmlFor={`${prefix}-token`}>
              Clave MCP
              <input id={`${prefix}-token`} type={revealed ? 'text' : 'password'} readOnly value={token} autoComplete="off" spellCheck={false} />
            </label>
            <div className="pw-mcp-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRevealed(value => !value)}>
                {revealed ? 'Ocultar clave' : 'Mostrar clave'}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyToken()}>
                <Copy size={14} aria-hidden="true" />
                {copied ? 'Clave copiada' : 'Copiar clave'}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setToken(null);
                  setNotice('Clave retirada de esta pantalla. Puedes revocarla cuando lo necesites.');
                }}
              >
                Ya guardé la clave
              </button>
            </div>
          </section>
        ) : (
          <form className="pw-mcp-create" onSubmit={event => void create(event)}>
            <fieldset disabled={busy || loading}>
              <label className="pw-field" htmlFor={`${prefix}-name`}>
                Nombre del agente
                <input
                  id={`${prefix}-name`}
                  required
                  maxLength={80}
                  value={name}
                  placeholder="Por ejemplo, mi asistente de planificación"
                  onChange={event => setName(event.target.value)}
                />
              </label>
              <div className="pw-mcp-form-grid">
                <label className="pw-field" htmlFor={`${prefix}-access`}>
                  Permisos
                  <select id={`${prefix}-access`} value={access} onChange={event => setAccess(event.target.value as McpAccess)}>
                    <option value="read">Solo lectura</option>
                    <option value="write">Lectura y escritura</option>
                  </select>
                </label>
                <label className="pw-field" htmlFor={`${prefix}-days`}>
                  Caducidad
                  <select id={`${prefix}-days`} value={days} onChange={event => setDays(Number(event.target.value))}>
                    <option value={7}>7 días</option>
                    <option value={30}>30 días</option>
                    <option value={90}>90 días</option>
                  </select>
                </label>
              </div>
              <p className="faint">
                {access === 'read'
                  ? 'El agente podrá consultar el contenido al que tienes acceso en este espacio.'
                  : 'El agente también podrá crear y actualizar proyectos y tareas. Configura en tu agente las confirmaciones de escritura que prefieras.'}
              </p>
              <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy || loading}>
                <Plus size={14} aria-hidden="true" />
                {busy ? 'Creando…' : 'Crear conexión MCP'}
              </button>
            </fieldset>
          </form>
        )}
        <section className="pw-mcp-list" aria-label="Tus conexiones MCP en este espacio">
          <div className="pw-mcp-list-heading">
            <h4>Conexiones de este espacio</h4>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || loading} onClick={() => void load()}>
              <RefreshCw size={14} aria-hidden="true" />
              {loading ? 'Actualizando…' : 'Actualizar conexiones'}
            </button>
          </div>
          {!loading && ownSpace.length === 0 && <p className="faint">Todavía no has creado conexiones para este espacio.</p>}
          {ownSpace.map(credential => {
            const inactive = !!credential.revoked_at || Date.parse(credential.expires_at) <= Date.now();
            return (
              <article key={credential.id} className="pw-mcp-credential">
                <span className="pw-mcp-credential-icon">
                  <Bot size={17} aria-hidden="true" />
                </span>
                <div className="pw-mcp-credential-copy">
                  <strong>{credential.name}</strong>
                  <span>
                    {credential.access === 'read' ? 'Solo lectura' : 'Lectura y escritura'} ·{' '}
                    {credential.revoked_at ? 'Revocada' : inactive ? 'Caducada' : `Caduca el ${date(credential.expires_at)}`}
                  </span>
                  <span>{credential.last_used_at ? `Último uso: ${date(credential.last_used_at)}` : 'Aún no se ha usado'}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy || inactive}
                  onClick={() => {
                    setError('');
                    setRevoking(credential);
                  }}
                  aria-label={`Revocar conexión ${credential.name}`}
                >
                  <Unplug size={14} aria-hidden="true" />
                  Revocar
                </button>
              </article>
            );
          })}
        </section>
        <details className="pw-mcp-help">
          <summary>Cómo conectar tu agente</summary>
          <p>
            Usa Streamable HTTP si tu agente admite una URL MCP con cabeceras. Para clientes que usan un proceso local, utiliza el adaptador stdio del
            repositorio.
          </p>
          <label className="pw-field" htmlFor={`${prefix}-format`}>
            Tipo de conexión
            <select id={`${prefix}-format`} value={configuration} onChange={event => setConfiguration(event.target.value as typeof configuration)}>
              <option value="http">Streamable HTTP · URL remota</option>
              <option value="stdio">stdio · Adaptador local</option>
            </select>
          </label>
          <pre tabIndex={0} aria-label="Ejemplo de configuración MCP">
            {configuration === 'http' ? httpConfiguration : stdioConfiguration}
          </pre>
          <p className="faint">
            Sustituye los marcadores por tu clave y, si usas stdio, por la ruta local del repositorio. La forma de declarar la conexión puede variar según el
            agente.
          </p>
          <a href={documentation} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
            <ExternalLink size={14} aria-hidden="true" />
            Guía de conexión para otros agentes
          </a>
        </details>
      </div>
      {revoking && (
        <Dialog title="Revocar conexión MCP" busy={busy} onClose={() => setRevoking(null)}>
          <div className="pw-form-body">
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <p>
              Vas a revocar <strong>{revoking.name}</strong>. El agente dejará de poder usar esta clave. Tus proyectos y tareas se conservan.
            </p>
          </div>
          <div className="pw-form-footer">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setRevoking(null)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void revoke()}>
              {busy ? 'Revocando…' : 'Revocar conexión'}
            </button>
          </div>
        </Dialog>
      )}
    </SettingsDisclosure>
  );
}
