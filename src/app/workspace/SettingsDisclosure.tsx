import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export default function SettingsDisclosure({
  title,
  description,
  icon,
  value,
  children,
  onExpandedChange,
  disabled = false,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  value?: ReactNode;
  children: ReactNode;
  onExpandedChange?: (expanded: boolean) => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return (
    <section className="pw-settings-disclosure">
      <h3>
        <button
          type="button"
          className="pw-settings-disclosure-toggle"
          aria-label={title}
          aria-describedby={`${contentId}-description${value ? ` ${contentId}-value` : ''}`}
          aria-expanded={expanded}
          aria-controls={contentId}
          disabled={disabled}
          onClick={() => {
            const next = !expanded;
            setExpanded(next);
            onExpandedChange?.(next);
          }}
        >
          <span className="pw-settings-item-icon" aria-hidden="true">
            {icon}
          </span>
          <span className="pw-settings-item-copy">
            <strong>{title}</strong>
            <span id={`${contentId}-description`}>{description}</span>
          </span>
          {value && (
            <span className="pw-settings-item-value" id={`${contentId}-value`}>
              {value}
            </span>
          )}
          <ChevronDown size={16} className="pw-settings-chevron" aria-hidden="true" />
        </button>
      </h3>
      <div id={contentId} className="pw-settings-disclosure-body" hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}
