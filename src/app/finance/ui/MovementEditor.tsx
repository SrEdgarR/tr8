import { useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeftRight, CalendarDays, Coins, Landmark, List, MessageSquare, Tag } from 'lucide-react';
import type { FinancialSnapshot, WorkspaceOperation } from '../domain/workspace-types';
import { updateFinancialOperation, operationChangeInfo } from '../domain/operation-edit';
import { parseAmountMinor, formatMoneyMinor } from '../domain/money';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../domain/categories';
import { Dialog, ErrorNotice } from '../../workspace/ui';
import Field from './FinanceField';
import CardPaymentAmounts from './CardPaymentAmounts';
import AmountInput from './AmountInput';

const labels = { income: 'Ingreso', expense: 'Gasto', transfer: 'Transferencia', 'card-payment': 'Pago de tarjeta', refund: 'Reembolso' };
const categories: Record<string, string> = {
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

interface Props {
  snapshot: FinancialSnapshot;
  operation: WorkspaceOperation;
  busy: boolean;
  onClose: () => void;
  onSave: (snapshot: FinancialSnapshot) => Promise<void>;
}

export default function MovementEditor({ snapshot, operation, busy: pending, onClose, onSave }: Props) {
  const space = snapshot.financialSpace;
  const definition = space.currencyDefinitions.find(currency => currency.code === operation.currency)!;
  const divisor = 10n ** BigInt(definition.minorUnitDigits);
  const units = BigInt(operation.amountMinor);
  const initialAmount = definition.minorUnitDigits ? `${units / divisor}.${String(units % divisor).padStart(definition.minorUnitDigits, '0')}` : String(units);
  const [amount, setAmount] = useState(initialAmount);
  const destinationCurrency = operation.kind === 'card-payment' ? operation.destinationCurrency : undefined;
  const destinationDefinition = space.currencyDefinitions.find(currency => currency.code === destinationCurrency);
  const [destinationAmount, setDestinationAmount] = useState(() => {
    if (operation.kind !== 'card-payment' || !destinationDefinition || operation.destinationAmountMinor === undefined) return '';
    const value = BigInt(operation.destinationAmountMinor),
      scale = 10n ** BigInt(destinationDefinition.minorUnitDigits);
    return destinationDefinition.minorUnitDigits
      ? `${value / scale}.${String(value % scale).padStart(destinationDefinition.minorUnitDigits, '0')}`
      : String(value);
  });
  const [date, setDate] = useState(operation.date);
  const [description, setDescription] = useState(operation.description);
  const [note, setNote] = useState(operation.note);
  const [category, setCategory] = useState<string>(operation.category ?? 'other');
  const [accountId, setAccountId] = useState(
    'accountId' in operation ? operation.accountId : operation.kind === 'refund' ? operation.destinationAccountId : operation.fromAccountId,
  );
  const [toAccountId, setToAccountId] = useState('toAccountId' in operation ? operation.toAccountId : '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const lock = useRef(false);
  const busy = pending || submitting;
  const { info, unavailable } = useMemo(() => {
    try {
      return { info: operationChangeInfo(snapshot, operation), unavailable: '' };
    } catch (cause) {
      return { info: null, unavailable: cause instanceof Error ? cause.message : 'Actualiza tus finanzas.' };
    }
  }, [snapshot, operation]);
  const paired = operation.kind === 'transfer' || operation.kind === 'card-payment';
  const foreignPayment = operation.kind === 'card-payment' && destinationDefinition !== undefined;
  const accounts = space.accounts.filter(account => account.currency === operation.currency && (!paired || account.type !== 'credit'));
  const destinations = space.accounts.filter(
    account =>
      account.currency === (destinationCurrency ?? operation.currency) &&
      account.id !== accountId &&
      (operation.kind === 'card-payment' ? account.type === 'credit' : account.type !== 'credit'),
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || lock.current || !info) return;
    lock.current = true;
    setSubmitting(true);
    setError('');
    try {
      const base = {
        ...operation,
        amountMinor: parseAmountMinor(amount, definition.minorUnitDigits),
        date,
        description,
        note,
        ...(foreignPayment ? { destinationAmountMinor: parseAmountMinor(destinationAmount, destinationDefinition.minorUnitDigits) } : {}),
      };
      const next = updateFinancialOperation(
        snapshot,
        operation,
        operation.kind === 'income' || operation.kind === 'expense'
          ? { ...base, accountId, category }
          : operation.kind === 'refund'
            ? { ...base, destinationAccountId: accountId }
            : { ...base, fromAccountId: accountId, toAccountId },
      );
      await onSave(next);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo guardar el movimiento.');
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }
  return (
    <Dialog title="Editar movimiento" onClose={onClose} busy={busy}>
      <form className="pw-form" onSubmit={event => void submit(event)} autoComplete="off">
        <fieldset disabled={busy} className="tf-form-fields">
          <div className="pw-form-body">
            <div className="tf-form-intro">
              <span className="tf-account-icon">
                <ArrowLeftRight size={22} aria-hidden="true" />
              </span>
              <p>
                {labels[operation.kind]} · {operation.currency}
                {destinationCurrency ? ` → ${destinationCurrency}` : ''}. El tipo y las monedas se conservan.
              </p>
            </div>
            {unavailable && <ErrorNotice>{unavailable}</ErrorNotice>}
            {error && <ErrorNotice>{error}</ErrorNotice>}
            {info?.captured && (
              <p className="pw-info">
                Este movimiento está incluido en el corte de {info.capturedCardNames.join(', ')}. Puedes editar su descripción, categoría y nota. Para corregir
                importes, cuentas o fecha, activa «Completar la deuda al corte después» en Configurar tarjeta y vuelve a confirmar el pendiente tras la
                corrección.
              </p>
            )}
            {info?.plans.length ? (
              <p className="pw-info">
                El plan confirmado asociado se actualizará junto con este movimiento. Su estado seguirá confirmado y no se registrará otra copia.
              </p>
            ) : null}
            <Field label="Descripción" icon={<Tag size={14} aria-hidden="true" />}>
              <input data-initial-focus required maxLength={500} value={description} onChange={event => setDescription(event.target.value)} />
            </Field>
            <Field
              label={operation.kind === 'income' || operation.kind === 'refund' ? 'Cuenta de destino' : 'Cuenta de origen'}
              icon={<Landmark size={14} aria-hidden="true" />}
            >
              <select
                required
                disabled={info?.captured}
                value={accountId}
                onChange={event => {
                  setAccountId(event.target.value);
                  if (paired) setToAccountId('');
                }}
              >
                {accounts.map(account => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </option>
                ))}
              </select>
            </Field>
            {paired && (
              <Field label="Cuenta de destino" icon={<ArrowLeftRight size={14} aria-hidden="true" />}>
                <select required disabled={info?.captured} value={toAccountId} onChange={event => setToAccountId(event.target.value)}>
                  <option value="">Selecciona una cuenta</option>
                  {destinations.map(account => (
                    <option key={account.id} value={account.id}>
                      {account.name} · {account.currency}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {operation.kind === 'refund' && (
              <p className="muted">
                Gasto original: {space.operations.find(item => item.id === operation.originalExpenseId)?.description ?? 'No disponible'}. Su referencia se
                conserva.
              </p>
            )}
            <Field label={`${foreignPayment ? 'Importe debitado' : 'Importe'} · ${operation.currency}`} icon={<Coins size={14} aria-hidden="true" />}>
              <AmountInput digits={definition.minorUnitDigits} required disabled={info?.captured} value={amount} onValueChange={setAmount} />
            </Field>
            {operation.kind === 'card-payment' && (
              <CardPaymentAmounts
                snapshot={snapshot}
                source={space.accounts.find(account => account.id === accountId)}
                destination={space.accounts.find(account => account.id === toAccountId)}
                sourceAmount={amount}
                destinationAmount={destinationAmount}
                onDestinationAmount={setDestinationAmount}
                date={date}
                excludedOperationId={operation.id}
                disabled={info?.captured}
              />
            )}
            <Field label="Fecha del movimiento" icon={<CalendarDays size={14} aria-hidden="true" />}>
              <input required type="date" disabled={info?.captured} value={date} onChange={event => setDate(event.target.value)} />
            </Field>
            {(operation.kind === 'income' || operation.kind === 'expense') && (
              <Field label="Categoría" icon={<List size={14} aria-hidden="true" />}>
                <select value={category} onChange={event => setCategory(event.target.value)}>
                  {(operation.kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map(value => (
                    <option key={value} value={value}>
                      {categories[value]}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Nota opcional" icon={<MessageSquare size={14} aria-hidden="true" />}>
              <textarea maxLength={1024} rows={2} value={note} onChange={event => setNote(event.target.value)} />
            </Field>
            <p className="muted">
              Importe anterior: {formatMoneyMinor(operation.amountMinor, definition)}. El guardado recalcula los saldos de las cuentas afectadas.
            </p>
          </div>
          <div className="pw-form-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !info}>
              {submitting ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
