import { CalendarDays, ChevronDown, CreditCard, MoreHorizontal } from 'lucide-react';
import type { FinancialAccount, FinancialAccountBalance } from '../domain/types';
import type { FinancialSnapshot } from '../domain/workspace-types';
import { creditCardCycleStatus } from '../domain/credit-cards';
import { formatMoneyMinor } from '../domain/money';
export default function CreditCardTile({
  accounts,
  snapshot,
  date,
  balances,
  canEdit,
  onEdit,
}: {
  accounts: FinancialAccount[];
  snapshot: FinancialSnapshot;
  date: string;
  balances: FinancialAccountBalance[];
  canEdit: boolean;
  onEdit: (a: FinancialAccount) => void;
}) {
  const first = accounts[0];
  const pockets = accounts.flatMap(a => {
    if (a.type !== 'credit') return [];
    const balance = balances.find(b => b.accountId === a.id);
    const money = (n: number) =>
      formatMoneyMinor(
        n,
        snapshot.financialSpace.currencyDefinitions.find(c => c.code === a.currency)!,
      );
    let cycle: ReturnType<typeof creditCardCycleStatus> | null = null;
    try {
      if (a.creditCard) cycle = creditCardCycleStatus({ ...a, creditCard: a.creditCard }, snapshot.financialSpace.operations, date);
    } catch {
      /* A date before opening is unavailable. */
    }
    return [{ account: a, balance, money, cycle }];
  });
  return (
    <article className="tf-card tf-credit-card">
      <div className="tf-account-heading">
        <span className="tf-account-icon">
          <CreditCard size={18} aria-hidden="true" />
        </span>
        <button className="ibtn" disabled={!canEdit} aria-label={`Configurar tarjeta ${first.name}`} onClick={() => onEdit(first)}>
          <MoreHorizontal size={18} aria-hidden="true" />
        </button>
      </div>
      <h3>{first.name}</h3>
      {first.bankName && <p className="tf-bank-name">{first.bankName}</p>}
      <p className="muted">Tarjeta de crédito · {accounts.map(a => a.currency).join(' / ')}</p>
      <div className="tf-credit-balances tf-credit-basics">
        {pockets.map(({ account: a, balance: b, money: m }) => (
          <section className="tf-credit-pocket" key={a.id} aria-label={`Saldo de tarjeta ${a.currency}`}>
            <span className="tf-tag">{a.currency}</span>
            <p className="muted">Deuda total</p>
            <strong className="tf-amount">{b ? m(b.balanceMinor) : '—'}</strong>
          </section>
        ))}
      </div>
      <details className="tf-credit-details">
        <summary aria-label={`Ver detalles de ${first.name}`}>
          <span>Ver detalles</span>
          <ChevronDown size={14} aria-hidden="true" />
        </summary>
        <div className="tf-credit-balances tf-credit-expanded">
          {pockets.map(({ account: a, balance: b, money: m, cycle }) => (
            <section className="tf-credit-pocket" key={a.id} aria-label={`Detalles de tarjeta ${a.currency}`}>
              <span className="tf-tag">{a.currency}</span>
              <dl className="tf-credit-detail">
                <div>
                  <dt>Límite</dt>
                  <dd>{m(a.creditLimitMinor)}</dd>
                </div>
                <div>
                  <dt>Disponible</dt>
                  <dd>{b ? m(b.availableCreditMinor ?? 0) : '—'}</dd>
                </div>
              </dl>
              {cycle ? (
                <>
                  <div className="tf-credit-cycle">
                    <span>
                      <CalendarDays size={13} aria-hidden="true" />
                      Último corte: {cycle.lastStatementDate}
                    </span>
                    <dl className="tf-credit-detail">
                      <div>
                        <dt>Pago programado</dt>
                        <dd>{cycle.oldestUnpaidDueDate ?? cycle.paymentDate}</dd>
                      </div>
                      <div>
                        <dt>Pendiente del corte</dt>
                        <dd>{cycle.statementPendingMinor === null ? 'Por completar' : m(cycle.statementPendingMinor)}</dd>
                      </div>
                      <div>
                        <dt>Próximo corte</dt>
                        <dd>{cycle.nextStatementDate}</dd>
                      </div>
                      <div>
                        <dt>Consumo para ese corte</dt>
                        <dd>{cycle.unbilledDebtMinor === null ? 'Por completar' : m(cycle.unbilledDebtMinor)}</dd>
                      </div>
                      <div>
                        <dt>Siguiente pago</dt>
                        <dd>{cycle.nextPaymentDate}</dd>
                      </div>
                    </dl>
                  </div>
                  {cycle.paymentStatus === 'overdue' && <p className="tf-cycle-alert">Pendiente desde el pago programado: {m(cycle.overdueMinor ?? 0)}</p>}
                  {cycle.paymentStatus === 'due-today' && <p className="tf-cycle-alert">El pago programado es hoy.</p>}
                  {!cycle.baselineKnown && (
                    <p className="muted">
                      {cycle.needsReconciliation
                        ? 'Se añadieron movimientos anteriores a la captura. Actualiza el pendiente del corte.'
                        : 'Completa el pendiente del último corte para calcular tus próximos pagos.'}
                    </p>
                  )}
                </>
              ) : (
                <p className="muted">Configura los días de corte y pago y el pendiente del último corte.</p>
              )}
              <p className="muted">Apertura: {a.openingDate}</p>
            </section>
          ))}
        </div>
      </details>
    </article>
  );
}
