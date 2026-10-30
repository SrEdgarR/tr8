import { useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import './planning-mobile.css';

/** One set of controls: expanded on desktop, opt-in on a small screen. */
export default function PlanningViewOptions({ label, activeCount = 0, children }: { label: string; activeCount?: number; children: ReactNode }) {
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="pm-options">
      <button
        ref={toggle}
        type="button"
        className="btn btn-secondary pm-options-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(value => !value)}
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
        {label}
        {activeCount > 0 && (
          <span className="pm-options-count">
            {activeCount}
            <span className="sr"> filtros activos</span>
          </span>
        )}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div
        id={id}
        className={`pm-options-panel${open ? ' is-open' : ''}`}
        role="group"
        aria-label={label}
        onKeyDown={event => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation();
            setOpen(false);
            if (toggle.current && getComputedStyle(toggle.current).display !== 'none') toggle.current.focus();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
