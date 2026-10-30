import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import type { FinancialSnapshot, WorkspaceOperation } from '../domain/workspace-types';
import { deleteFinancialOperation, operationChangeInfo } from '../domain/operation-edit';
import { formatMoneyMinor, localToday } from '../domain/money';
import { Dialog, ErrorNotice } from '../../workspace/ui';

export default function MovementDeleteDialog({
  snapshot,
  operation,
  busy: pending,
  onClose,
  onSave,
}: {
  snapshot: FinancialSnapshot;
  operation: WorkspaceOperation;
  busy: boolean;
  onClose: () => void;
  onSave: (snapshot: FinancialSnapshot) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const busy = pending || submitting;
  const { info, unavailable } = useMemo(() => {
    try {
      return { info: operationChangeInfo(snapshot, operation), unavailable: '' };
    } catch (cause) {
      return { info: null, unavailable: cause instanceof Error ? cause.message : 'Actualiza tus finanzas.' };
    }
  }, [snapshot, operation]);
  const allowed = info !== null && !info.captured && !info.refunds.length;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || lock.current || !allowed || confirmation !== 'ELIMINAR') return;
    lock.current = true;
    setSubmitting(true);
    setError('');
    try {
      await onSave(deleteFinancialOperation(snapshot, operation, localToday()));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo confirmar la eliminación.');
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }
  return (
    <Dialog title="Eliminar movimiento" onClose={onClose} busy={busy}>
      <form className="pw-form" onSubmit={event => void submit(event)}>
        <div className="pw-form-body">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {unavailable ? (
            <ErrorNotice>{unavailable}</ErrorNotice>
          ) : (
            <>
              <p>
                Vas a eliminar definitivamente <strong>{operation.description}</strong>.
              </p>
              <p className="muted">
                {formatMoneyMinor(
                  operation.amountMinor,
                  snapshot.financialSpace.currencyDefinitions.find(currency => currency.code === operation.currency)!,
                )}{' '}
                {operation.kind === 'card-payment' && operation.destinationCurrency && operation.destinationAmountMinor !== undefined && (
                  <>
                    →{' '}
                    {formatMoneyMinor(
                      operation.destinationAmountMinor,
                      snapshot.financialSpace.currencyDefinitions.find(currency => currency.code === operation.destinationCurrency)!,
                    )}{' '}
                    ·{' '}
                  </>
                )}
                · {operation.date}
              </p>
              <p>Los saldos se recalcularán. Los demás movimientos se conservarán.</p>
              {(operation.kind === 'transfer' || operation.kind === 'card-payment') && (
                <p className="pw-info">Se retirará la operación completa de las dos cuentas; no quedará un cargo o abono separado.</p>
              )}
              {!!info?.plans.length && (
                <p className="pw-info">El plan confirmado asociado quedará cancelado al eliminar este movimiento. No se volverá a ejecutar automáticamente.</p>
              )}
              {!!info?.refunds.length && (
                <p role="alert">
                  Este gasto tiene {info.refunds.length} reembolso(s) vinculado(s). Elimina primero esos reembolsos antes de eliminar el gasto.
                </p>
              )}
              {info?.captured && (
                <p role="alert">
                  Este movimiento está incluido en el saldo de corte de {info.capturedCardNames.join(', ')}. Activa «Completar la deuda al corte después» en
                  Configurar tarjeta antes de eliminarlo; después confirma de nuevo el pendiente del corte.
                </p>
              )}
              {allowed && (
                <label className="pw-field">
                  Escribe ELIMINAR para confirmar
                  <input
                    aria-label="Escribe ELIMINAR para confirmar"
                    value={confirmation}
                    onChange={event => setConfirmation(event.target.value)}
                    disabled={busy}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </label>
              )}
            </>
          )}
        </div>
        <div className="pw-form-footer">
          <button type="button" className="btn btn-secondary" data-initial-focus disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-danger" disabled={busy || !allowed || confirmation !== 'ELIMINAR'}>
            <Trash2 size={14} aria-hidden="true" />
            {submitting ? 'Eliminando…' : 'Eliminar movimiento definitivamente'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
