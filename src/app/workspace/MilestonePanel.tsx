import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CalendarDays, Check, Circle, Flag, FolderClosed, Pencil, Plus, Trash2, Type } from 'lucide-react';
import type { MilestoneInput, ProjectMilestone } from '../planning-types';
import type { Project, WorkspaceProps } from '../types';
import { errorMessage, localDate } from './helpers';
import { canInProject } from './permissions';
import { Dialog, ErrorNotice, ProjectIcon } from './ui';
import type { PlanningController } from './usePlanning';
import './planning-panels.css';

export interface MilestonePanelProps {
  data: WorkspaceProps;
  planning: PlanningController;
  project?: Project;
}

type MilestoneAction = { type: 'create'; requestId: string } | { type: 'edit' | 'delete'; row: ProjectMilestone };

function workspaceScope({ data, project }: MilestonePanelProps) {
  return data.workspace?.id ?? project?.workspace_id ?? data.projects[0]?.workspace_id ?? '';
}

export default function MilestonePanel(props: MilestonePanelProps) {
  const permissions = props.data.projects
    .map(row => `${row.id}:${row.archived_at ?? ''}:${[...(props.data.capabilities?.[row.id]?.permissions ?? [])].sort().join(',')}`)
    .sort()
    .join('|');
  return (
    <MilestonePanelBody
      key={`${workspaceScope(props)}:${props.data.planning?.scopeKey.join(':') ?? ''}:${props.data.currentUserId ?? ''}:${props.project?.id ?? ''}:${!!props.data.readOnly}:${!!props.data.accessUnavailable}:${permissions}`}
      {...props}
    />
  );
}

