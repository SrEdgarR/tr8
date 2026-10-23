import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { AlertCircle, Check, Circle, FolderClosed, LoaderCircle, X } from 'lucide-react';
import { STATUSES } from '../constants';
import type { TaskStatus } from '../types';

export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <div className="pw-error" role="alert">
      <AlertCircle size={16} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function Busy({ children = 'Cargando tu espacio…' }: { children?: ReactNode }) {
  return (
    <div className="pw-loading" role="status">
      <LoaderCircle className="pw-spin" size={20} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function ProjectIcon({ color, large = false }: { color: string; large?: boolean }) {
  return (
    <span className={`picon${large ? ' lg' : ''}`} style={{ '--c': color } as CSSProperties}>
      <FolderClosed size={large ? 19 : 15} aria-hidden="true" />
    </span>
  );
}

export function StatusDot({ status }: { status: TaskStatus }) {
  const item = STATUSES.find(value => value.id === status)!;
  return status === 'done' ? (
    <Check size={14} style={{ color: item.color }} aria-hidden="true" />
  ) : (
    <Circle size={12} style={{ color: item.color }} aria-hidden="true" />
  );
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="pw-empty">
      <span className="pw-empty-icon">
        <FolderClosed size={24} aria-hidden="true" />
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    element?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => {
      element?.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className={`pw-dialog${wide ? ' pw-dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="pw-dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="ibtn" aria-label="Cerrar ventana" onClick={onClose} disabled={busy}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
