import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Home, Users } from 'lucide-react';
import type { WorkspaceSummary } from '../types';
import './workspace-picker.css';

interface Props {
  workspaces: WorkspaceSummary[];
  selectedId: string;
  disabled?: boolean;
  modal?: boolean;
  onSelect?: (id: string) => void;
}
const name = (space: WorkspaceSummary) => (space.kind === 'personal' ? 'Mi espacio personal' : space.name);

export default function WorkspacePicker(props: Props) {
  return (
    <ScopedWorkspacePicker
      key={JSON.stringify([props.selectedId, props.disabled, props.modal, props.workspaces.map(space => [space.id, space.version, space.name])])}
      {...props}
    />
  );
}

function ScopedWorkspacePicker({ workspaces, selectedId, disabled = false, modal = false, onSelect }: Props) {
  const prefix = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(selectedId);
  const [position, setPosition] = useState({ position: 'fixed' as 'fixed' | 'absolute', left: 8, top: 64, width: 280, maxHeight: 360 });
  const typeahead = useRef({ value: '', at: 0 });
  const selected = workspaces.find(space => space.id === selectedId);
  const unavailable = disabled || !onSelect || !selected;
  const activeIndex = Math.max(
    0,
    workspaces.findIndex(space => space.id === activeId),
  );
  const active = workspaces[activeIndex];
  const listId = `${prefix}-spaces`;
  const optionId = (index: number) => `${prefix}-space-${index}`;
  const activeOptionId = optionId(activeIndex);
  const modalContainer = open && modal ? (trigger.current?.closest<HTMLElement>('[role="dialog"][aria-modal="true"]') ?? null) : null;
  const portalContainer = modalContainer ?? document.body;

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const containerBounds = modalContainer?.getBoundingClientRect();
      const availableWidth = modalContainer ? modalContainer.clientWidth || containerBounds?.width || window.innerWidth : window.innerWidth;
      const availableHeight = modalContainer ? modalContainer.clientHeight || containerBounds?.height || window.innerHeight : window.innerHeight;
      const left = bounds.left - (containerBounds?.left ?? 0) - (modalContainer?.clientLeft ?? 0);
      const topEdge = bounds.top - (containerBounds?.top ?? 0) - (modalContainer?.clientTop ?? 0);
      const bottomEdge = topEdge + bounds.height;
      const width = Math.min(Math.max(bounds.width, 276), availableWidth - 16);
      const below = availableHeight - bottomEdge - 16;
      const above = topEdge - 16;
      const upwards = below < 180 && above > below;
      const maxHeight = Math.max(100, Math.min(380, upwards ? above : below));
      const top = upwards ? Math.max(8, topEdge - Math.min(menu.current?.scrollHeight ?? 380, maxHeight) - 6) : bottomEdge + 6;
      setPosition({ position: modalContainer ? 'absolute' : 'fixed', left: Math.max(8, Math.min(left, availableWidth - width - 8)), top, width, maxHeight });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, modalContainer]);

  useLayoutEffect(() => {
    if (open) document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeOptionId]);

  function choose(space: WorkspaceSummary) {
    if (unavailable) return;
    setOpen(false);
    if (space.id !== selectedId) onSelect?.(space.id);
    trigger.current?.focus();
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (unavailable) return;
    if (event.key === 'Escape') {
      if (open) event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open && active) choose(active);
      else {
        setActiveId(selectedId);
        setOpen(true);
      }
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      let index = activeIndex;
      if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = workspaces.length - 1;
      else if (open) index = Math.max(0, Math.min(workspaces.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      setActiveId(workspaces[index]?.id ?? selectedId);
      setOpen(true);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const now = Date.now();
      const value = (now - typeahead.current.at < 600 ? typeahead.current.value : '') + event.key.toLocaleLowerCase('es');
      typeahead.current = { value, at: now };
      const match = workspaces.find(space => name(space).toLocaleLowerCase('es').startsWith(value));
      if (match) {
        event.preventDefault();
        setActiveId(match.id);
        setOpen(true);
      }
    }
  }
  const Icon = selected?.kind === 'team' ? Users : Home;
  return (
    <div className="wp-picker">
      <button
        ref={trigger}
        type="button"
        id="workspace-select"
        role="combobox"
        aria-label="Espacio de trabajo"
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-expanded={open}
        aria-activedescendant={open && active ? optionId(activeIndex) : undefined}
        className="wp-trigger"
        disabled={unavailable}
        title={selected ? name(selected) : 'Espacio no disponible'}
        onClick={() => {
          setActiveId(selectedId);
          setOpen(value => !value);
        }}
        onKeyDown={onKeyDown}
        onBlur={event => {
          if (!menu.current?.contains(event.relatedTarget)) setOpen(false);
        }}
      >
        <span className={`wp-icon ${selected?.kind ?? 'personal'}`}>
          <Icon size={14} aria-hidden="true" />
        </span>
        <span className="wp-selected-name">{selected ? name(selected) : 'Espacio no disponible'}</span>
        <ChevronDown size={13} aria-hidden="true" className="wp-chevron" />
      </button>
      {open &&
        !unavailable &&
        createPortal(
          <div ref={menu} id={listId} role="listbox" aria-label="Espacios de trabajo" className="wp-menu" style={position}>
            <p className="wp-menu-heading" role="presentation">
              Tus espacios
            </p>
            {workspaces.map((space, index) => {
              const ItemIcon = space.kind === 'team' ? Users : Home;
              return (
                <div
                  key={space.id}
                  id={optionId(index)}
                  role="option"
                  aria-label={name(space)}
                  aria-selected={space.id === selectedId}
                  className={`wp-option${space.id === activeId ? ' is-active' : ''}`}
                  onMouseEnter={() => setActiveId(space.id)}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => choose(space)}
                >
                  <span className={`wp-icon ${space.kind}`}>
                    <ItemIcon size={16} aria-hidden="true" />
                  </span>
                  <span className="wp-option-copy">
                    <strong>{name(space)}</strong>
                    <small>{space.kind === 'team' ? 'Equipo' : 'Personal'}</small>
                  </span>
                  {space.id === selectedId && <Check size={15} aria-hidden="true" className="wp-selected-check" />}
                </div>
              );
            })}
          </div>,
          portalContainer,
        )}
    </div>
  );
}
