import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { ErrorNotice } from '../../workspace/ui';
import { projectSnapshot } from '../domain/plans';
import { formatMoneyMinor, localToday } from '../domain/money';
import type { FinancialSnapshot } from '../domain/workspace-types';
import Field from './FinanceField';

export default function FinancialProjection({ snapshot }: { snapshot: FinancialSnapshot }) {
  const date = localToday();
  const [target, setTarget] = useState(localToday(new Date(Date.now() + 30 * 86400000)));
  const [requestedTarget, setRequestedTarget] = useState<string | null>(null);
  let projection: ReturnType<typeof projectSnapshot> | null = null;
  let error = '';
  if (requestedTarget !== null) {
    try {
      if (requestedTarget < date || Date.parse(requestedTarget) - Date.parse(date) > 366 * 86400000)
        throw Error('Elige un horizonte de hasta un año posterior a la fecha de saldo.');
      projection = projectSnapshot(snapshot, date, requestedTarget);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'No se pudo calcular.';
    }
  }
  return (
    <details className="tf-card tf-projection">
      <summary>
        <CalendarClock size={18} aria-hidden="true" /> Proyección
      </summary>
      <p className="muted">
        Estimación con los planes pendientes de fecha futura dentro del horizonte. Los planes no alteran tu saldo real y las monedas no se suman entre sí.
      </p>
      <form
        className="tf-actions"
        onSubmit={event => {
          event.preventDefault();
          setRequestedTarget(target);
        }}
      >
        <Field label="Proyectar hasta">
          <input
            required
            type="date"
            value={target}
            onChange={event => {
              setTarget(event.target.value);
              setRequestedTarget(null);
            }}
          />
        </Field>
        <button className="btn btn-secondary">Calcular proyección</button>
      </form>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {projection && (
        <div className="tf-grid" aria-label="Saldos proyectados">
          {projection.projected.currencies.map(currency => (
            <div key={currency.currency} className="tf-projected">
              <span>{currency.currency} · Patrimonio proyectado</span>
              <strong>
                {formatMoneyMinor(
                  currency.netWorthMinor,
                  snapshot.financialSpace.currencyDefinitions.find(definition => definition.code === currency.currency)!,
                )}
              </strong>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
