import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, FolderPlus, ListPlus, Plus } from 'lucide-react';

export default function WorkspaceCreateMenu({
  canProject,
  canTask,
  pending,
  onProject,
  onTask,
}: {
  canProject: boolean;
  canTask: boolean;
  pending: boolean;
  onProject: () => void;
  onTask: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  if (!canProject && !canTask) return null;
  return (
    <div
      ref={root}
      className="pw-create-menu"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
        if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
        if (!buttons.length) return;
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}
    >
      <button
        ref={trigger}
        className="btn btn-secondary btn-sm"
        aria-label="Crear nuevo"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        disabled={pending}
        onClick={() => setOpen(value => !value)}
      >
        <Plus size={14} aria-hidden="true" />
        <span>Nuevo</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="pw-create-popover" id={id} role="menu" aria-label="Crear en este espacio">
          <button
            type="button"
            role="menuitem"
            disabled={pending || !canProject}
            onClick={() => {
              setOpen(false);
              onProject();
            }}
          >
            <FolderPlus size={16} aria-hidden="true" />
            <span>Nuevo proyecto</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={pending || !canTask}
            onClick={() => {
              setOpen(false);
              onTask();
            }}
          >
            <ListPlus size={16} aria-hidden="true" />
            <span>Nueva tarea</span>
          </button>
        </div>
      )}
    </div>
  );
}
