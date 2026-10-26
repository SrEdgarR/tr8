import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, FileUp, ShieldCheck, Wallet } from 'lucide-react';
import FinancePage, { FinancialDashboard } from './FinancePage';
import type { FinanceApi } from './api';
import type { AccountFinanceApi, AccountFinanceRecord, AccountFinanceWrite } from './account-api';
import { validateFinancialSnapshot } from '../domain/snapshot';
import { MAX_PLAINTEXT_BYTES, parseStrictJson } from '../compatibility/protocol';
import type { FinancialSnapshot } from '../domain/workspace-types';
import { Busy, ErrorNotice } from '../../workspace/ui';
import './finance.css';
export default function PersonalFinancePage({ accountApi, vaultApi }: { accountApi: AccountFinanceApi; vaultApi: FinanceApi }) {
  const [vault, setVault] = useState(false);
  if (vault)
    return (
      <>
        <button className="btn btn-secondary" onClick={() => setVault(false)}>
          <ArrowLeft size={15} aria-hidden="true" />
          Volver a Finanzas
        </button>
        <FinancePage api={vaultApi} />
      </>
    );
  return <AccountFinancePage api={accountApi} onVault={() => setVault(true)} />;
}
function errorMessage(error: unknown) {
  return error && typeof error === 'object' && 'code' in error && error.code === 'PT409'
    ? 'Tus finanzas cambiaron en otra sesión. Recarga para consultar la versión actual.'
    : 'No se pudo confirmar la operación. Puedes reintentar el mismo guardado o recargar la versión guardada.';
}
function AccountFinancePage({ api, onVault }: { api: AccountFinanceApi; onVault: () => void }) {
  const [record, setRecord] = useState<AccountFinanceRecord | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pending, setPending] = useState<AccountFinanceWrite | null>(null);
  const generation = useRef(0),
    saving = useRef(false),
    current = useRef<AccountFinanceRecord | null>(null);
  useEffect(() => {
    const ticket = ++generation.current;
    current.current = null;
    setRecord(null);
    setPending(null);
    setError('');
    setBusy(false);
    saving.current = false;
    const unsubscribe = api.subscribe?.(() => {
      generation.current++;
      current.current = null;
      setRecord(null);
      setPending(null);
      setBusy(false);
      saving.current = false;
      setError('Tu sesión cambió. Vuelve a iniciar sesión.');
    });
    void api.load().then(
      value => {
        if (ticket === generation.current) {
          current.current = value;
          setRecord(value);
        }
      },
      () => {
        if (ticket === generation.current) setError('No se pudieron cargar tus finanzas. Vuelve a intentarlo.');
      },
    );
    return () => {
      unsubscribe?.();
      // Request generation deliberately advances at cleanup; this is not a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      current.current = null;
    };
  }, [api]);
  async function reload() {
    if (saving.current) return;
    const ticket = ++generation.current;
    setBusy(true);
    try {
      const value = await api.load();
      if (ticket === generation.current) {
        current.current = value;
        setRecord(value);
        setPending(null);
        setError('');
      }
    } catch (e) {
      if (ticket === generation.current) setError(errorMessage(e));
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  }
  async function persist(write: AccountFinanceWrite) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    const ticket = generation.current;
    try {
      const saved = await api.save(write);
      if (ticket === generation.current) {
        current.current = saved;
        setRecord(saved);
        setPending(null);
      }
    } catch (e) {
      if (ticket === generation.current) {
        const denied = e && typeof e === 'object' && 'code' in e && ['42501', 'PGRST301', 'PGRST303'].includes(String(e.code));
        if (denied) {
          current.current = null;
          setRecord(null);
          setPending(null);
        } else setPending(write);
        setError(errorMessage(e));
      }
    } finally {
      if (ticket === generation.current) {
        saving.current = false;
        setBusy(false);
      }
    }
  }
  async function save(snapshot: FinancialSnapshot) {
    if (!current.current || pending || saving.current) return;
    await persist({ snapshot: validateFinancialSnapshot(snapshot), expectedVersion: current.current.version, operationId: crypto.randomUUID() });
  }
  const blocked = busy || pending !== null;
  return (
    <section className="tf-page" aria-label="Finanzas personales">
      <header className="tf-heading">
        <div>
          <span className="tf-eyebrow">
            <Wallet size={14} aria-hidden="true" />
            ESPACIO PERSONAL
          </span>
          <h1>Finanzas</h1>
          <p className="muted">Tus cuentas, tus planes y una visión clara de tu dinero.</p>
        </div>
      </header>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {pending && (
        <div className="tf-card">
          <h2>Guardado por comprobar</h2>
          <p>Reintentar envía el mismo cambio para evitar duplicados. Recargar consulta lo que ya está guardado.</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => void persist(pending)}>
            Reintentar guardado
          </button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => void reload()}>
            Recargar finanzas
          </button>
        </div>
      )}
      {!record ? (
        error ? (
          <button className="btn btn-secondary" disabled={busy} onClick={() => void reload()}>
            Volver a cargar
          </button>
        ) : (
          <Busy>Cargando tus finanzas…</Busy>
        )
      ) : (
        <>
          {busy && <div role="status">Guardando tus finanzas…</div>}
          <FinancialDashboard
            snapshot={record.snapshot}
            finance={{ busy: blocked, save }}
            security={<AccountSecurity snapshot={record.snapshot} busy={blocked} onSave={save} onVault={onVault} />}
          />
        </>
      )}
    </section>
  );
}
function AccountSecurity({
  snapshot,
  busy,
  onSave,
  onVault,
}: {
  snapshot: FinancialSnapshot;
  busy: boolean;
  onSave: (s: FinancialSnapshot) => Promise<void>;
  onVault: () => void;
}) {
  const [preview, setPreview] = useState<FinancialSnapshot | null>(null),
    [confirmation, setConfirmation] = useState(''),
    [error, setError] = useState('');
  const fileTicket = useRef(0);
  useEffect(
    () => () => {
      fileTicket.current++;
    },
    [],
  );
  function backup() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(validateFinancialSnapshot(snapshot))], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tr8-finanzas.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="tf-security">
      <div className="tf-card">
        <h2>
          <ShieldCheck size={18} aria-hidden="true" />
          Protección de tus finanzas
        </h2>
        <p>El acceso está protegido por tu cuenta de TR8. Este espacio no utiliza una contraseña privada ni cifrado privado de bóveda.</p>
        <button className="btn btn-secondary" disabled={busy} onClick={onVault}>
          Abrir bóveda cifrada opcional
        </button>
        <p className="muted">La bóveda guarda datos independientes. Abrirla no mueve ni cifra automáticamente los datos de este espacio.</p>
      </div>
      <div className="tf-card">
        <h2>
          <Download size={18} aria-hidden="true" />
          Respaldo de tus finanzas
        </h2>
        <p>Este archivo incluye tus datos financieros sin contraseña privada. Guárdalo en un lugar seguro.</p>
        <button className="btn btn-secondary" disabled={busy} onClick={backup}>
          Descargar respaldo JSON
        </button>
      </div>
      <details className="tf-card">
        <summary>
          <FileUp size={16} aria-hidden="true" />
          Restaurar un respaldo JSON
        </summary>
        <p>Revisa el contenido antes de sustituir tus finanzas actuales. Los respaldos cifrados se abren desde la bóveda.</p>
        <label>
          Archivo de finanzas JSON
          <input
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={event => {
              const ticket = ++fileTicket.current;
              const file = event.target.files?.[0];
              setPreview(null);
              setError('');
              setConfirmation('');
              if (!file) return;
              if (file.size > MAX_PLAINTEXT_BYTES) {
                setError('El archivo supera el tamaño permitido.');
                return;
              }
              void file
                .text()
                .then(value => {
                  const checked = validateFinancialSnapshot(parseStrictJson(value, { maxBytes: MAX_PLAINTEXT_BYTES }));
                  if (ticket === fileTicket.current) setPreview(checked);
                })
                .catch(() => {
                  if (ticket === fileTicket.current) setError('El respaldo no tiene un formato financiero compatible.');
                });
            }}
          />
        </label>
        {preview && (
          <form
            onSubmit={e => {
              e.preventDefault();
              if (confirmation === 'REEMPLAZAR' && !busy)
                void onSave(preview).then(() => {
                  setPreview(null);
                  setConfirmation('');
                });
            }}
          >
            <p>
              {preview.financialSpace.accounts.length} cuentas · {preview.financialSpace.operations.length} movimientos ·{' '}
              {preview.financialSpace.plans?.length ?? 0} planes
            </p>
            <label>
              Escribe REEMPLAZAR
              <input required pattern="REEMPLAZAR" value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy} />
            </label>
            <button className="btn btn-primary" disabled={busy}>
              Restaurar finanzas
            </button>
          </form>
        )}
        {error && <ErrorNotice>{error}</ErrorNotice>}
      </details>
    </div>
  );
}
