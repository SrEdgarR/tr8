import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, CircleAlert, GitBranch, Link2, Plus, Trash2, X } from 'lucide-react';
import type { TaskDependency } from '../planning-types';
import type { Project, Task } from '../types';
import { errorMessage } from './helpers';
import { ErrorNotice, ProjectIcon } from './ui';
import type { PlanningController } from './usePlanning';
import './planning-panels.css';

export interface DependencyPanelProps {
  task: Task;
  tasks: Task[];
  projects: Project[];
  planning: PlanningController;
  readOnly?: boolean;
  canEdit?: boolean;
  onOpen: (task: Task) => void;
}

export default function DependencyPanel(props: DependencyPanelProps) {
  return <DependencyPanelBody key={`${props.task.workspace_id}:${props.task.project_id}:${props.task.id}:${!!props.readOnly}:${!!props.canEdit}`} {...props} />;
}

function DependencyPanelBody({ task, tasks, projects, planning, readOnly, canEdit = false, onOpen }: DependencyPanelProps) {
  const prefix = useId();
  const [attempt, setAttempt] = useState<{ blockerId: string; requestId: string; sent: boolean; submitted?: { task: Task; blocker: Task } } | null>(null);
  const [removing, setRemoving] = useState<TaskDependency | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const active = useRef(true);
  const lock = useRef(false);
  const cancelRemoval = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (removing) cancelRemoval.current?.focus();
  }, [removing]);

  const projectMap = new Map(projects.filter(row => row.workspace_id === task.workspace_id).map(row => [row.id, row]));
  const taskMap = new Map(tasks.filter(row => row.workspace_id === task.workspace_id && projectMap.has(row.project_id)).map(row => [row.id, row]));
  if (projectMap.has(task.project_id)) taskMap.set(task.id, task);
  const edges = planning.state.dependencies.filter(
    edge => edge.workspace_id === task.workspace_id && taskMap.has(edge.task_id) && taskMap.has(edge.blocker_task_id),
  );
  const blockers = edges.filter(edge => edge.task_id === task.id);
  const successors = edges.filter(edge => edge.blocker_task_id === task.id);
  const editable = !!canEdit && !readOnly && !task.archived_at && !!projectMap.get(task.project_id) && !projectMap.get(task.project_id)?.archived_at;
  const busy = submitting || planning.pending;
  const candidates = [...taskMap.values()]
    .filter(
      row => row.id !== task.id && !row.archived_at && !projectMap.get(row.project_id)?.archived_at && !blockers.some(edge => edge.blocker_task_id === row.id),
    )
    .sort((a, b) => a.title.localeCompare(b.title));
  const selected = attempt ? taskMap.get(attempt.blockerId) : undefined;
  const canSubmit = Boolean(selected && (attempt?.sent || candidates.some(row => row.id === selected.id)));
  const unresolved = blockers.filter(edge => taskMap.get(edge.blocker_task_id)?.status !== 'done');

  async function add() {
    if (!attempt || !selected || !editable || busy || lock.current || !planning.available || !canSubmit) return;
    lock.current = true;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    const submitted = attempt.submitted ?? { task, blocker: selected };
    setAttempt({ ...attempt, sent: true, submitted });
    try {
      await planning.addDependency(submitted.task, submitted.blocker, attempt.requestId);
      if (active.current) {
        setAttempt(null);
        setNotice('Dependencia añadida. No se modificaron el estado ni las fechas de las tareas.');
      }
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (active.current) setSubmitting(false);
    }
  }

  async function remove() {
    if (!removing || !editable || busy || lock.current || !planning.available || removing.task_id !== task.id) return;
    lock.current = true;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await planning.removeDependency(removing);
      if (active.current) {
        setRemoving(null);
        setNotice('Relación eliminada. Se conservaron las dos tareas.');
      }
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (active.current) setSubmitting(false);
    }
  }

  function relation(edge: TaskDependency, direction: 'blocker' | 'successor') {
    const linked = taskMap.get(direction === 'blocker' ? edge.blocker_task_id : edge.task_id);
    const project = linked && projectMap.get(linked.project_id);
    if (!linked || !project) return null;
    const predecessor = direction === 'blocker' ? linked : task;
    const successor = direction === 'blocker' ? task : linked;
    const successorDate = successor.start_date ?? successor.due_date;
    const dateConflict = predecessor.due_date && successorDate && predecessor.due_date >= successorDate;
    return (
      <li key={edge.id} className="pl-relation">
        <button type="button" className="pl-relation-link" onClick={() => onOpen(linked)}>
          <ProjectIcon color={project.color} icon={project.icon} />
          <span>
            <strong>{linked.title}</strong>
            <small>
              {project.name} · {project.code}-{linked.task_number}
              {linked.archived_at || project.archived_at ? ' · Archivada' : ''}
            </small>
          </span>
          {linked.status === 'done' ? <Check size={15} aria-label="Completada" /> : <ArrowUpRight size={15} aria-hidden="true" />}
        </button>
        {direction === 'blocker' && editable && (
          <button
            type="button"
            className="ibtn ibtn-xs"
            aria-label={`Quitar relación con ${linked.title}`}
            disabled={busy || !planning.available}
            onClick={() => {
              setAttempt(null);
              setError(null);
              setNotice(null);
              setRemoving(edge);
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        )}
        {dateConflict && (
          <p className="pl-date-warning">
            <CircleAlert size={13} aria-hidden="true" /> La sucesora debe comenzar después del día de vencimiento de su predecesora.
          </p>
        )}
      </li>
    );
  }

  return (
    <section className="td-section pl-dependencies" aria-label="Dependencias de la tarea">
      <div className="pl-panel-heading">
        <h4>
          <GitBranch size={15} aria-hidden="true" /> Dependencias
        </h4>
        {editable && !attempt && !removing && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy || planning.loading || !planning.available || candidates.length === 0}
            onClick={() => {
              setError(null);
              setNotice(null);
              setAttempt({ blockerId: '', requestId: crypto.randomUUID(), sent: false });
            }}
          >
            <Plus size={14} aria-hidden="true" /> Añadir dependencia
          </button>
        )}
      </div>
      {planning.loading && (
        <p className="muted" role="status">
          Cargando dependencias…
        </p>
      )}
      {!planning.available && !planning.loading && <p className="muted">La planificación no está disponible en este espacio.</p>}
      {planning.error && !error && <ErrorNotice>{planning.error}</ErrorNotice>}
      {planning.error && (
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || planning.loading} onClick={planning.refresh}>
          Actualizar planificación
        </button>
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {notice && (
        <p className="pl-notice" role="status">
          {notice}
        </p>
      )}
      {unresolved.length > 0 && (
        <p className="pl-info">
          <CircleAlert size={15} aria-hidden="true" />
          {unresolved.length === 1 ? 'Hay una predecesora pendiente.' : `Hay ${unresolved.length} predecesoras pendientes.`} Puedes completar esta tarea si lo
          necesitas.
        </p>
      )}
      {attempt && editable && (
        <div className="pl-dependency-editor">
          <label className="pw-field" htmlFor={`${prefix}-blocker`}>
            Esta tarea está bloqueada por
            <span className="pl-input">
              <Link2 size={15} aria-hidden="true" />
              <select
                id={`${prefix}-blocker`}
                aria-label="Esta tarea está bloqueada por"
                value={attempt.blockerId}
                disabled={busy || attempt.sent}
                onChange={event => setAttempt({ ...attempt, blockerId: event.target.value })}
              >
                <option value="">Selecciona una tarea</option>
                {attempt.sent && selected && !candidates.some(row => row.id === selected.id) && (
                  <option value={selected.id}>
                    {selected.title} · {projectMap.get(selected.project_id)?.name}
                  </option>
                )}
                {candidates.map(row => (
                  <option key={row.id} value={row.id}>
                    {row.title} · {projectMap.get(row.project_id)?.name}
                  </option>
                ))}
              </select>
            </span>
          </label>
          {attempt.sent && error && <p className="pl-help">Reintenta con esta selección. Para elegir otra tarea, cancela y abre un nuevo intento.</p>}
          <div className="pl-inline-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => {
                setAttempt(null);
                setError(null);
              }}
            >
              <X size={14} aria-hidden="true" /> Cancelar
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !planning.available || !canSubmit} onClick={() => void add()}>
              <Link2 size={14} aria-hidden="true" /> {submitting ? 'Guardando…' : 'Vincular tarea'}
            </button>
          </div>
        </div>
      )}
      {removing && editable && (
        <div
          className="pl-confirmation"
          role="alertdialog"
          aria-labelledby={`${prefix}-remove-title`}
          aria-describedby={`${prefix}-remove-description`}
          onKeyDown={event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            if (!busy) {
              setRemoving(null);
              setError(null);
            }
          }}
        >
          <h5 id={`${prefix}-remove-title`}>¿Quitar esta dependencia?</h5>
          <p id={`${prefix}-remove-description`}>
            Solo se eliminará la relación con «{taskMap.get(removing.blocker_task_id)?.title ?? 'la predecesora'}». Las dos tareas y su contenido se
            conservarán.
          </p>
          <div className="pl-inline-actions">
            <button
              ref={cancelRemoval}
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => {
                setRemoving(null);
                setError(null);
              }}
            >
              Cancelar
            </button>
            <button type="button" className="btn btn-danger btn-sm" disabled={busy || !planning.available} onClick={() => void remove()}>
              {submitting ? 'Quitando…' : 'Quitar relación'}
            </button>
          </div>
        </div>
      )}
      <div className="pl-relation-group">
        <h5>
          <ArrowDownLeft size={14} aria-hidden="true" /> Bloqueada por <span>{blockers.length}</span>
        </h5>
        {blockers.length ? <ul>{blockers.map(edge => relation(edge, 'blocker'))}</ul> : <p className="pl-help">Sin predecesoras visibles.</p>}
      </div>
      <div className="pl-relation-group">
        <h5>
          <ArrowUpRight size={14} aria-hidden="true" /> Bloquea a <span>{successors.length}</span>
        </h5>
        {successors.length ? <ul>{successors.map(edge => relation(edge, 'successor'))}</ul> : <p className="pl-help">Sin sucesoras visibles.</p>}
      </div>
    </section>
  );
}
