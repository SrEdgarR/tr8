import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Banknote, CalendarClock, Check, CirclePause, Inbox, KeyRound, Mail, RefreshCw, ShieldCheck, Unplug, Wallet } from 'lucide-react';
import type { ExpenseCategory, IncomeCategory } from '../domain/categories';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../domain/categories';
import { DataError } from '../../data/errors';
import SettingsDisclosure from '../../workspace/SettingsDisclosure';
import { ErrorNotice } from '../../workspace/ui';
import FinanceField from '../ui/FinanceField';
import type { FinanceMcpApi, FinanceMcpGrant, FinanceMcpGrantDraft, FinanceMcpReview } from './api';
import './finance-mcp-panel.css';

export interface FinanceMcpPanelProps {
  api: FinanceMcpApi;
  accounts: { id: string; name: string; currency: string }[];
  connections: { id: string; name: string }[];
  /** Explicit preview gate. Mounting the default panel makes no requests. */
  enabled?: boolean;
}
const categoryNames: Record<ExpenseCategory | IncomeCategory, string> = {
  food: 'Alimentación',
  transport: 'Transporte',
  home: 'Hogar',
  health: 'Salud',
  leisure: 'Ocio',
  shopping: 'Compras',
  services: 'Servicios',
  other: 'Sin clasificar',
  salary: 'Salario',
  freelance: 'Trabajo independiente',
  business: 'Negocio',
  investment: 'Inversiones',
  gift: 'Regalos',
  refund: 'Otros abonos',
};
const reasonNames: Record<string, string> = {
  missing_amount: 'Falta el importe exacto',
  missing_currency: 'Falta confirmar la moneda',
  missing_occurred_at: 'Falta la fecha y hora de la operación',
  missing_time_zone: 'Falta confirmar la zona horaria',
  missing_description: 'Falta el comercio o concepto',
  missing_bank_transaction_id: 'Falta una referencia bancaria inequívoca',
  before_import_start: 'Anterior al inicio autorizado',
  captured_balance: 'Puede estar incluido en el saldo inicial o en un saldo de tarjeta capturado',
  future_notice: 'La fecha de la operación está en el futuro',
  possible_duplicate: 'Posible coincidencia con un movimiento existente',
  bank_reference_conflict: 'La referencia bancaria tiene datos diferentes',
  unsupported_kind: 'Necesita conciliación manual',
  credit_income_requires_review: 'Un abono a tarjeta necesita conciliación manual',
  refund_requires_review: 'Una devolución debe vincularse con su compra original',
  operation_limit: 'El registro alcanzó el límite de movimientos; revisa antes de continuar',
  balance_range: 'Revisa los saldos y el tamaño del registro antes de contabilizar este aviso',
};
function reviewReason(review: FinanceMcpReview) {
  if (review.review_reason === 'unconfirmed_status') {
    if (review.bank_status === 'pending') return 'Operación bancaria pendiente';
    if (review.bank_status === 'rejected') return 'Operación rechazada';
    if (review.bank_status === 'cancelled') return 'Operación anulada';
    return 'El banco no confirma que la operación esté contabilizada';
  }
  return reasonNames[review.review_reason] ?? 'El aviso requiere revisión antes de registrar un movimiento.';
}
const failure = (cause: unknown) => (cause instanceof DataError ? cause.message : 'No se pudo confirmar la operación. Actualiza antes de continuar.');
const when = (instant: string) => new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(instant));

export default function FinanceMcpPanel({ enabled = false, ...props }: FinanceMcpPanelProps) {
  return (
    <section className="tf-mcp-panel" aria-label="Integración financiera con asistentes">
      <div className="tf-mcp-preview" role="status">
        <CirclePause size={17} aria-hidden="true" />
        Vista previa · Importación automática desactivada
      </div>
      <p className="muted">
        El asistente envía solo los datos necesarios del aviso. TR8 no recibe acceso a Gmail ni guarda el cuerpo completo de tus correos. La bóveda cifrada
        queda fuera de esta conexión.
      </p>
      {enabled ? (
        <EnabledFinanceMcpPanel key={props.api.ownerId} {...props} />
      ) : (
        <p className="tf-mcp-disabled">
          <ShieldCheck size={18} aria-hidden="true" />
          El acceso financiero permanece desactivado hasta revisar y autorizar su publicación.
        </p>
      )}
    </section>
  );
}

