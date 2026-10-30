import { useId, useRef, useState, type FormEvent } from 'react';
import { Bookmark, Check, CircleDot, CircleHelp, Columns3, Filter, Flag, PencilLine, Save, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import type { SavedTaskView, TaskViewConfig } from '../productivity-types';
import type { Project, WorkspaceMember } from '../types';
import { PRIORITIES, STATUSES } from '../constants';
import { Dialog, ErrorNotice } from './ui';
import { errorMessage } from './helpers';
import './mobile-task-controls.css';

export interface SavedViewsProps {
  savedViews?: SavedTaskView[];
  onCreateView?: (name: string, config: TaskViewConfig, requestId?: string) => Promise<SavedTaskView>;
  onUpdateView?: (view: SavedTaskView, name: string, config: TaskViewConfig) => Promise<SavedTaskView>;
  onDeleteView?: (view: SavedTaskView) => Promise<void>;
  productivityLoading?: boolean;
  productivityError?: string | null;
}

const COLUMN_LABELS = {
  project: 'Proyecto',
  status: 'Estado',
  priority: 'Prioridad',
  assignee: 'Responsable',
  start_date: 'Inicio',
  due_date: 'Vencimiento',
} as const;
type Props = SavedViewsProps & {
  config: TaskViewConfig;
  onChange: (config: TaskViewConfig) => void;
  projects: Project[];
  members: WorkspaceMember[];
  pending: boolean;
  selected: string;
  onSelect: (id: string) => void;
  resultCount: number;
  hasFilters: boolean;
  onResetFilters: () => void;
  orderHelp?: string;
};
function changed<T extends string>(list: T[], value: T, checked: boolean) {
  return checked ? [...list, value] : list.filter(item => item !== value);
}

export default function TaskViewControls({
  config,
  onChange,
  projects,
  members,
  pending,
  savedViews = [],
  onCreateView,
  onUpdateView,
  onDeleteView,
  productivityLoading,
  productivityError,
  selected,
  onSelect,
  resultCount,
  hasFilters,
  onResetFilters,
  orderHelp,
}: Props) {
  const optionsId = useId();
  const optionsToggle = useRef<HTMLButtonElement>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [dialog, setDialog] = useState<'save' | 'edit' | 'delete' | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createId = useRef<string | null>(null);
  const submitting = useRef(false);
  const current = savedViews.find(view => view.id === selected);
  const patch = (value: Partial<TaskViewConfig>) => onChange({ ...config, ...value });
  const filterCount =
    config.statuses.length +
    config.priorities.length +
    config.projectIds.length +
    config.assigneeIds.length +
    Number(config.due !== 'all') +
    Number(config.favoritesOnly);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      if (dialog === 'delete' && current && onDeleteView) {
        await onDeleteView(current);
        onSelect('');
      } else if (dialog === 'edit' && current && onUpdateView) {
        const saved = await onUpdateView(current, name.trim(), config);
        onSelect(saved.id);
      } else if (dialog === 'save' && onCreateView) {
        if (!createId.current) throw new Error('Vuelve a abrir el guardado de la vista antes de continuar.');
        const saved = await onCreateView(name.trim(), config, createId.current);
        onSelect(saved.id);
      }
      setDialog(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  function open(next: 'save' | 'edit' | 'delete') {
    if (next === 'save') createId.current = crypto.randomUUID();
    setError(null);
    setName(next === 'save' ? '' : (current?.name ?? ''));
    setDialog(next);
  }
  return (
    <>
      <div className="tv-view-controls" role="group" aria-label="Buscar, filtrar y organizar tareas">
        <label className="tv-quick-search">
          <Search size={14} aria-hidden="true" />
          <span className="sr">Buscar tareas</span>
          <input type="search" placeholder="Buscar tareas…" maxLength={500} value={config.query} onChange={event => patch({ query: event.target.value })} />
        </label>
        <button
          ref={optionsToggle}
          type="button"
          className={`btn btn-secondary tv-mobile-options-toggle${hasFilters ? ' has-filters' : ''}`}
          aria-label={filterCount > 0 ? `Opciones de vista, ${filterCount} ${filterCount === 1 ? 'filtro activo' : 'filtros activos'}` : 'Opciones de vista'}
          aria-expanded={optionsOpen}
          aria-controls={optionsId}
          onClick={() => setOptionsOpen(previous => !previous)}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          <span>Opciones</span>
          {filterCount > 0 && (
            <span className="tv-filter-count" aria-hidden="true">
              {filterCount}
            </span>
          )}
        </button>
        <div
          id={optionsId}
          className={`tv-mobile-options${optionsOpen ? ' is-open' : ''}`}
          role="group"
          aria-label="Opciones de vista de tareas"
          onKeyDown={event => {
            if (event.key === 'Escape' && optionsOpen) {
              event.stopPropagation();
              setOptionsOpen(false);
              if (optionsToggle.current && getComputedStyle(optionsToggle.current).display !== 'none') optionsToggle.current.focus();
            }
          }}
        >
          <label className="tv-quick-filter" title="Filtrar por estado">
            <CircleDot size={14} aria-hidden="true" />
            <span className="sr">Filtrar por estado</span>
            <select
              value={config.statuses.length > 1 ? 'multiple' : (config.statuses[0] ?? '')}
              onChange={event => patch({ statuses: event.target.value ? [event.target.value as TaskViewConfig['statuses'][number]] : [] })}
            >
              <option value="">Todos los estados</option>
              {config.statuses.length > 1 && (
                <option value="multiple" disabled>
                  {config.statuses.length} estados
                </option>
              )}
              {STATUSES.map(status => (
                <option key={status.id} value={status.id}>
                  {status.name}
                </option>
              ))}
            </select>
          </label>
          <label className="tv-quick-filter" title="Filtrar por prioridad">
            <Flag size={14} aria-hidden="true" />
            <span className="sr">Filtrar por prioridad</span>
            <select
              value={config.priorities.length > 1 ? 'multiple' : (config.priorities[0] ?? '')}
              onChange={event => patch({ priorities: event.target.value ? [event.target.value as TaskViewConfig['priorities'][number]] : [] })}
            >
              <option value="">Todas las prioridades</option>
              {config.priorities.length > 1 && (
                <option value="multiple" disabled>
                  {config.priorities.length} prioridades
                </option>
              )}
              {PRIORITIES.map(priority => (
                <option key={priority.id} value={priority.id}>
                  {priority.name}
                </option>
              ))}
            </select>
          </label>
          <details className="tv-control-menu">
            <summary title="Filtros adicionales">
              <Filter size={14} aria-hidden="true" /> <span className="tv-menu-label">Filtros</span>
              {filterCount > 0 && <span className="tv-filter-count">{filterCount}</span>}
            </summary>
            <div className="tv-control-body tv-filter-grid">
              <fieldset>
                <legend>Estados</legend>
                {STATUSES.map(status => (
                  <label key={status.id}>
                    <input
                      type="checkbox"
                      checked={config.statuses.includes(status.id)}
                      onChange={event => patch({ statuses: changed(config.statuses, status.id, event.target.checked) })}
                    />
                    {status.name}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Prioridades</legend>
                {PRIORITIES.map(priority => (
                  <label key={priority.id}>
                    <input
                      type="checkbox"
                      checked={config.priorities.includes(priority.id)}
                      onChange={event => patch({ priorities: changed(config.priorities, priority.id, event.target.checked) })}
                    />
                    {priority.name}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Proyectos</legend>
                {projects.map(project => (
                  <label key={project.id}>
                    <input
                      type="checkbox"
                      checked={config.projectIds.includes(project.id)}
                      onChange={event => patch({ projectIds: changed(config.projectIds, project.id, event.target.checked) })}
                    />
                    <i className="tv-project-dot" style={{ background: project.color }} />
                    {project.name}
                  </label>
                ))}
                {!projects.length && <p className="faint">Sin proyectos disponibles.</p>}
              </fieldset>
              <fieldset>
                <legend>Responsables</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={config.assigneeIds.includes('none')}
                    onChange={event => patch({ assigneeIds: changed(config.assigneeIds, 'none', event.target.checked) })}
                  />
                  Sin responsable
                </label>
                {members.map(member => (
                  <label key={member.id}>
                    <input
                      type="checkbox"
                      checked={config.assigneeIds.includes(member.id)}
                      onChange={event => patch({ assigneeIds: changed(config.assigneeIds, member.id, event.target.checked) })}
                    />
                    {member.display_name}
                  </label>
                ))}
              </fieldset>
              <label className="tv-control-field">
                Fecha de vencimiento
                <select aria-label="Filtrar por vencimiento" value={config.due} onChange={event => patch({ due: event.target.value as TaskViewConfig['due'] })}>
                  <option value="all">Cualquier fecha</option>
                  <option value="overdue">Vencidas</option>
                  <option value="today">Hoy</option>
                  <option value="next7">Próximos 7 días</option>
                  <option value="undated">Sin fecha</option>
                </select>
              </label>
              <label className="tv-favorite-filter">
                <input type="checkbox" checked={config.favoritesOnly} onChange={event => patch({ favoritesOnly: event.target.checked })} />
                Solo favoritas
              </label>
            </div>
          </details>
          <details className="tv-control-menu">
            <summary title="Organizar tareas">
              <SlidersHorizontal size={14} aria-hidden="true" /> <span className="tv-menu-label">Organizar</span>
            </summary>
            <div className="tv-control-body tv-organize-fields">
              <label>
                Ordenar por
                <select aria-label="Ordenar tareas por" value={config.sort} onChange={event => patch({ sort: event.target.value as TaskViewConfig['sort'] })}>
                  <option value="manual">Orden manual</option>
                  <option value="title">Título</option>
                  <option value="status">Estado</option>
                  <option value="priority">Prioridad</option>
                  <option value="due_date">Vencimiento</option>
                  <option value="created_at">Creación</option>
                  <option value="updated_at">Actualización</option>
                </select>
              </label>
              <label>
                Dirección
                <select
                  aria-label="Dirección de orden"
                  value={config.direction}
                  onChange={event => patch({ direction: event.target.value as TaskViewConfig['direction'] })}
                >
                  <option value="asc">Ascendente</option>
                  <option value="desc">Descendente</option>
                </select>
              </label>
              <label>
                Agrupar por
                <select
                  aria-label="Agrupar tareas por"
                  value={config.group}
                  onChange={event => patch({ group: event.target.value as TaskViewConfig['group'] })}
                >
                  <option value="none">Sin agrupación</option>
                  <option value="status">Estado</option>
                  <option value="project">Proyecto</option>
                  <option value="priority">Prioridad</option>
                  <option value="assignee">Responsable</option>
                </select>
              </label>
            </div>
          </details>
          {config.view === 'table' && (
            <details className="tv-control-menu">
              <summary title="Columnas de la tabla">
                <Columns3 size={14} aria-hidden="true" /> <span className="tv-menu-label">Columnas</span>
              </summary>
              <div className="tv-control-body">
                <p className="faint">El título siempre está visible.</p>
                {Object.entries(COLUMN_LABELS).map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={config.columns.includes(key as keyof typeof COLUMN_LABELS)}
                      onChange={event => patch({ columns: changed(config.columns, key as keyof typeof COLUMN_LABELS, event.target.checked) })}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </details>
          )}
          {(onCreateView || savedViews.length > 0 || productivityLoading) && (
            <label className="tv-saved-select">
              <span className="sr">Vistas guardadas</span>
              <Bookmark size={14} aria-hidden="true" />
              <select
                aria-label="Vistas guardadas"
                value={selected}
                disabled={pending || busy || productivityLoading}
                onChange={event => onSelect(event.target.value)}
              >
                <option value="">Vista actual</option>
                {savedViews.map(view => (
                  <option key={view.id} value={view.id}>
                    {view.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {onCreateView && (
            <button
              className="btn btn-ghost btn-sm tv-compact-action"
              title="Guardar vista"
              disabled={pending || busy || productivityLoading || Boolean(productivityError)}
              onClick={() => open('save')}
            >
              <Save size={13} aria-hidden="true" />
              <span className="tv-action-label">Guardar vista</span>
            </button>
          )}
          {current && onUpdateView && (
            <button
              className="btn btn-ghost btn-sm tv-compact-action"
              title="Actualizar vista"
              disabled={pending || busy || productivityLoading}
              onClick={() => open('edit')}
            >
              <PencilLine size={13} aria-hidden="true" /> <span className="tv-action-label">Actualizar vista</span>
            </button>
          )}
          {current && onDeleteView && (
            <button
              className="ibtn ibtn-xs"
              aria-label={`Eliminar vista ${current.name}`}
              disabled={pending || busy || productivityLoading}
              onClick={() => open('delete')}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          )}
          {hasFilters && (
            <button
              type="button"
              className="btn btn-ghost btn-sm tv-clear-filters tv-compact-action"
              onClick={onResetFilters}
              title="Limpiar todos los filtros"
            >
              <X size={13} aria-hidden="true" />
              <span className="tv-action-label">Limpiar filtros</span>
            </button>
          )}
          {orderHelp && (
            <details className="tv-mobile-order-help">
              <summary>
                <CircleHelp size={15} aria-hidden="true" /> Cómo ordenar las tareas
              </summary>
              <p>{orderHelp}</p>
            </details>
          )}
        </div>
        <span className="pw-result-count" role="status">
          {resultCount} {resultCount === 1 ? 'tarea' : 'tareas'}
        </span>
      </div>
      {productivityError && <ErrorNotice>{productivityError}</ErrorNotice>}
      {dialog && (
        <Dialog
          title={dialog === 'delete' ? 'Eliminar vista guardada' : dialog === 'edit' ? 'Actualizar vista' : 'Guardar vista'}
          busy={busy}
          onClose={() => setDialog(null)}
        >
          <form className="pw-form" onSubmit={event => void submit(event)}>
            <div className="pw-form-body">
              {error && <ErrorNotice>{error}</ErrorNotice>}
              {dialog === 'delete' ? (
                <p>Se eliminará únicamente la vista «{current?.name}». Tus tareas y proyectos se conservan.</p>
              ) : (
                <label className="pw-field">
                  Nombre de la vista
                  <input data-initial-focus required maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)} />
                </label>
              )}
            </div>
            <div className="pw-form-footer">
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setDialog(null)}>
                <X size={13} aria-hidden="true" />
                Cancelar
              </button>
              <button className={`btn ${dialog === 'delete' ? 'btn-danger' : 'btn-primary'}`} disabled={busy || (dialog !== 'delete' && !name.trim())}>
                <Check size={13} aria-hidden="true" />
                {busy ? 'Guardando…' : dialog === 'delete' ? 'Eliminar vista' : 'Guardar vista'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
