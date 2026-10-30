import './credit-card-form-layout.css';
import { useState, type FormEvent } from 'react';
import { CalendarDays, Coins, CreditCard, Landmark, Link2, Plus, Tag, Trash2 } from 'lucide-react';
import { Dialog, ErrorNotice } from '../../workspace/ui';
import Field from './FinanceField';
import AmountInput from './AmountInput';
import type { FinancialSnapshot } from '../domain/workspace-types';
import type { FinancialAccount } from '../domain/types';
import { calculateFinancialBalances } from '../domain/balances';
import { cardCycleDates, creditCardCycleStatus } from '../domain/credit-cards';
import { saveCreditCard } from '../domain/credit-card-workspace';
import { formatMoneyMinor, localToday, parseAmountMinor } from '../domain/money';
interface Row {
  key: string;
  accountId?: string;
  currency: string;
  limit: string;
  total: string;
  pending: string;
  defer: boolean;
}
function decimal(n: number) {
  const b = BigInt(n),
    a = b < 0n ? -b : b;
  return `${b < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}
export default function CreditCardForm({
  snapshot,
  initialAccount,
  initialName = '',
  initialBank = '',
  busy,
  onClose,
  onSave,
  onDelete,
  onBack,
}: {
  snapshot: FinancialSnapshot;
  initialAccount?: FinancialAccount | null;
  initialName?: string;
  initialBank?: string;
  busy: boolean;
  onClose: () => void;
  onSave: (s: FinancialSnapshot) => void;
  onDelete?: () => void;
  onBack?: () => void;
}) {
  const space = snapshot.financialSpace,
    today = localToday();
  const initial = initialAccount?.type === 'credit' ? initialAccount : undefined;
  const groupId = initial?.creditCard?.id;
  const members = initial ? (groupId ? space.accounts.filter(a => a.type === 'credit' && a.creditCard?.id === groupId) : [initial]) : [];
  const current = calculateFinancialBalances(space.accounts, space.operations, today, space.currencyDefinitions);
  const [name, setName] = useState(initial?.name ?? initialName),
    [bank, setBank] = useState(initial?.bankName ?? initialBank);
  const [cut, setCut] = useState(initial?.creditCard?.statementDay ?? 20),
    [pay, setPay] = useState(initial?.creditCard?.paymentDay ?? 2),
    [error, setError] = useState('');
  const [rows, setRows] = useState<Row[]>(() =>
    members.length
      ? members.map(a => {
          if (a.type !== 'credit') throw Error('Tarjeta no válida');
          const status = a.creditCard ? creditCardCycleStatus({ ...a, creditCard: a.creditCard }, space.operations, today) : null;
          return {
            key: a.id,
            accountId: a.id,
            currency: a.currency,
            limit: decimal(a.creditLimitMinor),
            total: decimal(current.accounts.find(b => b.accountId === a.id)!.balanceMinor),
            pending: status?.statementPendingMinor == null ? '' : decimal(status.statementPendingMinor),
            defer: status?.statementPendingMinor == null,
          };
        })
      : [{ key: crypto.randomUUID(), currency: 'DOP', limit: '0', total: '0', pending: '', defer: false }],
  );
  let dates: ReturnType<typeof cardCycleDates> | null = null;
  try {
    dates = cardCycleDates(today, cut, pay);
  } catch {
    /* Field validation explains invalid day. */
  }
  const linkedIds = new Set(rows.flatMap(r => (r.accountId ? [r.accountId] : [])));
  const linkable = space.accounts.filter(a => a.type === 'credit' && !a.creditCard && !linkedIds.has(a.id) && !rows.some(r => r.currency === a.currency));
  function change(key: string, patch: Partial<Row>) {
    setRows(old => old.map(r => (r.key === key ? { ...r, ...patch } : r)));
  }
  function link(id: string) {
    const a = space.accounts.find(a => a.id === id);
    if (!a || a.type !== 'credit') return;
    setRows(old => [
      ...old,
      {
        key: a.id,
        accountId: a.id,
        currency: a.currency,
        limit: decimal(a.creditLimitMinor),
        total: decimal(current.accounts.find(b => b.accountId === a.id)!.balanceMinor),
        pending: '',
        defer: true,
      },
    ]);
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    try {
      onSave(
        saveCreditCard(snapshot, {
          ...(groupId ? { id: groupId } : {}),
          name,
          ...(bank.trim() ? { bankName: bank.trim() } : {}),
          statementDay: cut,
          paymentDay: pay,
          asOfDate: today,
          balances: rows.map(r => ({
            ...(r.accountId ? { accountId: r.accountId } : {}),
            currency: r.currency,
            creditLimitMinor: parseAmountMinor(r.limit, 2, { allowZero: true }),
            ...(!r.accountId ? { totalDebtMinor: parseAmountMinor(r.total, 2, { allowZero: true, allowNegative: true }) } : {}),
            ...(!r.defer ? { statementPendingMinor: parseAmountMinor(r.pending, 2, { allowZero: true }) } : {}),
          })),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revisa los saldos de la tarjeta.');
    }
  }
  return (
    <Dialog title={initial ? 'Configurar tarjeta' : 'Nueva tarjeta de crédito'} onClose={onClose} busy={busy} wide className="tf-card-dialog">
      <form className="pw-form tf-card-form" onSubmit={submit} autoComplete="off">
        <fieldset className="tf-form-fields" disabled={busy}>
          <div className="pw-form-body">
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <div className="tf-card-layout">
              <section className="tf-card-config" aria-label="Datos y calendario de la tarjeta">
                <div className="tf-form-intro">
                  <span className="tf-account-icon">
                    <CreditCard size={22} />
                  </span>
                  <p>Una tarjeta, con deuda y límite independientes para cada moneda.</p>
                </div>
                <div className="tf-card-form-grid">
                  <Field label="Nombre de la tarjeta" icon={<Tag size={14} />}>
                    <input required maxLength={120} value={name} onChange={e => setName(e.target.value)} data-initial-focus />
                  </Field>
                  <Field label="Banco (opcional)" icon={<Landmark size={14} />}>
                    <input maxLength={120} value={bank} onChange={e => setBank(e.target.value)} />
                  </Field>
                  <Field label="Día de corte" icon={<CalendarDays size={14} />}>
                    <input required type="number" min={1} max={31} value={cut || ''} onChange={e => setCut(Number(e.target.value))} />
                  </Field>
                  <Field label="Día de pago programado" icon={<CalendarDays size={14} />}>
                    <input required type="number" min={1} max={31} value={pay || ''} onChange={e => setPay(Number(e.target.value))} />
                  </Field>
                </div>
                {dates && (
                  <div className="tf-cycle-preview">
                    <span>
                      Último corte <strong>{dates.lastStatementDate}</strong>
                    </span>
                    <span>
                      Pago programado <strong>{dates.paymentDate}</strong>
                    </span>
                    <span>
                      Próximo corte <strong>{dates.nextStatementDate}</strong>
                    </span>
                    <span>
                      Siguiente pago <strong>{dates.nextPaymentDate}</strong>
                    </span>
                  </div>
                )}
                <p className="muted">
                  El calendario no registra pagos automáticamente. Indica cuánto queda pendiente del último corte; los pagos que ya hiciste deben estar
                  descontados.
                </p>
              </section>
              <section className="tf-card-balances" aria-label="Saldos por moneda">
                <div className="tf-card-currency-grid">
                  {rows.map((r, index) => (
                    <section className="tf-credit-row" key={r.key} aria-label={`Saldo ${r.currency}`}>
                      <div className="tf-credit-row-title">
                        <h3>{r.currency} · Saldo y límite</h3>
                        {!members.some(a => a.id === r.accountId) && rows.length > 1 && (
                          <button
                            type="button"
                            className="ibtn"
                            aria-label={`Quitar moneda ${r.currency}`}
                            onClick={() => setRows(old => old.filter(a => a.key !== r.key))}
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                      {r.accountId && (
                        <p className="muted">
                          Saldo existente: {space.accounts.find(a => a.id === r.accountId)?.name}. Se conservan sus movimientos y saldo de apertura.
                        </p>
                      )}
                      <div className="tf-card-form-grid">
                        <Field label={`Moneda ${index + 1}`} icon={<Coins size={14} />}>
                          <select disabled={Boolean(r.accountId)} value={r.currency} onChange={e => change(r.key, { currency: e.target.value })}>
                            {space.currencyDefinitions
                              .filter(c => c.code === r.currency || !rows.some(row => row.currency === c.code))
                              .map(c => (
                                <option key={c.code}>{c.code}</option>
                              ))}
                          </select>
                        </Field>
                        <Field label={`Límite de crédito · ${r.currency}`} icon={<CreditCard size={14} />}>
                          <AmountInput key={r.currency} digits={2} required value={r.limit} onValueChange={value => change(r.key, { limit: value })} />
                        </Field>
                        <Field label={`Deuda total actual · ${r.currency}`} icon={<Coins size={14} />}>
                          <AmountInput
                            key={r.currency}
                            digits={2}
                            required
                            readOnly={Boolean(r.accountId)}
                            inputMode="decimal"
                            value={r.total}
                            onValueChange={value => change(r.key, { total: value })}
                          />
                        </Field>
                        <Field label={`Pendiente del corte ${dates?.lastStatementDate ?? ''} · ${r.currency}`} icon={<CalendarDays size={14} />}>
                          <AmountInput
                            key={r.currency}
                            digits={2}
                            required={!r.defer}
                            disabled={r.defer}
                            inputMode="decimal"
                            value={r.pending}
                            onValueChange={value => change(r.key, { pending: value })}
                            placeholder="0,00"
                          />
                        </Field>
                      </div>
                      <label className="tf-checkbox tf-defer-control">
                        <input type="checkbox" checked={r.defer} onChange={e => change(r.key, { defer: e.target.checked })} />
                        <span>Completar la deuda al corte después</span>
                      </label>
                      {!r.defer && r.pending !== '' && dates && (
                        <p className="muted">
                          Pendiente para el {dates.paymentDate}:{' '}
                          {(() => {
                            try {
                              return formatMoneyMinor(
                                parseAmountMinor(r.pending, 2, { allowZero: true }),
                                space.currencyDefinitions.find(c => c.code === r.currency)!,
                              );
                            } catch {
                              return 'Revisa el importe';
                            }
                          })()}
                        </p>
                      )}
                    </section>
                  ))}
                </div>
                <div className="tf-actions">
                  {rows.length < space.currencyDefinitions.length && (
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={() => {
                        const c = space.currencyDefinitions.find(c => !rows.some(r => r.currency === c.code));
                        if (c) setRows(old => [...old, { key: crypto.randomUUID(), currency: c.code, limit: '0', total: '0', pending: '', defer: false }]);
                      }}
                    >
                      <Plus size={14} />
                      Añadir otra moneda
                    </button>
                  )}
                  {linkable.length > 0 && (
                    <Field label="Vincular saldo existente" icon={<Link2 size={14} />}>
                      <select value="" onChange={e => link(e.target.value)}>
                        <option value="">Selecciona otra moneda de esta tarjeta</option>
                        {linkable.map(a => (
                          <option key={a.id} value={a.id}>
                            {a.name} · {a.currency}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                </div>
                {rows.some(r => r.accountId) && (
                  <p className="muted">Guardar reúne los saldos seleccionados en una tarjeta. No suma monedas ni elimina cuentas o movimientos.</p>
                )}
              </section>
            </div>
          </div>
          <div className="pw-form-footer">
            {onDelete && (
              <button type="button" className="btn btn-danger-ghost tf-delete-action" disabled={busy} onClick={onDelete}>
                Eliminar tarjeta
              </button>
            )}
            {onBack && (
              <button className="btn btn-secondary" type="button" onClick={onBack}>
                Volver
              </button>
            )}
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn btn-primary" type="submit">
              {busy ? 'Guardando…' : 'Guardar tarjeta'}
            </button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
