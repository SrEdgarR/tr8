import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  CalendarClock,
  Download,
  KeyRound,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Wallet,
  FileUp,
  MoreHorizontal,
  Landmark,
  Coins,
  CalendarDays,
  LayoutGrid,
  List,
  Tag,
  Pencil,
  Trash2,
} from 'lucide-react';
import { Busy, Dialog, ErrorNotice } from '../../workspace/ui';
import { useFinance } from './useFinance';
import type { FinanceApi } from './api';
import type { FinancialSnapshot, WorkspaceOperation } from '../domain/workspace-types';
import type { FinancialOperation, FinancialAccount } from '../domain/types';
import { addAccount, updateAccount, accountHasActivity, addEntry, prepareEntryOperation } from '../domain/workspace';
import { addPairedOperation, addRefund, preparePairedOperation, refundableExpenses } from '../domain/connected-operations';
import { addPlan, filterHistory, resolvePlan } from '../domain/plans';
import { calculateFinancialBalances } from '../domain/balances';
import { calculatePaymentAvailability } from '../domain/payment-availability';
import { formatMoneyMinor, localToday, parseAmountMinor } from '../domain/money';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../domain/categories';
import Field from './FinanceField';
import CreditCardForm from './CreditCardForm';
import AccountDeleteDialog from './AccountDeleteDialog';
import CreditCardTile from './CreditCardTile';
import PaymentAvailabilitySummary from './PaymentAvailabilitySummary';
import FinancialProjection from './FinancialProjection';
import MovementEditor from './MovementEditor';
import MovementDeleteDialog from './MovementDeleteDialog';
import { creditCardGroups } from '../domain/credit-card-grouping';
import type { DataSyncState } from '../../types';
import './finance.css';
import './credit-cards.css';

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
function decimalAmount(amount: number): string {
  const value = BigInt(amount),
    absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
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

export default function FinancePage({ api, onSyncState }: { api: FinanceApi; onSyncState?: (state: DataSyncState) => void }) {
  const finance = useFinance(api);
  const { view, busy } = finance;
  const syncState: DataSyncState = busy
    ? view.stage === 'checking'
      ? 'checking'
      : 'saving'
    : view.error || view.stage === 'unavailable'
      ? 'error'
      : view.stage === 'open'
        ? 'synced'
        : ['pending', 'custody', 'preview'].includes(view.stage)
          ? 'pending'
          : view.stage === 'checking'
            ? 'checking'
            : 'locked';
  useEffect(() => {
    onSyncState?.(syncState);
  }, [onSyncState, syncState]);
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
          <div key={view.formEpoch} className="tf-vault-content">
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
  const [editingAccount, setEditingAccount] = useState<FinancialAccount | null>(null);
  const [deleteAccountId, setDeleteAccountId] = useState<string | null>(null);
  const [editingMovement, setEditingMovement] = useState<WorkspaceOperation | null>(null);
  const [deletingMovement, setDeletingMovement] = useState<WorkspaceOperation | null>(null);
  return (
    <>
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
            {creditCardGroups(snapshot.financialSpace.accounts).length} {creditCardGroups(snapshot.financialSpace.accounts).length === 1 ? 'cuenta' : 'cuentas'}{' '}
            · {snapshot.financialSpace.operations.length} {snapshot.financialSpace.operations.length === 1 ? 'movimiento' : 'movimientos'}
          </span>
          <div className="tf-actions">
            <button
              className="btn btn-secondary"
              disabled={f.busy || readOnly}
              onClick={() => {
                setEditingAccount(null);
                setEditor('account');
              }}
            >
              <Plus size={14} aria-hidden="true" /> Nueva cuenta
            </button>
            <button
              className="btn btn-primary"
              disabled={f.busy || readOnly || !snapshot.financialSpace.accounts.length}
              onClick={() => {
                setEditingAccount(null);
                setEditor('movement');
              }}
            >
              <Plus size={14} aria-hidden="true" /> Nuevo movimiento
            </button>
          </div>
        </div>
      )}
      <nav className="pw-view-tabs tf-project-tabs" aria-label="Secciones de finanzas">
        {[
          { name: 'Resumen', icon: LayoutGrid },
          { name: 'Cuentas', icon: Wallet },
          { name: 'Movimientos', icon: List },
          { name: 'Planes', icon: CalendarClock },
          { name: 'Seguridad', icon: ShieldCheck },
        ].map(({ name, icon: Icon }) => (
          <button key={name} className={`pw-view-tab${tab === name ? ' on' : ''}`} aria-pressed={tab === name} onClick={() => setTab(name)}>
            <Icon size={15} aria-hidden="true" />
            {name}
          </button>
        ))}
      </nav>
      <div className="tf-section-content">
        {(tab === 'Resumen' || tab === 'Cuentas') && (
          <Overview
            snapshot={snapshot}
            accountsOnly={tab === 'Cuentas'}
            canEdit={!readOnly && !f.busy}
            onEdit={a => {
              setEditingAccount(a);
              setEditor('account');
            }}
          />
        )}
        {tab === 'Movimientos' && <History snapshot={snapshot} disabled={f.busy || readOnly} onEdit={setEditingMovement} onDelete={setDeletingMovement} />}
        {tab === 'Planes' && (
          <div className="tf-plans-page">
            <Plans snapshot={snapshot} finance={f} readOnly={readOnly} />
            {snapshot.financialSpace.accounts.length > 0 && <FinancialProjection snapshot={snapshot} />}
          </div>
        )}
        {tab === 'Seguridad' && security}
      </div>
      {editor && (
        <RecordForm
          key={editingAccount?.id ?? editor}
          editingAccount={editingAccount}
          kind={editor}
          onDelete={
            editingAccount
              ? () => {
                  setDeleteAccountId(editingAccount.id);
                  setEditor(null);
                }
              : undefined
          }
          snapshot={snapshot}
          busy={f.busy}
          onClose={() => setEditor(null)}
          onSave={s => void f.save(s).then(() => setEditor(null))}
        />
      )}
      {deleteAccountId && (
        <AccountDeleteDialog
          key={deleteAccountId}
          snapshot={snapshot}
          accountId={deleteAccountId}
          busy={f.busy || readOnly}
          onClose={() => setDeleteAccountId(null)}
          onSave={s => f.save(s)}
        />
      )}
      {editingMovement && (
        <MovementEditor
          key={editingMovement.id}
          operation={editingMovement}
          snapshot={snapshot}
          busy={f.busy || readOnly}
          onClose={() => setEditingMovement(null)}
          onSave={s => f.save(s)}
        />
      )}
      {deletingMovement && (
        <MovementDeleteDialog
          key={deletingMovement.id}
          operation={deletingMovement}
          snapshot={snapshot}
          busy={f.busy || readOnly}
          onClose={() => setDeletingMovement(null)}
          onSave={s => f.save(s)}
        />
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
function Overview({
  snapshot,
  accountsOnly,
  canEdit,
  onEdit,
}: {
  snapshot: FinancialSnapshot;
  accountsOnly: boolean;
  canEdit: boolean;
  onEdit: (a: FinancialAccount) => void;
}) {
  const space = snapshot.financialSpace;
  const date = localToday();
  let balances: ReturnType<typeof calculateFinancialBalances> | null = null;
  let availability: ReturnType<typeof calculatePaymentAvailability> = [];
  let balanceError = '';
  try {
    balances = calculateFinancialBalances(space.accounts, space.operations, date, space.currencyDefinitions);
    availability = calculatePaymentAvailability(space.accounts, space.operations, date, space.currencyDefinitions);
  } catch {
    balanceError = 'No se pueden calcular los saldos actuales. Revisa las fechas de apertura de tus cuentas.';
  }
  const money = (n: number, c: string) =>
    formatMoneyMinor(
      n,
      space.currencyDefinitions.find(d => d.code === c)!,
    );
  return (
    <>
      {balanceError && <ErrorNotice>{balanceError}</ErrorNotice>}
      {!accountsOnly && (
        <PaymentAvailabilitySummary
          summaries={availability}
          currencies={space.currencyDefinitions}
          accounts={space.accounts}
          canEdit={canEdit}
          onEdit={onEdit}
        />
      )}
      {!space.accounts.length ? (
        <div className="tf-card tf-gate">
          <Wallet size={26} aria-hidden="true" />
          <h2>Empieza con tu primera cuenta</h2>
          <p className="muted">Añade efectivo, una cuenta bancaria o una tarjeta. Cada moneda conservará sus propios saldos.</p>
        </div>
      ) : (
        <section className="tf-accounts-section" aria-label="Cuentas financieras">
          <div className="tf-section-title">
            <h2>Tus cuentas</h2>
            <p className="muted">Administra cada cuenta y sus datos de apertura.</p>
          </div>
          <div className="tf-grid">
            {creditCardGroups(space.accounts).map(group => {
              const a = group[0];
              if (a.type === 'credit')
                return (
                  <CreditCardTile
                    key={a.creditCard?.id ?? a.id}
                    accounts={group}
                    snapshot={snapshot}
                    date={date}
                    balances={balances?.accounts ?? []}
                    canEdit={canEdit}
                    onEdit={onEdit}
                  />
                );
              const b = balances?.accounts.find(b => b.accountId === a.id);
              return (
                <article key={a.id} className="tf-card">
                  <div className="tf-account-heading">
                    <span className="tf-account-icon">
                      {a.type === 'debit' ? <Landmark size={18} aria-hidden="true" /> : <Wallet size={18} aria-hidden="true" />}
                    </span>
                    <button className="ibtn" aria-label={`Configurar cuenta ${a.name}`} disabled={!canEdit} onClick={() => onEdit(a)}>
                      <MoreHorizontal size={18} aria-hidden="true" />
                    </button>
                  </div>
                  <h3>{a.name}</h3>
                  {a.bankName && (
                    <p className="tf-bank-name">
                      <Landmark size={13} aria-hidden="true" />
                      {a.bankName}
                    </p>
                  )}
                  <p className="muted">
                    {a.type === 'cash' ? 'Efectivo' : 'Cuenta bancaria'} · {a.currency}
                  </p>
                  <strong className="tf-amount">{b ? money(b.balanceMinor, a.currency) : '—'}</strong>
                  <p className="muted">Apertura: {a.openingDate}</p>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

function History({
  snapshot,
  disabled,
  onEdit,
  onDelete,
}: {
  snapshot: FinancialSnapshot;
  disabled: boolean;
  onEdit: (operation: WorkspaceOperation) => void;
  onDelete: (operation: WorkspaceOperation) => void;
}) {
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
          <OperationRow
            key={op.id}
            operation={op}
            snapshot={snapshot}
            actions={
              <div className="tf-movement-actions">
                <button
                  type="button"
                  className="ibtn"
                  title="Editar movimiento"
                  aria-label={`Editar movimiento ${op.description}`}
                  disabled={disabled}
                  onClick={() => onEdit(op)}
                >
                  <Pencil size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="ibtn btn-danger-ghost"
                  title="Eliminar movimiento"
                  aria-label={`Eliminar movimiento ${op.description}`}
                  disabled={disabled}
                  onClick={() => onDelete(op)}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            }
          />
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
function OperationRow({
  operation: o,
  snapshot,
  actions,
}: {
  operation: FinancialOperation & { description: string; note: string };
  snapshot: FinancialSnapshot;
  actions?: ReactNode;
}) {
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
      {actions}
    </div>
  );
}

function RecordForm({
  kind,
  editingAccount,
  onDelete,
  snapshot,
  busy,
  onClose,
  onSave,
}: {
  kind: 'account' | 'movement';
  editingAccount?: FinancialAccount | null;
  onDelete?: () => void;
  snapshot: FinancialSnapshot;
  busy: boolean;
  onClose: () => void;
  onSave: (s: FinancialSnapshot) => void;
}) {
  const s = snapshot.financialSpace;
  const [error, setError] = useState('');
  const [type, setType] = useState<string>(editingAccount?.type ?? 'cash');
  const [accountName, setAccountName] = useState(editingAccount?.name ?? '');
  const [bankName, setBankName] = useState(editingAccount?.bankName ?? '');
  const [operation, setOperation] = useState<FinancialOperation['kind']>('expense');
  const [account, setAccount] = useState(s.accounts[0]?.id ?? '');
  const [currency, setCurrency] = useState(
    editingAccount?.currency ?? s.currencyDefinitions.find(c => c.code === 'DOP')?.code ?? s.currencyDefinitions[0].code,
  );
  const [planned, setPlanned] = useState(false);
  const linked = Boolean(editingAccount && accountHasActivity(snapshot, editingAccount.id));
  const paired = operation === 'transfer' || operation === 'card-payment';
  const sourceAccounts = s.accounts.filter(a => !paired || a.type !== 'credit');
  const selected = sourceAccounts.find(a => a.id === account) ?? sourceAccounts[0];
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
        const draft = {
          ...(editingAccount ? {} : { id: id() }),
          name: text('name'),
          ...(text('bankName').trim() ? { bankName: text('bankName').trim() } : {}),
          type,
          currency,
          openingBalanceMinor: amount,
          openingDate: text('date'),
          ...(type === 'credit' ? { creditLimitMinor: parseAmountMinor(text('limit'), digits, { allowZero: true }) } : {}),
        };
        next = editingAccount ? updateAccount(snapshot, editingAccount.id, draft) : addAccount(snapshot, draft);
      } else {
        const base = { id: id(), date: text('date'), amountMinor: amount, description: text('description'), note: text('note') };
        if (operation === 'refund') {
          next = addRefund(snapshot, { ...base, originalExpenseId: text('expense'), destinationAccountId: selected?.id ?? '' });
        } else {
          const input =
            operation === 'income' || operation === 'expense'
              ? { ...base, kind: operation, accountId: selected?.id ?? '', category: text('category') }
              : { ...base, kind: operation, fromAccountId: selected?.id ?? '', toAccountId: text('to') };
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
  if (kind === 'account' && type === 'credit')
    return (
      <CreditCardForm
        snapshot={snapshot}
        initialAccount={editingAccount}
        initialName={accountName}
        initialBank={bankName}
        busy={busy}
        onClose={onClose}
        onSave={onSave}
        onDelete={onDelete}
        onBack={!editingAccount ? () => setType('cash') : undefined}
      />
    );
  return (
    <Dialog title={kind === 'account' ? (editingAccount ? 'Configurar cuenta' : 'Nueva cuenta') : 'Nuevo movimiento'} onClose={onClose} busy={busy}>
      <form className="pw-form" onSubmit={submit} autoComplete="off">
        <fieldset disabled={busy} className="tf-form-fields">
          <div className="pw-form-body">
            {error && <ErrorNotice>{error}</ErrorNotice>}
            {kind === 'account' ? (
              <>
                <div className="tf-form-intro">
                  <span className="tf-account-icon">
                    <Wallet size={22} aria-hidden="true" />
                  </span>
                  <p>
                    {editingAccount
                      ? 'Actualiza los datos de tu cuenta. Los movimientos se conservan.'
                      : 'Organiza tu dinero con una cuenta de efectivo, bancaria o tarjeta.'}
                  </p>
                </div>
                <Field label="Nombre de la cuenta" icon={<Tag size={14} aria-hidden="true" />}>
                  <input name="name" required maxLength={120} value={accountName} onChange={e => setAccountName(e.target.value)} data-initial-focus />
                </Field>
                <Field label="Banco (opcional)" icon={<Landmark size={14} aria-hidden="true" />}>
                  <input
                    name="bankName"
                    maxLength={120}
                    placeholder="Nombre del banco o institución"
                    value={bankName}
                    onChange={e => setBankName(e.target.value)}
                  />
                </Field>
                <Field label="Tipo de cuenta" icon={<Wallet size={14} aria-hidden="true" />}>
                  <select disabled={linked} value={type} onChange={e => setType(e.target.value)}>
                    <option value="cash">Efectivo</option>
                    <option value="debit">Cuenta bancaria</option>
                    <option value="credit">Tarjeta de crédito</option>
                  </select>
                </Field>
                <Field label="Moneda de la cuenta" icon={<Coins size={14} aria-hidden="true" />}>
                  <select value={currency} onChange={e => setCurrency(e.target.value)}>
                    {s.currencyDefinitions.map(c => (
                      <option key={c.code}>{c.code}</option>
                    ))}
                  </select>
                </Field>
                {linked && <p className="muted">La moneda y el tipo se conservan porque esta cuenta tiene movimientos o planes.</p>}
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
                <Field label={operation === 'refund' || operation === 'income' ? 'Cuenta de destino' : 'Cuenta de origen'}>
                  <select required value={selected?.id ?? ''} onChange={e => setAccount(e.target.value)}>
                    {!sourceAccounts.length && <option value="">No hay cuentas de origen compatibles</option>}
                    {sourceAccounts.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {a.currency}
                      </option>
                    ))}
                  </select>
                </Field>
                {(operation === 'transfer' || operation === 'card-payment') && (
                  <Field label="Cuenta de destino">
                    <select key={selected?.id} name="to" required>
                      <option value="">Selecciona una cuenta</option>
                      {s.accounts
                        .filter(
                          a =>
                            a.id !== selected?.id &&
                            a.currency === selected?.currency &&
                            (operation === 'transfer' ? a.type !== 'credit' : a.type === 'credit'),
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
              <input
                name="amount"
                required
                inputMode="decimal"
                defaultValue={kind === 'account' ? (editingAccount ? decimalAmount(editingAccount.openingBalanceMinor) : '0') : undefined}
                placeholder="0,00"
              />
            </Field>
            {kind === 'account' && type === 'credit' && (
              <Field label="Límite de crédito">
                <input
                  name="limit"
                  inputMode="decimal"
                  required
                  defaultValue={editingAccount?.type === 'credit' ? decimalAmount(editingAccount.creditLimitMinor) : '0'}
                />
              </Field>
            )}
            <Field label={kind === 'account' ? 'Fecha de apertura' : 'Fecha del movimiento'} icon={<CalendarDays size={14} aria-hidden="true" />}>
              <input
                name="date"
                type="date"
                required
                defaultValue={editingAccount?.openingDate ?? localToday()}
                max={kind === 'account' ? localToday() : undefined}
              />
            </Field>
            {kind === 'account' && editingAccount && (
              <p className="muted">El saldo inicial corresponde a la apertura. Cambiarlo recalcula los saldos; los movimientos registrados se conservan.</p>
            )}
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
            {onDelete && (
              <button type="button" className="btn btn-danger-ghost tf-delete-action" disabled={busy} onClick={onDelete}>
                Eliminar cuenta
              </button>
            )}
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
