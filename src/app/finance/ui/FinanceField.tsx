import { cloneElement, useId, type ReactElement, type ReactNode } from 'react';
export default function FinanceField({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactElement<{ id?: string }> }) {
  const fieldId = useId();
  const input = cloneElement(children, { id: fieldId });
  return (
    <div className="pw-field">
      <label htmlFor={fieldId}>{label}</label>
      {icon ? (
        <div className="tf-input-wrap">
          <span className="tf-input-icon" aria-hidden="true">
            {icon}
          </span>
          {input}
        </div>
      ) : (
        input
      )}
    </div>
  );
}