function MilestonePanelBody({ data, planning, project }: MilestonePanelProps) {
  const [action, setAction] = useState<MilestoneAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const workspaceId = workspaceScope({ data, planning, project });
  const readable = data.projects.filter(
    row =>
      row.workspace_id === workspaceId &&
      (!project || row.id === project.id) &&
      (!data.capabilities || !!data.capabilities[row.id]?.permissions.includes('project.read')),
  );
  const projectMap = new Map(readable.map(row => [row.id, row]));
  const writable = readable.filter(row => !data.readOnly && !data.accessUnavailable && !row.archived_at && canInProject(data, row.id, 'project.edit'));
  const rows = planning.state.milestones
    .filter(row => row.workspace_id === workspaceId && projectMap.has(row.project_id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const busy = submitting || planning.pending || data.pending;
  const mayEdit = (row: ProjectMilestone) => writable.some(candidate => candidate.id === row.project_id);

  async function complete(row: ProjectMilestone) {
    if (!mayEdit(row) || !planning.available || busy || lock.current) return;
    lock.current = true;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await planning.updateMilestone(row, { name: row.name, date: row.date, completed: !row.completed });
      if (active.current) setNotice(row.completed ? 'Hito reabierto.' : 'Hito completado.');
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (active.current) setSubmitting(false);
    }
  }

  return (
    <section className="pl-milestones" aria-label="Hitos de proyectos">
      <div className="pl-panel-heading">
        <div>
          <h3>
            <Flag size={17} aria-hidden="true" /> Hitos
          </h3>
          <p className="pl-help">Fechas clave del proyecto, independientes del estado de sus tareas.</p>
        </div>
        {writable.length > 0 && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || planning.loading || !planning.available}
            onClick={() => {
              setError(null);
              setNotice(null);
              setAction({ type: 'create', requestId: crypto.randomUUID() });
            }}
          >
            <Plus size={14} aria-hidden="true" /> Nuevo hito
          </button>
        )}
      </div>
      {planning.loading && (
        <p className="muted" role="status">
          Cargando hitos…
        </p>
      )}
      {!planning.available && !planning.loading && <p className="muted">La planificación no está disponible en este espacio.</p>}
      {(error || planning.error) && <ErrorNotice>{error ?? planning.error}</ErrorNotice>}
      {planning.error && (
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || planning.loading} onClick={planning.refresh}>
          Actualizar planificación
        </button>
      )}
      {notice && (
        <p className="pl-notice" role="status">
          {notice}
        </p>
      )}
      {!planning.loading && !rows.length && <p className="pl-empty">No hay hitos visibles. Añade una fecha clave para seguir el progreso del proyecto.</p>}
      {rows.length > 0 && (
        <ul className="pl-milestone-list">
          {rows.map(row => {
            const target = projectMap.get(row.project_id)!;
            return (
              <li key={row.id} className={`pl-milestone${row.completed ? ' is-complete' : ''}`}>
                <button
                  type="button"
                  className="pl-milestone-check"
                  aria-label={`${row.completed ? 'Reabrir' : 'Completar'} hito ${row.name}`}
                  aria-pressed={row.completed}
                  disabled={busy || !planning.available || !mayEdit(row)}
                  onClick={() => void complete(row)}
                >
                  {row.completed ? <Check size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
                </button>
                <div className="pl-milestone-content">
                  <strong>{row.name}</strong>
                  <span>
                    <CalendarDays size={13} aria-hidden="true" />
                    <time dateTime={row.date}>{displayDate(row.date)}</time>
                    {!project && (
                      <>
                        <ProjectIcon color={target.color} icon={target.icon} />
                        <span>{target.name}</span>
                      </>
                    )}
                    {target.archived_at && <span>· Archivado</span>}
                  </span>
                </div>
                {mayEdit(row) && (
                  <div className="pl-row-actions">
                    <button
                      type="button"
                      className="ibtn ibtn-xs"
                      aria-label={`Editar hito ${row.name}`}
                      disabled={busy || !planning.available}
                      onClick={() => {
                        setError(null);
                        setNotice(null);
                        setAction({ type: 'edit', row });
                      }}
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="ibtn ibtn-xs"
                      aria-label={`Eliminar hito ${row.name}`}
                      disabled={busy || !planning.available}
                      onClick={() => {
                        setError(null);
                        setNotice(null);
                        setAction({ type: 'delete', row });
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {action && (action.type === 'create' ? writable.length > 0 : mayEdit(action.row)) && (
        <MilestoneDialog
          key={action.type === 'create' ? action.requestId : `${action.type}:${action.row.id}`}
          action={action}
          projects={writable}
          project={project}
          planning={planning}
          pending={busy}
          onClose={() => setAction(null)}
          onSaved={() => {
            setAction(null);
            setNotice(action.type === 'delete' ? 'Hito eliminado. Las tareas se conservaron.' : 'Hito guardado.');
          }}
        />
      )}
    </section>
  );
}

function displayDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeZone: 'UTC' }).format(date) : value;
}

function MilestoneDialog({
  action,
  projects,
  project,
  planning,
  pending,
  onClose,
  onSaved,
}: {
  action: MilestoneAction;
  projects: Project[];
  project?: Project;
  planning: PlanningController;
  pending: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const row = action.type === 'create' ? undefined : action.row;
  const prefix = useId();
  const [projectId, setProjectId] = useState(row?.project_id ?? project?.id ?? projects[0]?.id ?? '');
  const [input, setInput] = useState<MilestoneInput>({ name: row?.name ?? '', date: row?.date ?? localDate(), completed: row?.completed ?? false });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const active = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const busy = pending || submitting;
  const frozen = action.type === 'create' && sent;
  const title = action.type === 'create' ? 'Nuevo hito' : action.type === 'edit' ? 'Editar hito' : 'Eliminar hito';

  async function submit(event: FormEvent) {
    event.preventDefault();
    const target = projects.find(candidate => candidate.id === projectId);
    if (busy || lock.current || !planning.available || !target || (row && row.workspace_id !== target.workspace_id)) return;
    if (action.type !== 'delete' && (!input.name.trim() || input.name.trim().length > 120 || !/^\d{4}-\d{2}-\d{2}$/.test(input.date))) {
      setError('Escribe un nombre de hasta 120 caracteres y una fecha válida.');
      return;
    }
    lock.current = true;
    setSubmitting(true);
    setError(null);
    setSent(true);
    try {
      const normalized = { ...input, name: input.name.trim() };
      if (action.type === 'create') await planning.createMilestone(target, normalized, action.requestId);
      else if (action.type === 'edit') await planning.updateMilestone(action.row, normalized);
      else await planning.deleteMilestone(action.row);
      if (active.current) onSaved();
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (active.current) setSubmitting(false);
    }
  }

  return (
    <Dialog title={title} busy={busy} onClose={onClose}>
      <form className="pw-form" onSubmit={event => void submit(event)}>
        <div className="pw-form-body pl-milestone-form">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {action.type === 'delete' ? (
            <p>
              Se eliminará únicamente el hito <strong>«{row?.name}»</strong>. Sus tareas, proyectos y fechas se conservarán.
            </p>
          ) : (
            <>
              {action.type === 'create' && !project && (
                <label className="pw-field" htmlFor={`${prefix}-project`}>
                  Proyecto
                  <span className="pl-input">
                    <FolderClosed size={15} aria-hidden="true" />
                    <select id={`${prefix}-project`} value={projectId} disabled={busy || frozen} onChange={event => setProjectId(event.target.value)}>
                      {projects.map(target => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
              )}
              <label className="pw-field" htmlFor={`${prefix}-name`}>
                Nombre del hito
                <span className="pl-input">
                  <Type size={15} aria-hidden="true" />
                  <input
                    id={`${prefix}-name`}
                    data-initial-focus
                    value={input.name}
                    maxLength={120}
                    required
                    disabled={busy || frozen}
                    onChange={event => setInput({ ...input, name: event.target.value })}
                    placeholder="Por ejemplo, lanzamiento"
                  />
                </span>
              </label>
              <label className="pw-field" htmlFor={`${prefix}-date`}>
                Fecha del hito
                <span className="pl-input">
                  <CalendarDays size={15} aria-hidden="true" />
                  <input
                    id={`${prefix}-date`}
                    type="date"
                    value={input.date}
                    required
                    disabled={busy || frozen}
                    onChange={event => setInput({ ...input, date: event.target.value })}
                  />
                </span>
              </label>
              <label className="pl-checkbox">
                <input
                  type="checkbox"
                  checked={input.completed}
                  disabled={busy || frozen}
                  onChange={event => setInput({ ...input, completed: event.target.checked })}
                />
                <span>Hito completado</span>
              </label>
              {frozen && error && (
                <p className="pl-help">El envío conserva sus datos para reintentarlo sin duplicados. Para cambiar el borrador, cancela y abre otro hito.</p>
              )}
              {row && error && (
                <p className="pl-help">Tu borrador se conserva. Si el hito cambió desde que lo abriste, ciérralo y vuelve a editar su versión actual.</p>
              )}
            </>
          )}
        </div>
        <div className="pw-form-footer">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            className={`btn ${action.type === 'delete' ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy || !planning.available || !projects.some(target => target.id === projectId)}
          >
            {submitting ? 'Guardando…' : action.type === 'delete' ? 'Eliminar hito' : 'Guardar hito'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
