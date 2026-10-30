import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { AlertCircle, FolderClosed, LoaderCircle, X } from 'lucide-react';
import type { TaskStatus } from '../types';
import { ProjectGlyph, TaskStatusIcon } from './project-identity';

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

export function ProjectIcon({ color, icon, large = false }: { color: string; icon?: string; large?: boolean }) {
  return (
    <span className={`picon${large ? ' lg' : ''}`} style={{ '--c': color } as CSSProperties}>
      <ProjectGlyph icon={icon} size={large ? 19 : 15} />
    </span>
  );
}

export function StatusDot({ status }: { status: TaskStatus }) {
  return <TaskStatusIcon status={status} />;
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

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.matches(':disabled') || element.closest('[hidden],[inert],[aria-hidden="true"],dialog:not([open])')) return false;
  if (!element.matches('a[href],button,input,select,textarea,[tabindex]')) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}

function restoreFocus(trigger: HTMLElement | null) {
  if (canRestoreFocus(trigger)) {
    trigger.focus();
    if (document.activeElement === trigger) return;
  }
  const remainingDialog = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
  const candidates = [
    remainingDialog?.querySelector<HTMLElement>(
      '[data-initial-focus],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)',
    ),
    document.querySelector<HTMLElement>('#tr8-sidebar[aria-modal="true"] [data-mobile-nav-close]'),
    document.querySelector<HTMLElement>('.pw-menu'),
    document.getElementById('workspace-content'),
  ];
  for (const candidate of candidates) {
    if (!canRestoreFocus(candidate ?? null)) continue;
    candidate!.focus();
    if (document.activeElement === candidate) return;
  }
}

export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  wide = false,
  className,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef<{ x: number; y: number } | null>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    element?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => {
      element?.close();
      restoreFocus(trigger);
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className={`pw-dialog${wide ? ' pw-dialog-wide' : ''}${className ? ` ${className}` : ''}`}
      aria-labelledby={titleId}
      onPointerDown={event => {
        backdropPress.current = null;
        if (busy || event.button !== 0 || event.isPrimary === false || event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)
          backdropPress.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerCancel={() => {
        backdropPress.current = null;
      }}
      onClick={event => {
        const press = backdropPress.current;
        backdropPress.current = null;
        if (!press || busy || event.target !== event.currentTarget || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
      onCancel={event => {
        event.preventDefault();
        event.stopPropagation();
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