function EnabledFinanceMcpPanel({ api, accounts, connections }: Omit<FinanceMcpPanelProps, 'enabled'>) {
  const [grants, setGrants] = useState<FinanceMcpGrant[]>([]),
    [reviews, setReviews] = useState<FinanceMcpReview[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null),
    [reviewVersion, setReviewVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null),
    [dismissing, setDismissing] = useState<string | null>(null);
  const lifecycle = useRef({ active: true, epoch: 0 }),
    locked = useRef(false);
  useEffect(() => {
    const state = lifecycle.current;
    state.active = true;
    return () => {
      state.active = false;
      state.epoch++;
    };
  }, [api]);
  const current = (epoch: number) => lifecycle.current.active && epoch === lifecycle.current.epoch;
  async function load() {
    if (locked.current) return;
    const epoch = ++lifecycle.current.epoch;
    setLoading(true);
    setError('');
    setNotice('');
    setRevoking(null);
    setDismissing(null);
    try {
      const [newGrants, page] = await Promise.all([api.listGrants(), api.listReviews({ limit: 50 })]);
      if (!current(epoch)) return;
      setGrants(newGrants);
      setReviews(page.items);
      setNextCursor(page.next_cursor);
      setReviewVersion(page.version);
      setLoaded(true);
    } catch (cause) {
      if (current(epoch)) setError(failure(cause));
    } finally {
      if (current(epoch)) setLoading(false);
    }
  }
  async function mutate(action: () => Promise<void>) {
    if (locked.current || loading) return;
    locked.current = true;
    const epoch = lifecycle.current.epoch;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      if (current(epoch)) setError(failure(cause));
    } finally {
      locked.current = false;
      if (current(epoch)) setBusy(false);
    }
  }
  async function save(draft: FinanceMcpGrantDraft) {
    const epoch = lifecycle.current.epoch;
    await mutate(async () => {
      const saved = await api.setGrant(draft);
      if (!current(epoch)) return;
      setGrants(previous => [saved, ...previous.filter(item => item.credential_id !== saved.credential_id)]);
      setNotice('Permiso financiero guardado. La importación automática continúa desactivada.');
    });
  }
  async function revoke(id: string) {
    const epoch = lifecycle.current.epoch;
    await mutate(async () => {
      await api.revokeGrant(id);
      if (!current(epoch)) return;
      setGrants(previous => previous.filter(item => item.credential_id !== id));
      setRevoking(null);
      setNotice('Acceso financiero revocado. Los movimientos existentes se conservan.');
    });
  }
  async function dismiss(id: string) {
    const epoch = lifecycle.current.epoch;
    await mutate(async () => {
      const saved = await api.dismissReview(id);
      if (!current(epoch)) return;
      setReviews(previous => previous.map(item => (item.notice_id === id ? saved : item)));
      setDismissing(null);
      setNotice('Aviso descartado. No se modificó ningún saldo.');
    });
  }
  async function more() {
    if (!nextCursor || locked.current || loading) return;
    const epoch = lifecycle.current.epoch,
      cursor = nextCursor;
    setLoading(true);
    setError('');
    try {
      const page = await api.listReviews({ cursor, limit: 50 });
      if (!current(epoch)) return;
      if (
        page.version !== reviewVersion ||
        page.next_cursor === cursor ||
        page.items.some(item => reviews.some(previous => previous.notice_id === item.notice_id))
      )
        throw new DataError('La lista cambió. Actualiza para consultar los avisos actuales.');
      setReviews(previous => [...previous, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (cause) {
      if (current(epoch)) setError(failure(cause));
    } finally {
      if (current(epoch)) setLoading(false);
    }
  }
  return (
    <SettingsDisclosure
      title="Permisos financieros y revisión"
      description="Cuentas concretas, fecha de inicio y avisos pendientes, separados de tus saldos."
      icon={<Banknote size={18} />}
      disabled={busy}
      onExpandedChange={expanded => {
        if (expanded) void load();
        else {
          lifecycle.current.epoch++;
          setLoading(false);
          setRevoking(null);
          setDismissing(null);
        }
      }}
    >
      <div className="tf-mcp-content" aria-busy={loading || busy}>
        <div className="tf-mcp-row">
          <strong>
            <ShieldCheck size={17} aria-hidden="true" />
            Acceso por conexión
          </strong>
          <button type="button" className="btn btn-secondary" disabled={loading || busy} onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden="true" />
            Actualizar
          </button>
        </div>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {notice && (
          <p role="status" className="tf-mcp-notice">
            <Check size={16} aria-hidden="true" />
            {notice}
          </p>
        )}
        {loading && <p role="status">Consultando permisos y avisos…</p>}
        {loaded && (
          <>
            {grants.length === 0 ? (
              <p className="muted">Ninguna conexión tiene acceso financiero. Los permisos de proyectos y tareas no lo conceden.</p>
            ) : (
              <ul className="tf-mcp-grants">
                {grants.map(grant => (
                  <li key={grant.credential_id}>
                    <div className="tf-mcp-row">
                      <strong>
                        <KeyRound size={15} aria-hidden="true" />
                        {connections.find(item => item.id === grant.credential_id)?.name ?? 'Conexión autorizada'}
                      </strong>
                      <span className="tf-mcp-access">{grant.access === 'write' ? 'Consulta y registro' : 'Solo consulta'}</span>
                    </div>
                    <ul>
                      {grant.accounts.map(entry => (
                        <li key={entry.account_id}>
                          {accounts.find(account => account.id === entry.account_id)?.name ?? 'Cuenta autorizada'}
                          {grant.access === 'write' && <> · Avisos desde {when(entry.start_at)}</>}
                        </li>
                      ))}
                    </ul>
                    {revoking === grant.credential_id ? (
                      <div className="tf-mcp-confirm" role="group" aria-label="Confirmar revocación financiera">
                        <p>El asistente perderá el acceso financiero de esta conexión. Se conservan tus movimientos.</p>
                        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setRevoking(null)}>
                          Cancelar
                        </button>
                        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void revoke(grant.credential_id)}>
                          Confirmar revocación
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy || loading}
                        onClick={() => {
                          setRevoking(grant.credential_id);
                          setDismissing(null);
                        }}
                      >
                        <Unplug size={14} aria-hidden="true" />
                        Revocar acceso financiero
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <details className="tf-mcp-form-disclosure">
              <summary>
                <KeyRound size={16} aria-hidden="true" />
                Autorizar o reemplazar un permiso
              </summary>
              <GrantForm connections={connections} accounts={accounts} busy={busy || loading} onSave={save} />
            </details>
            <section className="tf-mcp-reviews" aria-label="Avisos pendientes de revisión">
              <h4>
                <Inbox size={17} aria-hidden="true" />
                Bandeja de revisión
              </h4>
              <p className="muted">
                Estos avisos no alteran saldos ni proyecciones. Transferencias, pagos de tarjeta, devoluciones y anulaciones necesitan conciliación manual.
              </p>
              {reviews.length === 0 ? (
                <p>No hay avisos para revisar.</p>
              ) : (
                <ul>
                  {reviews.map(review => (
                    <li key={review.notice_id}>
                      <div className="tf-mcp-row">
                        <strong>{review.description ?? 'Aviso sin concepto'}</strong>
                        <span className="tf-mcp-access">{review.status === 'dismissed' ? 'Descartado' : 'Pendiente de revisión'}</span>
                      </div>
                      <p>
                        {accounts.find(account => account.id === review.account_id)?.name ?? 'Cuenta autorizada'}
                        {review.amount && review.currency ? ` · ${review.currency} ${review.amount}` : ''}
                        {review.date ? ` · ${review.date}` : ''}
                      </p>
                      <p className="muted">{reviewReason(review)}</p>
                      {review.status !== 'dismissed' &&
                        (dismissing === review.notice_id ? (
                          <div className="tf-mcp-confirm" role="group" aria-label="Confirmar descarte del aviso">
                            <p>Descartar este aviso no elimina movimientos ni modifica tus saldos.</p>
                            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setDismissing(null)}>
                              Cancelar
                            </button>
                            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void dismiss(review.notice_id)}>
                              Confirmar descarte
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy || loading}
                            onClick={() => {
                              setDismissing(review.notice_id);
                              setRevoking(null);
                            }}
                          >
                            Descartar aviso
                          </button>
                        ))}
                    </li>
                  ))}
                </ul>
              )}
              {nextCursor && (
                <button type="button" className="btn btn-secondary" disabled={loading || busy} onClick={() => void more()}>
                  Cargar más avisos
                </button>
              )}
            </section>
          </>
        )}
      </div>
    </SettingsDisclosure>
  );
}

function localInstant(value: string): string {
  const date = new Date(value);
  const local =
    [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-') +
    `T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || local !== value || !Number.isFinite(date.getTime()))
    throw new DataError('Elige una fecha y hora de inicio válidas para cada cuenta.');
  return date.toISOString();
}

function GrantForm({
  accounts,
  connections,
  busy,
  onSave,
}: Pick<FinanceMcpPanelProps, 'accounts' | 'connections'> & { busy: boolean; onSave: (draft: FinanceMcpGrantDraft) => Promise<void> }) {
  const prefix = useId();
  const [connection, setConnection] = useState(''),
    [access, setAccess] = useState<'read' | 'write'>('read'),
    [mailboxes, setMailboxes] = useState('');
  const [selected, setSelected] = useState<Record<string, string>>({}),
    [income, setIncome] = useState<IncomeCategory[]>(['other']),
    [expense, setExpense] = useState<ExpenseCategory[]>(['other']);
  const [consent, setConsent] = useState(false),
    [error, setError] = useState('');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    try {
      if (!consent || !connections.some(item => item.id === connection) || !Object.keys(selected).length)
        throw new DataError('Selecciona una conexión y sus cuentas, y confirma el permiso.');
      const mailboxIds = access === 'write' ? mailboxes.split(/\s+/).filter(Boolean) : [];
      if (
        access === 'write' &&
        (!mailboxIds.length || mailboxIds.some(value => !/^[a-f0-9]{64}$/.test(value)) || new Set(mailboxIds).size !== mailboxIds.length)
      )
        throw new DataError('Añade los identificadores opacos de los buzones autorizados, uno por línea. No escribas direcciones de correo ni claves.');
      const authorizedAt = new Date().toISOString();
      const authorized = Object.entries(selected).map(([account_id, start]) => {
        if (!accounts.some(account => account.id === account_id)) throw new DataError('La cuenta seleccionada ya no está disponible.');
        return { account_id, start_at: access === 'write' ? localInstant(start) : authorizedAt };
      });
      await onSave({
        credential_id: connection,
        access,
        accounts: authorized,
        mailbox_ids: mailboxIds,
        income_categories: access === 'write' ? income : [],
        expense_categories: access === 'write' ? expense : [],
      });
      setConsent(false);
    } catch (cause) {
      setError(failure(cause));
    }
  }
  return (
    <form className="tf-mcp-form" onSubmit={event => void submit(event)}>
      <fieldset disabled={busy}>
        <legend className="sr-only">Autorizar acceso financiero</legend>
        <p>Este formulario concede acceso solo a Finanzas normal. Reemplaza los permisos financieros previos de la conexión seleccionada.</p>
        <div className="tf-mcp-fields">
          <FinanceField label="Conexión del asistente" icon={<KeyRound size={15} />}>
            <select
              required
              value={connection}
              onChange={event => {
                setConnection(event.target.value);
                setConsent(false);
              }}
            >
              <option value="">Selecciona una conexión</option>
              {connections.map(item => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </FinanceField>
          <FinanceField label="Acceso financiero" icon={<ShieldCheck size={15} />}>
            <select
              value={access}
              onChange={event => {
                setAccess(event.target.value as 'read' | 'write');
                setConsent(false);
              }}
            >
              <option value="read">Solo consultar</option>
              <option value="write">Consultar y registrar ingresos o compras confirmados</option>
            </select>
          </FinanceField>
        </div>
        <fieldset className="tf-mcp-account-choice">
          <legend>
            <Wallet size={15} aria-hidden="true" />
            {access === 'write' ? 'Cuentas y punto de inicio' : 'Cuentas autorizadas'}
          </legend>
          <p className="muted">
            {access === 'write'
              ? `Horas en ${zone}. Los avisos anteriores se enviarán a revisión.`
              : 'La consulta incluye el historial de las cuentas elegidas. El permiso comienza al guardarlo; no limita las fechas de los movimientos consultados.'}
          </p>
          {accounts.map((account, index) => (
            <div className="tf-mcp-account-choice-row" key={account.id}>
              <label htmlFor={`${prefix}-account-${index}`} className="tf-mcp-checkbox">
                <input
                  id={`${prefix}-account-${index}`}
                  type="checkbox"
                  checked={Object.hasOwn(selected, account.id)}
                  onChange={event => {
                    setConsent(false);
                    if (event.target.checked) setSelected(previous => ({ ...previous, [account.id]: '' }));
                    else setSelected(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== account.id)));
                  }}
                />
                {account.name} · {account.currency}
              </label>
              {access === 'write' && Object.hasOwn(selected, account.id) && (
                <FinanceField label={`Inicio autorizado · ${account.name} · ${account.currency}`} icon={<CalendarClock size={15} />}>
                  <input
                    required
                    type="datetime-local"
                    value={selected[account.id]}
                    onChange={event => {
                      setSelected(previous => ({ ...previous, [account.id]: event.target.value }));
                      setConsent(false);
                    }}
                  />
                </FinanceField>
              )}
            </div>
          ))}
        </fieldset>
        {access === 'write' ? (
          <>
            <FinanceField label="Buzones autorizados · Identificadores opacos" icon={<Mail size={15} />}>
              <textarea
                required
                rows={2}
                value={mailboxes}
                placeholder="SHA-256 del identificador del buzón, uno por línea"
                onChange={event => {
                  setMailboxes(event.target.value);
                  setConsent(false);
                }}
              />
            </FinanceField>
            <p className="muted">
              Estos identificadores limitan el origen admitido; no conceden acceso a Gmail. No introduzcas contraseñas, tokens ni números bancarios.
            </p>
            <p className="muted">La consulta incluye los movimientos de las cuentas elegidas. Las categorías siguientes limitan los nuevos registros.</p>
            <div className="tf-mcp-fields">
              <fieldset className="tf-mcp-category-choice">
                <legend>Categorías de gastos autorizadas</legend>
                {EXPENSE_CATEGORIES.map(category => (
                  <label key={category} className="tf-mcp-checkbox">
                    <input
                      type="checkbox"
                      checked={expense.includes(category)}
                      onChange={event => {
                        setExpense(previous => (event.target.checked ? [...previous, category] : previous.filter(item => item !== category)));
                        setConsent(false);
                      }}
                    />
                    {categoryNames[category]}
                  </label>
                ))}
              </fieldset>
              <fieldset className="tf-mcp-category-choice">
                <legend>Categorías de ingresos autorizadas</legend>
                {INCOME_CATEGORIES.filter(category => category !== 'refund').map(category => (
                  <label key={category} className="tf-mcp-checkbox">
                    <input
                      type="checkbox"
                      checked={income.includes(category)}
                      onChange={event => {
                        setIncome(previous => (event.target.checked ? [...previous, category] : previous.filter(item => item !== category)));
                        setConsent(false);
                      }}
                    />
                    {categoryNames[category]}
                  </label>
                ))}
              </fieldset>
            </div>
          </>
        ) : (
          <p className="muted">
            Solo consulta: sin acceso a buzones ni permiso para registrar movimientos. No necesitas configurar categorías ni un inicio de importación.
          </p>
        )}
        <label className="tf-mcp-checkbox tf-mcp-consent">
          <input required type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
          {access === 'write'
            ? 'Autorizo únicamente estas cuentas, buzones y permisos. La importación automática seguirá desactivada.'
            : 'Autorizo únicamente la consulta de estas cuentas. La importación automática seguirá desactivada.'}
        </label>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <button type="submit" className="btn btn-primary" disabled={!consent || !connections.length || !accounts.length}>
          <ShieldCheck size={15} aria-hidden="true" />
          Guardar permiso financiero
        </button>
      </fieldset>
    </form>
  );
}
