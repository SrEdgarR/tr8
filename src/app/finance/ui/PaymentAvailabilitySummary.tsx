import { CalendarClock } from 'lucide-react';
import type { PaymentAvailability } from '../domain/payment-availability';
import type { CurrencyDefinition, FinancialAccount } from '../domain/types';
import { formatMoneyMinor } from '../domain/money';

export default function PaymentAvailabilitySummary({
  summaries,
  currencies,
  accounts,
  canEdit,
  onEdit,
}: {
  summaries: PaymentAvailability[];
  currencies: CurrencyDefinition[];
  accounts: FinancialAccount[];
  canEdit: boolean;
  onEdit: (account: FinancialAccount) => void;
}) {
  return (
    <section className="tf-summary-section" aria-label="Disponibilidad por moneda">
      <div className="tf-section-title">
        <h2>Disponibilidad por moneda</h2>
        <p className="muted">Descuenta los cortes cerrados pendientes, incluidos los vencidos. El consumo para el siguiente corte queda aparte.</p>
      </div>
      <div className="tf-grid">
        {summaries.map(summary => {
          const currency = currencies.find(definition => definition.code === summary.currency)!;
          const money = (amount: number | null) => (amount === null ? 'Por completar' : formatMoneyMinor(amount, currency));
          const missing = accounts.filter(account => summary.missingAccountIds.includes(account.id));
          return (
            <article className="tf-card tf-balance tf-payment-summary" key={summary.currency} aria-label={`Disponibilidad en ${summary.currency}`}>
              <span className="tf-tag">{summary.currency}</span>
              <p className="muted tf-payment-label">Disponible después del próximo pago</p>
              <strong>{money(summary.availableAfterPaymentMinor)}</strong>
              <dl>
                <div>
                  <dt>Dinero en tus cuentas</dt>
                  <dd>{money(summary.liquidMinor)}</dd>
                </div>
                <div>
                  <dt>Pendiente de cortes cerrados</dt>
                  <dd>{money(summary.nextPaymentMinor)}</dd>
                </div>
                <div>
                  <dt>Consumo para el siguiente corte</dt>
                  <dd>{money(summary.unbilledDebtMinor)}</dd>
                </div>
                <div className="tf-net-worth">
                  <dt>Patrimonio neto</dt>
                  <dd>{money(summary.netWorthMinor)}</dd>
                </div>
              </dl>
              {missing.length > 0 && (
                <div className="tf-payment-missing">
                  <p className="muted">
                    {summary.needsReconciliation
                      ? 'Revisa el pendiente del corte: hay movimientos que requieren actualizar su desglose.'
                      : 'Completa el pendiente del último corte para calcular lo que te quedará después del pago.'}
                  </p>
                  {missing.map(account => (
                    <button
                      key={account.id}
                      type="button"
                      className="btn btn-secondary"
                      disabled={!canEdit}
                      aria-label={`Completar corte de ${account.name} en ${summary.currency}`}
                      onClick={() => onEdit(account)}
                    >
                      <CalendarClock size={14} aria-hidden="true" />
                      Completar corte · {account.name}
                    </button>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
