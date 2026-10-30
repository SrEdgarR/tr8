import { ArrowLeftRight, Coins } from 'lucide-react';
import type { FinancialAccount } from '../domain/types';
import type { FinancialSnapshot } from '../domain/workspace-types';
import { creditCardCycleStatus } from '../domain/credit-cards';
import { formatMoneyMinor, parseAmountMinor } from '../domain/money';
import Field from './FinanceField';
import AmountInput from './AmountInput';

export default function CardPaymentAmounts({
  snapshot,
  source,
  destination,
  sourceAmount,
  destinationAmount,
  onDestinationAmount,
  date,
  excludedOperationId,
  disabled = false,
}: {
  snapshot: FinancialSnapshot;
  source?: FinancialAccount;
  destination?: FinancialAccount;
  sourceAmount: string;
  destinationAmount: string;
  onDestinationAmount: (value: string) => void;
  date: string;
  excludedOperationId?: string;
  disabled?: boolean;
}) {
  if (!source || destination?.type !== 'credit') return null;
  const definitions = snapshot.financialSpace.currencyDefinitions;
  const from = definitions.find(c => c.code === source.currency)!;
  const to = definitions.find(c => c.code === destination.currency)!;
  const foreign = from.code !== to.code;
  let rate = '';
  let credit: number | null = null;
  try {
    credit = parseAmountMinor(foreign ? destinationAmount : sourceAmount, to.minorUnitDigits);
    if (foreign) {
      const debit = parseAmountMinor(sourceAmount, from.minorUnitDigits);
      const numerator = BigInt(debit) * 10n ** BigInt(to.minorUnitDigits);
      const denominator = BigInt(credit) * 10n ** BigInt(from.minorUnitDigits);
      const scaled = (numerator * 1000000n + denominator / 2n) / denominator;
      const fraction = String(scaled % 1000000n)
        .padStart(6, '0')
        .replace(/0+$/, '');
      rate = scaled === 0n ? `menos de 0,000001` : `${new Intl.NumberFormat('es').format(scaled / 1000000n)}${fraction ? `,${fraction}` : ''}`;
    }
  } catch {
    // Partial input is allowed while typing; submission validates both amounts.
  }
  let pending: number | null = null;
  if (!disabled && destination.creditCard) {
    try {
      pending = creditCardCycleStatus(
        { ...destination, creditCard: destination.creditCard },
        snapshot.financialSpace.operations.filter(operation => operation.id !== excludedOperationId),
        date,
      ).statementPendingMinor;
    } catch {
      // A missing statement/date must not invent a pending balance.
    }
  }
  return (
    <>
      {foreign && (
        <Field label={`Abono a la tarjeta · ${to.code}`} icon={<Coins size={14} aria-hidden="true" />}>
          <AmountInput
            key={destination.id}
            digits={to.minorUnitDigits}
            name="destinationAmount"
            required
            inputMode="decimal"
            placeholder="0,00"
            disabled={disabled}
            value={destinationAmount}
            onValueChange={onDestinationAmount}
          />
        </Field>
      )}
      <aside className="tf-payment-preview" aria-label="Resumen del pago de tarjeta">
        <div className="row">
          <ArrowLeftRight size={16} aria-hidden="true" />
          <strong>
            {from.code} → {to.code}
          </strong>
        </div>
        {foreign && <p>Introduce lo debitado de tu cuenta y lo abonado a la tarjeta según tu banco.</p>}
        {rate && (
          <p>
            Tasa resultante: 1 {to.code} ≈ {rate} {from.code}.
          </p>
        )}
        {pending !== null && (
          <p>
            Pendiente de cortes cerrados: <strong>{formatMoneyMinor(pending, to)}</strong>.
            {credit !== null && (
              <>
                {' '}
                Después del pago: <strong>{formatMoneyMinor(Math.max(0, pending - credit), to)}</strong>.
              </>
            )}
          </p>
        )}
        <p>El abono reduce primero los cortes pendientes; el excedente reduce la deuda restante. El pago no se cuenta como otro gasto.</p>
      </aside>
    </>
  );
}
