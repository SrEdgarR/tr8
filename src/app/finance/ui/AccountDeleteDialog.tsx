import { useId, useRef, useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { Dialog, ErrorNotice } from '../../workspace/ui';
import { getAccountRemoval, removeFinancialAccount } from '../domain/account-removal';
import type { FinancialSnapshot } from '../domain/workspace-types';

interface Props {
  snapshot: FinancialSnapshot;
  accountId: string;
  busy: boolean;
  onClose: () => void;
  onSave: (snapshot: FinancialSnapshot) => Promise<void> | void;
}

export default function AccountDeleteDialog({ snapshot, accountId, busy: pending, onClose, onSave }: Props) {
  const prefix = useId();
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const locked = useRef(false);
  const busy = pending || submitting;
  let removal: ReturnType<typeof getAccountRemoval> | null = null;
  try {
    removal = getAccountRemoval(snapshot, accountId);
  } catch {
    // An account removed or changed in another session must not be replaced by
    // another selection in an already open destructive confirmation.
  }
  const selectedIds = new Set(removal?.accountIds ?? []);
  const accounts = snapshot.financialSpace.accounts.filter(account => selectedIds.has(account.id));
  const matches = removal !== null && confirmation === removal.name;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || locked.current || !removal?.canDelete || !matches) return;
    locked.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const next = removeFinancialAccount(snapshot, accountId, confirmation);
      await onSave(next);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo confirmar la eliminación. Vuelve a intentarlo.');
    } finally {
      locked.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog title="Eliminar cuenta" busy={busy} onClose={onClose}>
      <form className="pw-form" onSubmit={event => void submit(event)} aria-describedby={removal ? `${prefix}-consequences` : undefined}>
        <div className="pw-form-body">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {!removal ? (
            <p role="alert">La cuenta ya no está disponible. Actualiza tus finanzas antes de continuar.</p>
          ) : (
            <>
              <div id={`${prefix}-consequences`}>
                <p>
                  Vas a eliminar definitivamente <strong>{removal.name}</strong>.
                  {accounts.length > 1 && ' Se eliminarán juntos los saldos de esta tarjeta en todas sus monedas.'}
                </p>
                <ul aria-label="Saldos que se eliminarán">
                  {accounts.map(account => (
                    <li key={account.id}>
                      {account.name} · {account.currency}
                    </li>
                  ))}
                </ul>
                <p>Las demás cuentas se conservarán.</p>
                {!removal.canDelete ? (
                  <p role="alert">
                    Esta cuenta tiene {removal.operationCount} {removal.operationCount === 1 ? 'movimiento vinculado' : 'movimientos vinculados'} y{' '}
                    {removal.planCount} {removal.planCount === 1 ? 'plan' : 'planes'}. Conservamos su historial: no se puede eliminar una cuenta con movimientos
                    o planes.
                  </p>
                ) : (
                  <p>Esta acción no se puede deshacer.</p>
                )}
              </div>
              {removal.canDelete && (
                <>
                  <label className="pw-field" htmlFor={`${prefix}-confirmation`}>
                    Escribe el nombre exacto de la cuenta
                    <input
                      id={`${prefix}-confirmation`}
                      value={confirmation}
                      onChange={event => setConfirmation(event.target.value)}
                      disabled={busy}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      aria-describedby={`${prefix}-exact-name`}
                    />
                  </label>
                  <p id={`${prefix}-exact-name`} className="faint">
                    Nombre que debes escribir: <strong>{removal.name}</strong>. Respeta mayúsculas y espacios.
                  </p>
                </>
              )}
            </>
          )}
        </div>
        <div className="pw-form-footer">
          <button type="button" className="btn btn-secondary" data-initial-focus disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-danger" disabled={busy || !removal?.canDelete || !matches}>
            <Trash2 size={14} aria-hidden="true" />
            {submitting ? 'Eliminando…' : 'Eliminar cuenta definitivamente'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
