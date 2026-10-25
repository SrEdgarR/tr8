import { cloneElement, useId, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, ArrowLeftRight, CalendarClock, Download, KeyRound, LockKeyhole, Plus, ShieldCheck, Wallet, FileUp } from 'lucide-react';
import { Busy, Dialog, ErrorNotice } from '../../workspace/ui';
import { useFinance } from './useFinance';
import type { FinanceApi } from './api';
import type { FinancialSnapshot } from '../domain/workspace-types';
import type { FinancialOperation } from '../domain/types';
import { addAccount, addEntry, prepareEntryOperation } from '../domain/workspace';
import { addPairedOperation, addRefund, preparePairedOperation, refundableExpenses } from '../domain/connected-operations';
import { addPlan, filterHistory, projectSnapshot, resolvePlan } from '../domain/plans';
import { calculateFinancialBalances } from '../domain/balances';
import { formatMoneyMinor, localToday, parseAmountMinor } from '../domain/money';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../domain/categories';
import './finance.css';

type Finance = ReturnType<typeof useFinance>;
const kinds = { income: 'Ingreso', expense: 'Gasto', transfer: 'Transferencia', 'card-payment': 'Pago de tarjeta', refund: 'Reembolso' };
const categoryNames: Record<string, string> = {
  food: 'Comida',
  transport: 'Transporte',
  home: 'Hogar',
  health: 'Salud',
  leisure: 'Ocio',
  shopping: 'Compras',
  services: 'Servicios',
  other: 'Otros',
  salary: 'Sueldo',
  freelance: 'Trabajo independiente',
  business: 'Negocio',
  investment: 'Inversión',
  gift: 'Regalo',
  refund: 'Reembolso',
};
const id = () => crypto.randomUUID();
function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const fieldId = useId();
  return (
    <div className="pw-field">
      <label htmlFor={fieldId}>{label}</label>
      {cloneElement(children, { id: fieldId })}
    </div>
  );
}
function Secret({ label, value, onChange, minLength }: { label: string; value: string; onChange: (v: string) => void; minLength?: number }) {
  return (
    <Field label={label}>
      <input
        required
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={e => onChange(e.target.value)}
        minLength={minLength}
        maxLength={1024}
      />
    </Field>
  );
}
function PrivateForm({ children, onSubmit, busy, label }: { children: ReactNode; onSubmit: () => void; busy: boolean; label: string }) {
  return (
    <form
      className="tf-form"
      autoComplete="off"
      onSubmit={e => {
        e.preventDefault();
        if (!busy) onSubmit();
      }}
    >
      <fieldset disabled={busy}>
        {children}
        <button className="btn btn-primary" type="submit">
          {busy ? 'Procesando…' : label}
        </button>
      </fieldset>
    </form>
  );
}

export default function FinancePage({ api }: { api: FinanceApi }) {
  const finance = useFinance(api);
  const { view, busy } = finance;
  return (
    <section className="tf-page" aria-label="Finanzas personales">
      <header className="tf-heading">
        <div>
          <span className="tf-eyebrow">
            <Wallet size={14} aria-hidden="true" /> ESPACIO PERSONAL
          </span>
          <h1>Bóveda privada</h1>
          <p className="muted">Un espacio financiero independiente con contraseña privada y cifrado en tu dispositivo.</p>
        </div>
        {api.enabled && (
          <button className="btn btn-secondary" onClick={finance.lock}>
            <LockKeyhole size={15} aria-hidden="true" /> Bloquear
          </button>
        )}
      </header>
      {view.error && <ErrorNotice>{view.error}</ErrorNotice>}
      {view.stage === 'checking' ? (
        <Busy>Comprobando la bóveda…</Busy>
      ) : view.stage === 'unavailable' ? (
        <div className="tf-gate tf-card">
          <span className="tf-seal">
            <ShieldCheck size={28} aria-hidden="true" />
          </span>
          <span className="tf-tag">{api.enabled ? 'Bóveda bloqueada' : 'En preparación'}</span>
          <h2>Un espacio solo para tus finanzas</h2>
          <p>
            {api.enabled
              ? 'Confirma tu sesión para acceder. Si el servicio no puede verificar la versión actual, mantendrá la bóveda bloqueada.'
              : 'La interfaz financiera está preparada. El acceso a tu bóveda real sigue cerrado hasta completar la protección de restauración acordada.'}
          </p>
          <p className="muted">Tus proyectos y tareas siguen disponibles. No necesitas cambiar de plan.</p>
          {api.enabled && (
            <>
              <Reauthenticate finance={finance} />
              <button className="btn btn-secondary" onClick={() => void finance.refresh()}>
                Volver a comprobar
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          {api.syntheticOnly && (
            <p className="tf-test-note">
              <ShieldCheck size={14} aria-hidden="true" /> Entorno de prueba · Solo identidades y datos ficticios
            </p>
          )}
          {busy && (
            <div role="status" className="tf-progress">
              Protegiendo y verificando la operación…
            </div>
          )}
          <div key={view.formEpoch}>
            {(view.stage === 'empty' || view.stage === 'locked') && (busy ? <Busy>Verificando la operación privada…</Busy> : <Access finance={finance} />)}
            {view.stage === 'custody' && <Custody finance={finance} />}
            {view.stage === 'preview' && view.preview && <BackupPreview finance={finance} />}
            {view.stage === 'pending' && (
              <div className="tf-card">
                <h2>Guardado pendiente de confirmación</h2>
                <p>No se mostrarán los datos hasta recibir una confirmación válida. Reintentar envía exactamente el mismo guardado.</p>
                <button disabled={busy} className="btn btn-primary" onClick={() => void finance.retry()}>
                  Reintentar guardado
                </button>
                <p className="muted">Si bloqueas ahora, se descarta el reintento local. Al volver a abrir se leerá la versión del servidor.</p>
              </div>
            )}
            {view.stage === 'open' && view.snapshot && (
              <FinancialDashboard
                finance={finance}
                snapshot={view.snapshot}
                readOnly={finance.controller.current?.state().mode === 'recovery-readonly'}
                security={<Security finance={finance} readOnly={finance.controller.current?.state().mode === 'recovery-readonly'} />}
                recovery={<Recovery finance={finance} />}
              />
            )}
          </div>
        </>
      )}
      {api.resetVault && (
        <ResetVault api={api} onLock={finance.lock} disabled={busy || view.stage === 'checking' || view.stage === 'custody' || view.stage === 'pending'} />
      )}
    </section>
  );
}
function ResetVault({ api, onLock, disabled }: { api: FinanceApi; onLock: () => void; disabled: boolean }) {
  const [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <details className="tf-card">
      <summary>Reiniciar mi bóveda</summary>
      <p>
        Elimina definitivamente tus datos financieros y retira esta bóveda. Tus proyectos y tareas se conservan. Descarga antes un respaldo si todavía puedes
        abrirla.
      </p>
      <PrivateForm
        busy={busy || disabled}
        label="Eliminar bóveda y cerrar sesión"
        onSubmit={() => {
          if (confirmation !== 'ELIMINAR BÓVEDA' || !api.resetVault) return;
          onLock();
          setBusy(true);
          setError('');
          void api
            .resetVault(password, confirmation)
            .catch(() => {
              setError('No se pudo confirmar el reinicio. Comprueba tu contraseña de TR8 y la conexión antes de volver a intentarlo.');
            })
            .finally(() => {
              setBusy(false);
              setPassword('');
              setConfirmation('');
            });
        }}
      >
        <Secret label="Contraseña de TR8 para reiniciar la bóveda" value={password} onChange={setPassword} />
        <Field label="Escribe ELIMINAR BÓVEDA">
          <input required value={confirmation} onChange={e => setConfirmation(e.target.value)} pattern="ELIMINAR BÓVEDA" autoComplete="off" />
        </Field>
      </PrivateForm>
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </details>
  );
}

function Access({ finance: f }: { finance: Finance }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [kind, setKind] = useState<'password' | 'recovery'>('password');
  const creating = f.view.stage === 'empty';
  return (
    <div className="tf-access">
      <div className="tf-card">
        <LockKeyhole size={24} aria-hidden="true" />
        <h2>{creating ? 'Crea tu bóveda privada' : 'Abre tu bóveda'}</h2>
        <p className="muted">La contraseña privada es independiente de tu contraseña de TR8. Solo se utiliza en este dispositivo para descifrar tus datos.</p>
        <PrivateForm
          busy={f.busy}
          label={creating ? 'Crear bóveda' : 'Abrir bóveda'}
          onSubmit={() => {
            if (!creating || password === confirmation) void (creating ? f.create(password) : f.unlock({ kind, value: password }));
          }}
        >
          {!creating && (
            <Field label="Medio de acceso">
              <select
                value={kind}
                onChange={e => {
                  setKind(e.target.value as typeof kind);
                  setPassword('');
                }}
              >
                <option value="password">Contraseña privada</option>
                <option value="recovery">Código de recuperación · Solo lectura</option>
              </select>
            </Field>
          )}
          <Secret
            label={kind === 'password' ? 'Contraseña privada' : 'Código de recuperación completo'}
            value={password}
            onChange={setPassword}
            minLength={creating ? 16 : undefined}
          />
          {creating && (
            <>
              <p className="muted">Utiliza al menos 16 caracteres para tu contraseña privada.</p>
              <Secret label="Repite la contraseña privada" value={confirmation} onChange={setConfirmation} minLength={16} />
              <p className="muted">Guarda la contraseña y el código de recuperación fuera de TR8. Si pierdes ambos, no podremos recuperar tus finanzas.</p>
              {password !== confirmation && <span role="status">Las contraseñas deben coincidir.</span>}
            </>
          )}
        </PrivateForm>
      </div>
      <div className="tf-card">
        <FileUp size={22} aria-hidden="true" />
        <h2>Respaldo cifrado</h2>
        <p className="muted">Importa en una bóveda vacía o revisa una restauración de esta misma bóveda. Siempre verás una vista previa antes de guardar.</p>
        <ImportForm finance={f} restore={!creating} />
        <details>
          <summary>Confirmar sesión de TR8</summary>
          <Reauthenticate finance={f} />
        </details>
      </div>
    </div>
  );
}
function Reauthenticate({ finance: f }: { finance: Finance }) {
  const [password, set] = useState('');
  return (
    <PrivateForm busy={f.busy} label="Confirmar sesión" onSubmit={() => void f.reauthenticate(password)}>
      <Secret label="Contraseña de tu cuenta TR8" value={password} onChange={set} />
      <p className="muted">Después, vuelve a abrir la bóveda con tu contraseña privada.</p>
    </PrivateForm>
  );
}
function Custody({ finance: f }: { finance: Finance }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  return (
    <div className="tf-card tf-custody">
      <KeyRound size={26} aria-hidden="true" />
      <h2>Guarda tu código de recuperación</h2>
      <p>Este código abre tu bóveda. Guárdalo en un lugar privado fuera de TR8 y vuelve a escribirlo completo para confirmar su custodia.</p>
      <code className="tf-recovery">{f.view.recovery}</code>
      <p className="muted">Todavía no se ha guardado el cambio. Bloquear descarta esta preparación.</p>
      <PrivateForm busy={f.busy} label="Confirmar custodia y guardar" onSubmit={() => void f.custody(password, code)}>
        <Secret label="Contraseña privada elegida" value={password} onChange={setPassword} />
        <Secret label="Reescribe el código completo" value={code} onChange={setCode} />
      </PrivateForm>
    </div>
  );
}
function ImportForm({ finance: f, restore }: { finance: Finance; restore: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<'password' | 'recovery'>('password');
  return (
    <PrivateForm
      busy={f.busy}
      label="Revisar respaldo"
      onSubmit={() => {
        if (file) void f.previewFile(file, { kind, value }, restore);
      }}
    >
      <Field label="Archivo cifrado JSON · Máximo 2 MiB">
        <input type="file" required accept="application/json,.json" onChange={e => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <Field label="Medio para abrir el respaldo">
        <select
          value={kind}
          onChange={e => {
            setKind(e.target.value as typeof kind);
            setValue('');
          }}
        >
          <option value="password">Contraseña privada</option>
          <option value="recovery">Código de recuperación</option>
        </select>
      </Field>
      <Secret label="Contraseña o código del respaldo" value={value} onChange={setValue} />
    </PrivateForm>
  );
}
function BackupPreview({ finance: f }: { finance: Finance }) {
  const s = f.view.preview!.summary;
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  return (
    <div className="tf-card">
      <h2>{f.view.restore ? 'Revisar restauración' : 'Revisar importación'}</h2>
      <p>
        {s.accounts} cuentas · {s.operations} movimientos · {s.plans} planes
      </p>
      <p>Monedas: {s.currencies.join(', ') || 'Ninguna'}</p>
      {s.requiresUpgrade && <p>Se actualizará el formato del respaldo conservando sus registros.</p>}
      <p>
        {f.view.restore
          ? 'La restauración sustituye el contenido actual de esta bóveda. Guarda antes un respaldo de su versión actual.'
          : 'Se creará una bóveda con contraseña y código de recuperación nuevos.'}
      </p>
      <PrivateForm
        busy={f.busy}
        label={f.view.restore ? 'Restaurar contenido' : 'Importar y preparar custodia'}
        onSubmit={() => {
          if (!f.view.restore || confirm === 'RESTAURAR') void f.acceptPreview(password);
        }}
      >
        {f.view.restore ? (
          <Field label="Escribe RESTAURAR para confirmar">
            <input required pattern="RESTAURAR" value={confirm} onChange={e => setConfirm(e.target.value)} />
          </Field>
        ) : (
          <Secret label="Nueva contraseña privada" value={password} onChange={setPassword} minLength={16} />
        )}
      </PrivateForm>
      <button className="btn btn-secondary" disabled={f.busy} onClick={f.lock}>
        Cancelar y bloquear
      </button>
    </div>
  );
}

type DashboardFinance = Pick<Finance, 'busy' | 'save'>;
export function FinancialDashboard({
  finance: f,
  snapshot,
  readOnly = false,
  security,
  recovery,
}: {
  finance: DashboardFinance;
  snapshot: FinancialSnapshot;
  readOnly?: boolean;
  security: ReactNode;
  recovery?: ReactNode;
}) {
  const [tab, setTab] = useState('Resumen');
  const [editor, setEditor] = useState<'account' | 'movement' | null>(null);
  return (
    <>
      <nav className="tf-tabs" aria-label="Secciones de finanzas">
        {['Resumen', 'Cuentas', 'Movimientos', 'Planes', 'Seguridad'].map(name => (
          <button key={name} aria-current={tab === name ? 'page' : undefined} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </nav>
      {readOnly && (
        <div className="tf-card">
          <h2>Acceso de recuperación · Solo lectura</h2>
          <p>Para volver a guardar, establece una contraseña nueva y confirma un código de recuperación nuevo.</p>
          {recovery}
        </div>
      )}
      {tab !== 'Seguridad' && (
        <div className="tf-toolbar">
          <span className="muted">
            {snapshot.financialSpace.accounts.length} cuentas · {snapshot.financialSpace.operations.length} movimientos
          </span>
          <div className="tf-actions">
            <button className="btn btn-secondary" disabled={f.busy || readOnly} onClick={() => setEditor('account')}>
              <Plus size={14} aria-hidden="true" /> Nueva cuenta
            </button>
            <button className="btn btn-primary" disabled={f.busy || readOnly || !snapshot.financialSpace.accounts.length} onClick={() => setEditor('movement')}>
              <Plus size={14} aria-hidden="true" /> Nuevo movimiento
            </button>
          </div>
        </div>
      )}
      {(tab === 'Resumen' || tab === 'Cuentas') && <Overview snapshot={snapshot} accountsOnly={tab === 'Cuentas'} />}
      {tab === 'Movimientos' && <History snapshot={snapshot} />}
      {tab === 'Planes' && <Plans snapshot={snapshot} finance={f} readOnly={readOnly} />}
      {tab === 'Seguridad' && security}
      {editor && (
        <RecordForm kind={editor} snapshot={snapshot} busy={f.busy} onClose={() => setEditor(null)} onSave={s => void f.save(s).then(() => setEditor(null))} />
      )}
    </>
  );
}
function Recovery({ finance: f }: { finance: Finance }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  return (
    <PrivateForm busy={f.busy} label="Preparar nuevos medios de acceso" onSubmit={() => void f.recover(code, password)}>
      <Secret label="Código de recuperación actual" value={code} onChange={setCode} />
      <Secret label="Nueva contraseña privada" value={password} onChange={setPassword} minLength={16} />
    </PrivateForm>
  );
}
function Overview({ snapshot, accountsOnly }: { snapshot: FinancialSnapshot; accountsOnly: boolean }) {
  const space = snapshot.financialSpace;
  const [date, setDate] = useState(localToday());
  const [target, setTarget] = useState(localToday(new Date(Date.now() + 30 * 86400000)));
  const [projection, setProjection] = useState<ReturnType<typeof projectSnapshot> | null>(null);
  const [error, setError] = useState('');
  let balances: ReturnType<typeof calculateFinancialBalances> | null = null;
  let balanceError = '';
  try {
    balances = calculateFinancialBalances(space.accounts, space.operations, date, space.currencyDefinitions);
  } catch {
    balanceError = 'Selecciona una fecha igual o posterior a la apertura de tus cuentas.';
  }
  const money = (n: number, c: string) =>
    formatMoneyMinor(
      n,
      space.currencyDefinitions.find(d => d.code === c)!,
    );
  return (
    <>
      <div className="tf-toolbar">
        <h2>{accountsOnly ? 'Tus cuentas' : 'Panorama financiero'}</h2>
        <Field label="Saldos a fecha">
          <input
            type="date"
            required
            value={date}
            onChange={e => {
              setDate(e.target.value);
              setProjection(null);
            }}
          />
        </Field>
      </div>
      {balanceError && <ErrorNotice>{balanceError}</ErrorNotice>}
      {!accountsOnly && (
        <div className="tf-grid">
          {balances?.currencies.map(c => (
            <article className="tf-card tf-balance" key={c.currency}>
              <span className="tf-tag">{c.currency}</span>
              <p className="muted">Patrimonio neto</p>
              <strong>{money(c.netWorthMinor, c.currency)}</strong>
              <dl>
                <div>
                  <dt>Dinero disponible</dt>
                  <dd>{money(c.liquidMinor, c.currency)}</dd>
                </div>
                <div>
                  <dt>Deuda de tarjetas</dt>
                  <dd>{money(c.creditDebtMinor, c.currency)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
      {!space.accounts.length ? (
        <div className="tf-card tf-gate">
          <Wallet size={26} aria-hidden="true" />
          <h2>Empieza con tu primera cuenta</h2>
          <p className="muted">Añade efectivo, una cuenta bancaria o una tarjeta. Cada moneda conservará sus propios saldos.</p>
        </div>
      ) : (
        <div className="tf-grid">
          {space.accounts.map(a => {
            const b = balances?.accounts.find(b => b.accountId === a.id);
            return (
              <article key={a.id} className="tf-card">
                <Wallet size={18} aria-hidden="true" />
                <h3>{a.name}</h3>
                <p className="muted">
                  {a.type === 'credit' ? 'Tarjeta de crédito' : a.type === 'cash' ? 'Efectivo' : 'Cuenta bancaria'} · {a.currency}
                </p>
                <strong className="tf-amount">{b ? money(b.balanceMinor, a.currency) : '—'}</strong>
                {a.type === 'credit' && b && <p className="muted">Crédito disponible: {money(b.availableCreditMinor!, a.currency)}</p>}
                <p className="muted">Apertura: {a.openingDate}</p>
              </article>
            );
          })}
        </div>
      )}
      {!accountsOnly && space.accounts.length > 0 && (
        <div className="tf-card">
          <h2>
            <CalendarClock size={18} aria-hidden="true" /> Proyección
          </h2>
          <p className="muted">
            Estimación con los planes pendientes de fecha futura dentro del horizonte. Los planes no alteran tu saldo real y las monedas no se suman entre sí.
          </p>
          <form
            className="tf-actions"
            onSubmit={e => {
              e.preventDefault();
              try {
                if (target < date || Date.parse(target) - Date.parse(date) > 366 * 86400000)
                  throw Error('Elige un horizonte de hasta un año posterior a la fecha de saldo.');
                setProjection(projectSnapshot(snapshot, date, target));
                setError('');
              } catch (error) {
                setProjection(null);
                setError(error instanceof Error ? error.message : 'No se pudo calcular.');
              }
            }}
          >
            <Field label="Proyectar hasta">
              <input
                required
                type="date"
                value={target}
                onChange={e => {
                  setTarget(e.target.value);
                  setProjection(null);
                }}
              />
            </Field>
            <button className="btn btn-secondary">Calcular proyección</button>
          </form>
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {projection && (
            <div className="tf-grid">
              {projection.projected.currencies.map(c => (
                <div key={c.currency} className="tf-projected">
                  <span>{c.currency} · Patrimonio proyectado</span>
                  <strong>{money(c.netWorthMinor, c.currency)}</strong>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function History({ snapshot }: { snapshot: FinancialSnapshot }) {
  const s = snapshot.financialSpace;
  const [account, setAccount] = useState('');
  const [currency, setCurrency] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [visible, setVisible] = useState(50);
  const invalid = !!from && !!to && from > to;
  const rows = invalid
    ? []
    : filterHistory(snapshot, {
        ...(account ? { accountId: account } : {}),
        ...(currency ? { currency } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      });
  return (
    <div className="tf-card">
      <h2>Movimientos confirmados</h2>
      <div className="tf-filters">
        <Field label="Cuenta">
          <select value={account} onChange={e => setAccount(e.target.value)}>
            <option value="">Todas las cuentas</option>
            {s.accounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Moneda">
          <select value={currency} onChange={e => setCurrency(e.target.value)}>
            <option value="">Todas las monedas</option>
            {s.currencyDefinitions.map(c => (
              <option key={c.code}>{c.code}</option>
            ))}
          </select>
        </Field>
        <Field label="Desde">
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </Field>
        <Field label="Hasta">
          <input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </Field>
      </div>
      {invalid && <ErrorNotice>La fecha inicial debe ser anterior a la final.</ErrorNotice>}
      <div className="tf-ledger">
        {rows.slice(0, visible).map(op => (
          <OperationRow key={op.id} operation={op} snapshot={snapshot} />
        ))}
        {!rows.length && !invalid && <p className="muted">No hay movimientos para estos filtros.</p>}
        {rows.length > visible && (
          <button className="btn btn-secondary" onClick={() => setVisible(n => n + 50)}>
            Mostrar más movimientos ({visible} de {rows.length})
          </button>
        )}
      </div>
    </div>
  );
}
function OperationRow({ operation: o, snapshot }: { operation: FinancialOperation & { description: string; note: string }; snapshot: FinancialSnapshot }) {
  const s = snapshot.financialSpace;
  const names = ('accountId' in o ? [o.accountId] : o.kind === 'refund' ? [o.destinationAccountId] : [o.fromAccountId, o.toAccountId])
    .map(id => s.accounts.find(a => a.id === id)?.name)
    .join(' → ');
  return (
    <div className="tf-row">
      <span className={`tf-operation-icon ${o.kind}`}>
        {o.kind === 'income' ? (
          <ArrowDownLeft size={17} aria-hidden="true" />
        ) : o.kind === 'expense' ? (
          <ArrowUpRight size={17} aria-hidden="true" />
        ) : (
          <ArrowLeftRight size={17} aria-hidden="true" />
        )}
      </span>
      <div className="tf-row-copy">
        <strong>{o.description}</strong>
        <span className="muted">
          {kinds[o.kind]} · {names} · {o.date}
        </span>
        {o.note && <small>{o.note}</small>}
      </div>
      <strong className="tf-money">
        {formatMoneyMinor(
          o.amountMinor,
          s.currencyDefinitions.find(c => c.code === o.currency)!,
        )}
      </strong>
    </div>
  );
}

function RecordForm({
  kind,
  snapshot,
  busy,
  onClose,
  onSave,
}: {
  kind: 'account' | 'movement';
  snapshot: FinancialSnapshot;
  busy: boolean;
  onClose: () => void;
  onSave: (s: FinancialSnapshot) => void;
}) {
  const s = snapshot.financialSpace;
  const [error, setError] = useState('');
  const [type, setType] = useState('cash');
  const [operation, setOperation] = useState<FinancialOperation['kind']>('expense');
  const [account, setAccount] = useState(s.accounts[0]?.id ?? '');
  const [currency, setCurrency] = useState(s.currencyDefinitions[0].code);
  const [planned, setPlanned] = useState(false);
  const selected = s.accounts.find(a => a.id === account);
  const digits = s.currencyDefinitions.find(c => c.code === (kind === 'account' ? currency : selected?.currency))?.minorUnitDigits ?? 2;
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const data = new FormData(e.currentTarget);
    const text = (k: string) => String(data.get(k) ?? '');
    try {
      const amount = parseAmountMinor(text('amount'), digits, kind === 'account' ? { allowZero: true, allowNegative: true } : {});
      let next: FinancialSnapshot;
      if (kind === 'account') {
        next = addAccount(snapshot, {
          id: id(),
          name: text('name'),
          type,
          currency,
          openingBalanceMinor: amount,
          openingDate: text('date'),
          ...(type === 'credit' ? { creditLimitMinor: parseAmountMinor(text('limit'), digits, { allowZero: true }) } : {}),
        });
      } else {
        const base = { id: id(), date: text('date'), amountMinor: amount, description: text('description'), note: text('note') };
        if (operation === 'refund') {
          next = addRefund(snapshot, { ...base, originalExpenseId: text('expense'), destinationAccountId: account });
        } else {
          const input =
            operation === 'income' || operation === 'expense'
              ? { ...base, kind: operation, accountId: account, category: text('category') }
              : { ...base, kind: operation, fromAccountId: account, toAccountId: text('to') };
          next = planned
            ? addPlan(snapshot, {
                id: id(),
                operation: operation === 'income' || operation === 'expense' ? prepareEntryOperation(snapshot, input) : preparePairedOperation(snapshot, input),
              })
            : operation === 'income' || operation === 'expense'
              ? addEntry(snapshot, input)
              : addPairedOperation(snapshot, input);
        }
      }
      onSave(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Revisa los datos del formulario.');
    }
  }
  return (
    <Dialog title={kind === 'account' ? 'Nueva cuenta' : 'Nuevo movimiento'} onClose={onClose} busy={busy}>
      <form className="pw-form" onSubmit={submit} autoComplete="off">
        <fieldset disabled={busy} className="tf-form-fields">
          <div className="pw-form-body">
            {error && <ErrorNotice>{error}</ErrorNotice>}
            {kind === 'account' ? (
              <>
                <Field label="Nombre de la cuenta">
                  <input name="name" required maxLength={120} data-initial-focus />
                </Field>
                <Field label="Tipo de cuenta">
                  <select value={type} onChange={e => setType(e.target.value)}>
                    <option value="cash">Efectivo</option>
                    <option value="debit">Cuenta bancaria</option>
                    <option value="credit">Tarjeta de crédito</option>
                  </select>
                </Field>
                <Field label="Moneda de la cuenta">
                  <select value={currency} onChange={e => setCurrency(e.target.value)}>
                    {s.currencyDefinitions.map(c => (
                      <option key={c.code}>{c.code}</option>
                    ))}
                  </select>
                </Field>
              </>
            ) : (
              <>
                <Field label="Tipo de movimiento">
                  <select
                    value={operation}
                    onChange={e => {
                      setOperation(e.target.value as typeof operation);
                      setPlanned(false);
                    }}
                  >
                    {Object.entries(kinds).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Descripción">
                  <input name="description" maxLength={500} required data-initial-focus />
                </Field>
                <Field label={operation === 'refund' ? 'Cuenta de destino' : 'Cuenta de origen'}>
                  <select required value={account} onChange={e => setAccount(e.target.value)}>
                    {s.accounts.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {a.currency}
                      </option>
                    ))}
                  </select>
                </Field>
                {(operation === 'transfer' || operation === 'card-payment') && (
                  <Field label="Cuenta de destino">
                    <select name="to" required>
                      <option value="">Selecciona una cuenta</option>
                      {s.accounts
                        .filter(
                          a => a.id !== account && a.currency === selected?.currency && (operation === 'transfer' ? a.type !== 'credit' : a.type === 'credit'),
                        )
                        .map(a => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                )}
                {operation === 'refund' && (
                  <Field label="Gasto que se reembolsa">
                    <select name="expense" required>
                      <option value="">Selecciona el gasto original</option>
                      {refundableExpenses(snapshot)
                        .filter(r => r.remainingMinor > 0 && r.expense.currency === selected?.currency)
                        .map(r => (
                          <option key={r.expense.id} value={r.expense.id}>
                            {r.expense.description} · Pendiente{' '}
                            {formatMoneyMinor(
                              r.remainingMinor,
                              s.currencyDefinitions.find(c => c.code === r.expense.currency)!,
                            )}
                          </option>
                        ))}
                    </select>
                  </Field>
                )}
                {(operation === 'income' || operation === 'expense') && (
                  <Field label="Categoría">
                    <select key={operation} name="category">
                      {(operation === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map(c => (
                        <option key={c} value={c}>
                          {categoryNames[c]}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </>
            )}
            <Field
              label={
                kind === 'account'
                  ? type === 'credit'
                    ? 'Deuda inicial (negativa si tienes saldo a favor)'
                    : 'Saldo inicial'
                  : `Importe · ${selected?.currency ?? ''}`
              }
            >
              <input name="amount" required inputMode="decimal" defaultValue={kind === 'account' ? '0' : undefined} placeholder="0,00" />
            </Field>
            {kind === 'account' && type === 'credit' && (
              <Field label="Límite de crédito">
                <input name="limit" inputMode="decimal" required defaultValue="0" />
              </Field>
            )}
            <Field label={kind === 'account' ? 'Fecha de apertura' : 'Fecha del movimiento'}>
              <input name="date" type="date" required defaultValue={localToday()} max={kind === 'account' ? localToday() : undefined} />
            </Field>
            {kind === 'movement' && (
              <>
                <Field label="Nota opcional">
                  <textarea name="note" maxLength={1024} rows={2} />
                </Field>
                {operation !== 'refund' && (
                  <label className="tf-checkbox">
                    <input type="checkbox" checked={planned} onChange={e => setPlanned(e.target.checked)} /> Guardar como plan pendiente; no afecta al saldo
                    real
                  </label>
                )}
              </>
            )}
          </div>
          <div className="pw-form-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn btn-primary" type="submit">
              {busy ? 'Guardando…' : planned ? 'Guardar plan' : 'Guardar'}
            </button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

function Plans({ snapshot, finance: f, readOnly }: { snapshot: FinancialSnapshot; finance: DashboardFinance; readOnly: boolean }) {
  const [action, setAction] = useState<{ id: string; type: 'confirm' | 'cancel' | 'postpone' } | null>(null);
  const [date, setDate] = useState(localToday());
  const [error, setError] = useState('');
  return (
    <div className="tf-card">
      <h2>Planes</h2>
      <p className="muted">Confirmar un plan registra un movimiento real una sola vez.</p>
      {(snapshot.financialSpace.plans ?? []).map(p => (
        <div key={p.id} className="tf-plan">
          <OperationRow operation={p.operation} snapshot={snapshot} />
          <div className="tf-actions">
            <span className="tf-tag">{p.status === 'pending' ? 'Pendiente' : p.status === 'confirmed' ? 'Confirmado' : 'Cancelado'}</span>
            {p.status === 'pending' &&
              (['confirm', 'postpone', 'cancel'] as const).map(type => (
                <button
                  key={type}
                  className="btn btn-secondary"
                  disabled={readOnly || f.busy}
                  onClick={() => {
                    setDate(type === 'postpone' ? p.operation.date : localToday());
                    setError('');
                    setAction({ id: p.id, type });
                  }}
                >
                  {type === 'confirm' ? 'Confirmar' : type === 'postpone' ? 'Posponer' : 'Cancelar plan'}
                </button>
              ))}
          </div>
        </div>
      ))}
      {!snapshot.financialSpace.plans?.length && <p className="muted">Crea un movimiento y marca «Guardar como plan pendiente».</p>}
      {action && (
        <Dialog
          title={action.type === 'confirm' ? 'Confirmar movimiento real' : action.type === 'postpone' ? 'Posponer plan' : 'Cancelar plan'}
          busy={f.busy}
          onClose={() => setAction(null)}
        >
          <PrivateForm
            busy={f.busy}
            label="Confirmar acción"
            onSubmit={() => {
              try {
                void f.save(resolvePlan(snapshot, { type: action.type, planId: action.id, date })).then(() => setAction(null));
              } catch (error) {
                setError(error instanceof Error ? error.message : 'No se pudo resolver el plan.');
              }
            }}
          >
            <p>
              {action.type === 'confirm'
                ? 'Se añadirá el movimiento al historial y cambiará tu saldo.'
                : action.type === 'postpone'
                  ? 'Cambiará la fecha prevista.'
                  : 'El plan conservará su historial sin afectar al saldo.'}
            </p>
            <Field label={action.type === 'postpone' ? 'Nueva fecha prevista' : 'Fecha de resolución'}>
              <input required type="date" value={date} onChange={e => setDate(e.target.value)} />
            </Field>
            {error && <ErrorNotice>{error}</ErrorNotice>}
          </PrivateForm>
        </Dialog>
      )}
    </div>
  );
}
function Security({ finance: f, readOnly }: { finance: Finance; readOnly: boolean }) {
  const [old, setOld] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [rekeyConfirm, setRekeyConfirm] = useState('');
  return (
    <div className="tf-security">
      <div className="tf-card">
        <h2>
          <Download size={18} aria-hidden="true" /> Respaldo cifrado
        </h2>
        <p className="muted">El archivo conserva el cifrado. Guarda también tus medios de acceso fuera de TR8.</p>
        <button className="btn btn-secondary" disabled={f.busy} onClick={() => void f.exportBackup()}>
          Descargar respaldo cifrado
        </button>
      </div>
      {!readOnly && (
        <>
          <details className="tf-card">
            <summary>Confirmar sesión de TR8</summary>
            <p className="muted">Confirma tu cuenta antes de cambiar los medios privados de acceso. Después tendrás que abrir de nuevo la bóveda.</p>
            <Reauthenticate finance={f} />
          </details>
          <details className="tf-card">
            <summary>Cambiar contraseña privada</summary>
            <PrivateForm busy={f.busy} label="Cambiar contraseña" onSubmit={() => void f.rotatePassword(old, next, confirm)}>
              <Secret label="Contraseña privada actual" value={old} onChange={setOld} />
              <Secret label="Nueva contraseña privada" value={next} onChange={setNext} minLength={16} />
              <Secret label="Repite la nueva contraseña" value={confirm} onChange={setConfirm} />
            </PrivateForm>
          </details>
          <details className="tf-card">
            <summary>Renovar código de recuperación</summary>
            <PrivateForm busy={f.busy} label="Preparar código nuevo" onSubmit={() => void f.rotateRecovery(old)}>
              <p className="muted">El código anterior dejará de abrir la versión nueva tras confirmar el guardado.</p>
              <Secret label="Contraseña privada actual" value={old} onChange={setOld} />
            </PrivateForm>
          </details>
          <details className="tf-card">
            <summary>Renovar clave de cifrado y medios de acceso</summary>
            <PrivateForm
              busy={f.busy}
              label="Preparar renovación completa"
              onSubmit={() => {
                if (rekeyConfirm === 'RENOVAR') void f.rekey(next);
              }}
            >
              <p className="muted">Cifrará de nuevo la bóveda y generará otro código. Los respaldos antiguos conservan sus claves anteriores.</p>
              <Secret label="Nueva contraseña privada" value={next} onChange={setNext} minLength={16} />
              <Field label="Escribe RENOVAR">
                <input value={rekeyConfirm} onChange={e => setRekeyConfirm(e.target.value)} pattern="RENOVAR" required />
              </Field>
            </PrivateForm>
          </details>
          <details className="tf-card">
            <summary>Restaurar desde un respaldo</summary>
            <p className="muted">Sustituye el contenido actual de esta misma bóveda después de revisar su vista previa.</p>
            <ImportForm finance={f} restore />
          </details>
        </>
      )}
      <div className="tf-card">
        <h2>
          <LockKeyhole size={18} aria-hidden="true" /> Bloqueo privado
        </h2>
        <p className="muted">
          La vista se limpia al ocultar la pestaña, salir de Finanzas o cerrar sesión. La bóveda se bloquea tras cinco minutos sin actividad.
        </p>
        <button className="btn btn-secondary" onClick={f.lock}>
          Bloquear ahora
        </button>
      </div>
    </div>
  );
}
