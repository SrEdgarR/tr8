import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import {
  Archive,
  ArrowRightLeft,
  CalendarDays,
  Check,
  CheckCheck,
  Copy,
  ListChecks,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Tag,
  Timer,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import type { CalendarApi, CollaborationApi, Project, Task, TaskSubtask, WorkspaceProps } from '../types';
import type { WorkManagementApi } from '../work-management-types';
import type { RecurrenceApi } from '../recurrence-types';
import { PRIORITIES, PROJECT_COLORS, STATUSES, formatDate } from '../constants';
import { PriorityIcon, TaskStatusIcon } from './project-identity';
import { Dialog, ErrorNotice, ProjectIcon } from './ui';
import { errorMessage } from './helpers';
import TaskForm from './TaskForm';
import RecurrencePanel from './RecurrencePanel';
import './task-detail.css';

export interface TaskDetailProps {
  task: Task;
  projects: Project[];
  pending: boolean;
  readOnly?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canAssign?: boolean;
  assigneeName?: string | null;
  canCreateInProject?: (projectId: string) => boolean;
  collaboration?: CollaborationApi;
  calendar?: CalendarApi;
  api?: WorkManagementApi;
  recurrence?: RecurrenceApi;
  recurrenceCanCreate?: boolean;
  planningContent?: ReactNode;
  communicationContent?: ReactNode;
  onUpdate: WorkspaceProps['onUpdateTask'];
  onDelete: WorkspaceProps['onDeleteTask'];
  onClose: () => void;
  onTaskSaved?: (task: Task) => void;
  onTaskMoved?: (task: Task) => void;
}

type Action = { type: 'duplicate' | 'move' | 'archive' | 'restore' | 'delete'; task: Task; requestId: string };
const labelsOf = (task: Task) => [...(task.labels ?? [])];
const subtasksOf = (task: Task) => (task.subtasks ?? []).map(item => ({ ...item }));
const detailsOf = (task: Task) => ({ labels: labelsOf(task), estimate_minutes: task.estimate_minutes ?? null, subtasks: subtasksOf(task) });

function labelColor(name: string) {
  const value = Array.from(name).reduce((total, character) => total + character.codePointAt(0)!, 0);
  return PROJECT_COLORS[value % PROJECT_COLORS.length];
}

/** Scope changes replace the draft and its outstanding requests, while refetches preserve it. */
export default function TaskDetail(props: TaskDetailProps) {
  return <ScopedTaskDetail key={JSON.stringify([props.task.workspace_id, props.task.id, props.api?.scopeKey])} {...props} />;
}

function ScopedTaskDetail({
  task,
  projects,
  pending,
  readOnly = false,
  canEdit = true,
  canDelete = false,
  canAssign = false,
  assigneeName,
  canCreateInProject = () => false,
  collaboration,
  calendar,
  api,
  recurrence,
  recurrenceCanCreate = false,
  planningContent,
  communicationContent,
  onUpdate,
  onDelete,
  onClose,
  onTaskSaved,
  onTaskMoved,
}: TaskDetailProps) {
  const [savedTask, setSavedTask] = useState(task);
  const current = task.version >= savedTask.version ? task : savedTask;
  const [baseline, setBaseline] = useState(task);
  const [labels, setLabels] = useState(() => labelsOf(task));
  const [label, setLabel] = useState('');
  const [estimate, setEstimate] = useState(task.estimate_minutes == null ? '' : String(task.estimate_minutes));
  const [subtasks, setSubtasks] = useState(() => subtasksOf(task));
  const [subtaskTitle, setSubtaskTitle] = useState('');
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [destination, setDestination] = useState('');
  const [clearAssignee, setClearAssignee] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const project = projects.find(item => item.id === current.project_id && item.workspace_id === current.workspace_id);
  const projectArchived = Boolean(project?.archived_at);
  const archived = Boolean(current.archived_at);
  const disabled = pending || busy;
  const mayEdit = !readOnly && canEdit && !archived && !projectArchived;
  const metadataDisabled = disabled || !mayEdit || !api;
  const destinations = projects.filter(item => item.workspace_id === current.workspace_id && !item.archived_at && canCreateInProject(item.id));
  const mayDuplicate = !readOnly && !archived && !projectArchived && destinations.length > 0;
  const dirty = JSON.stringify({ labels, estimate_minutes: estimate === '' ? null : Number(estimate), subtasks }) !== JSON.stringify(detailsOf(baseline));
  const changed = current.version !== baseline.version;
  const completed = subtasks.filter(item => item.done).length;

  function accept(saved: Task, metadata = false) {
    if (!active.current) return;
    setSavedTask(saved);
    if (metadata) {
      setBaseline(saved);
      setLabels(labelsOf(saved));
      setEstimate(saved.estimate_minutes == null ? '' : String(saved.estimate_minutes));
      setSubtasks(subtasksOf(saved));
    }
    onTaskSaved?.(saved);
  }
  async function run(operation: () => Promise<void>) {
    if (disabled || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await operation();
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  }
  function reloadDetails() {
    setBaseline(current);
    setLabels(labelsOf(current));
    setEstimate(current.estimate_minutes == null ? '' : String(current.estimate_minutes));
    setSubtasks(subtasksOf(current));
    setLabel('');
    setSubtaskTitle('');
    setError(null);
  }
  function addLabel() {
    if (metadataDisabled) return;
    const value = label.trim();
    if (!value || value.length > 40 || labels.length >= 10) return;
    if (labels.some(item => item.toLocaleLowerCase('es') === value.toLocaleLowerCase('es'))) return;
    setLabels(previous => [...previous, value]);
    setLabel('');
  }
  function addSubtask() {
    if (metadataDisabled) return;
    const title = subtaskTitle.trim();
    if (!title || title.length > 240 || subtasks.length >= 100) return;
    setSubtasks(previous => [...previous, { id: crypto.randomUUID(), title, done: false }]);
    setSubtaskTitle('');
  }
  function patchSubtask(id: string, patch: Partial<TaskSubtask>) {
    setSubtasks(previous => previous.map(item => (item.id === id ? { ...item, ...patch } : item)));
  }
  function saveDetails(event: FormEvent) {
    event.preventDefault();
    if (metadataDisabled || !api) return;
    if (estimate !== '' && (!Number.isInteger(Number(estimate)) || Number(estimate) < 0 || Number(estimate) > 100000)) {
      setError('La estimación debe ser un número entero entre 0 y 100.000 minutos.');
      return;
    }
    if (subtasks.some(item => !item.title.trim() || item.title.trim().length > 240)) {
      setError('Cada subtarea necesita un título de entre 1 y 240 caracteres.');
      return;
    }
    void run(async () => {
      const saved = await api.updateTaskDetails(baseline, {
        labels,
        estimate_minutes: estimate === '' ? null : Number(estimate),
        subtasks: subtasks.map(item => ({ ...item, title: item.title.trim() })),
      });
      accept(saved, true);
      if (active.current) setNotice('Detalle guardado.');
    });
  }
  function openAction(type: Action['type']) {
    if (dirty && (type === 'move' || type === 'archive' || type === 'restore')) return;
    setError(null);
    setNotice('');
    setConfirmation('');
    setClearAssignee(false);
    setDestination(destinations.find(item => type === 'duplicate' || item.id !== current.project_id)?.id ?? '');
    setAction({ type, task: current, requestId: crypto.randomUUID() });
  }
  function confirmAction(event: FormEvent) {
    event.preventDefault();
    if (!action || disabled) return;
    if (action.type === 'delete') {
      if (!canDelete || readOnly || projectArchived || confirmation !== 'ELIMINAR') return;
      void run(async () => {
        await onDelete(action.task);
        if (active.current) onClose();
      });
      return;
    }
    if (!api || readOnly || projectArchived) return;
    if (dirty && (action.type === 'move' || action.type === 'archive' || action.type === 'restore')) return;
    if (action.type === 'duplicate' && (!mayDuplicate || !destinations.some(item => item.id === destination))) return;
    if (action.type === 'move' && (!mayEdit || !destinations.some(item => item.id === destination))) return;
    if ((action.type === 'archive' || action.type === 'restore') && !canEdit) return;
    if (action.type === 'move' && (destination === action.task.project_id || (clearAssignee && !canAssign))) return;
    void run(async () => {
      if (action.type === 'duplicate') {
        const saved = await api.duplicateTask(action.task, destination, action.requestId);
        if (!active.current) return;
        onTaskSaved?.(saved);
        setAction(null);
        setNotice(`Se creó «${saved.title}» en ${destinations.find(item => item.id === saved.project_id)?.name ?? 'el proyecto seleccionado'}.`);
      } else if (action.type === 'move') {
        const saved = await api.moveTask(action.task, destination, action.requestId, clearAssignee);
        if (!active.current) return;
        accept(saved, true);
        setAction(null);
        onTaskMoved?.(saved);
        setNotice('Tarea trasladada.');
      } else {
        const saved = await api.archiveTask(action.task, action.type === 'archive', action.requestId);
        if (!active.current) return;
        accept(saved, true);
        setAction(null);
        setNotice(action.type === 'archive' ? 'Tarea archivada.' : 'Tarea restaurada.');
      }
    });
  }

  if (editing)
    return (
      <TaskForm
        task={current}
        projects={projects}
        pending={disabled}
        readOnly={!mayEdit}
        canDelete={false}
        canAssign={canAssign && mayEdit}
        collaboration={collaboration}
        calendar={calendar}
        onCreate={async () => {
          throw Error('Esta ventana edita una tarea existente.');
        }}
        onUpdate={async (before, patch) => {
          const saved = await onUpdate(before, patch);
          accept(saved);
          // Core edits preserve the independently saved detail fields.
          if (before.version === baseline.version) setBaseline(saved);
          return saved;
        }}
        onDelete={onDelete}
        onClose={() => setEditing(false)}
      />
    );

  if (action) {
    const title = { duplicate: 'Duplicar tarea', move: 'Mover tarea', archive: 'Archivar tarea', restore: 'Restaurar tarea', delete: 'Eliminar tarea' }[
      action.type
    ];
    const isDestinationAction = action.type === 'duplicate' || action.type === 'move';
    const allowed =
      action.type === 'delete'
        ? canDelete && !readOnly && !projectArchived
        : action.type === 'duplicate'
          ? mayDuplicate
          : action.type === 'move'
            ? mayEdit
            : !readOnly && canEdit && !projectArchived;
    return (
      <Dialog title={title} onClose={() => setAction(null)} busy={disabled}>
        <form className="pw-form" onSubmit={confirmAction}>
          <div className="pw-form-body">
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <p>
              <strong>{action.task.title}</strong>
            </p>
            {dirty && <p className="pw-info">Los cambios de detalle sin guardar no forman parte de esta acción. Tu borrador se conserva al volver.</p>}
            {action.type === 'duplicate' && (
              <p className="muted">
                Crea una tarea nueva pendiente, con las etiquetas y estimación guardadas. Las subtareas vuelven a estar pendientes; no se copian responsable,
                fechas ni conexiones de la tarea original.
              </p>
            )}
            {action.type === 'move' && (
              <p className="muted">
                La tarea conservará su identidad, contenido y conexiones. El proyecto de destino debe estar en este espacio y permitirte crear tareas.
              </p>
            )}
            {isDestinationAction && (
              <label className="pw-field">
                Proyecto de destino
                <select value={destination} onChange={event => setDestination(event.target.value)} disabled={disabled || readOnly} required data-initial-focus>
                  <option value="">Selecciona un proyecto</option>
                  {destinations
                    .filter(item => action.type === 'duplicate' || item.id !== action.task.project_id)
                    .map(item => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {action.type === 'move' && action.task.assignee_member_id && (
              <div className="td-transfer-assignee">
                <p>El responsable se conservará si sigue siendo elegible en el destino. Si no tiene acceso, puedes retirarlo expresamente al mover.</p>
                <label>
                  <input
                    type="checkbox"
                    checked={clearAssignee}
                    onChange={event => setClearAssignee(event.target.checked)}
                    disabled={disabled || !canAssign || readOnly}
                  />{' '}
                  Mover sin responsable
                </label>
                {!canAssign && <p className="faint">Para retirar al responsable necesitas permiso de asignación en el proyecto de origen.</p>}
              </div>
            )}
            {action.type === 'archive' && (
              <p>Se ocultará de las vistas activas y del calendario de TR8. Podrás encontrarla en tareas archivadas y restaurarla. Sus datos se conservarán.</p>
            )}
            {action.type === 'restore' && <p>La tarea volverá a las vistas activas con el mismo contenido.</p>}
            {action.type === 'delete' && (
              <>
                <p>Esta acción elimina definitivamente la tarea, sus subtareas, comentarios y reacciones. Los demás trabajos no se modificarán.</p>
                <label className="pw-field">
                  Escribe ELIMINAR para confirmar
                  <input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" disabled={disabled} />
                </label>
              </>
            )}
          </div>
          <div className="pw-form-footer">
            <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => setAction(null)}>
              Cancelar
            </button>
            <button
              type="submit"
              className={`btn ${action.type === 'delete' ? 'btn-danger' : 'btn-primary'}`}
              disabled={disabled || !allowed || (action.type === 'delete' && confirmation !== 'ELIMINAR') || (isDestinationAction && !destination)}
            >
              {busy ? 'Guardando…' : title}
            </button>
          </div>
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog title="Detalle de tarea" className="td-drawer" onClose={onClose} busy={disabled}>
      <div className="td-body">
        <div className="td-project-line">
          <ProjectIcon color={project?.color ?? '#6B7280'} icon={project?.icon} />
          <span>{project?.name ?? 'Proyecto'}</span>
          <span className="td-key">
            {project?.code ?? 'TAREA'}-{current.task_number}
          </span>
        </div>
        <div className="td-title-row">
          <TaskStatusIcon status={current.status} size={22} />
          <h3>{current.title}</h3>
        </div>
        {archived && (
          <p className="pw-info">
            <Archive size={15} aria-hidden="true" /> Esta tarea está archivada. Restáurala para editarla.
          </p>
        )}
        {projectArchived && <p className="pw-info">El proyecto está archivado. Restáuralo para modificar sus tareas.</p>}
        {(readOnly || !canEdit) && <p className="pw-info">Tienes acceso de lectura a esta tarea.</p>}
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {notice && (
          <p className="td-notice" role="status">
            <CheckCheck size={15} aria-hidden="true" />
            {notice}
          </p>
        )}
        <div className="td-actions" aria-label="Acciones de tarea">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={disabled || !mayEdit}
            onClick={() => {
              setError(null);
              setEditing(true);
            }}
          >
            <Pencil size={14} aria-hidden="true" />
            Editar tarea
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={disabled || !mayEdit}
            onClick={() =>
              void run(async () => {
                const saved = await onUpdate(current, { status: current.status === 'done' ? 'todo' : 'done' });
                accept(saved);
                if (current.version === baseline.version) setBaseline(saved);
                if (active.current) setNotice(saved.status === 'done' ? 'Tarea completada.' : 'Tarea reabierta.');
              })
            }
          >
            <Check size={14} aria-hidden="true" />
            {current.status === 'done' ? 'Reabrir tarea' : 'Completar tarea'}
          </button>
          {api && (
            <>
              <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || !mayDuplicate} onClick={() => openAction('duplicate')}>
                <Copy size={14} aria-hidden="true" />
                Duplicar
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={disabled || !mayEdit || dirty || !destinations.some(item => item.id !== current.project_id)}
                onClick={() => openAction('move')}
              >
                <ArrowRightLeft size={14} aria-hidden="true" />
                Mover
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={disabled || readOnly || !canEdit || projectArchived || dirty}
                onClick={() => openAction(archived ? 'restore' : 'archive')}
              >
                {archived ? <RotateCcw size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
                {archived ? 'Restaurar' : 'Archivar'}
              </button>
            </>
          )}
          {canDelete && (
            <button
              type="button"
              className="btn btn-ghost btn-sm td-danger"
              disabled={disabled || readOnly || projectArchived}
              onClick={() => openAction('delete')}
            >
              <Trash2 size={14} aria-hidden="true" />
              Eliminar
            </button>
          )}
        </div>
        {dirty && <p className="faint">Guarda o descarta los cambios de detalle antes de mover o archivar la tarea.</p>}
        <dl className="td-properties">
          <dt>
            <TaskStatusIcon status={current.status} />
            Estado
          </dt>
          <dd>{STATUSES.find(item => item.id === current.status)?.name}</dd>
          <dt>
            <PriorityIcon priority={current.priority} />
            Prioridad
          </dt>
          <dd>{PRIORITIES.find(item => item.id === current.priority)?.name}</dd>
          <dt>
            <UserRound size={14} aria-hidden="true" />
            Responsable
          </dt>
          <dd>{current.assignee_member_id ? assigneeName || 'Responsable no disponible' : 'Sin responsable'}</dd>
          <dt>
            <CalendarDays size={14} aria-hidden="true" />
            Inicio
          </dt>
          <dd>{formatDate(current.start_date)}</dd>
          <dt>
            <CalendarDays size={14} aria-hidden="true" />
            Vencimiento
          </dt>
          <dd>{formatDate(current.due_date)}</dd>
        </dl>
        <section className="td-section" aria-label="Descripción de la tarea">
          <h4>Descripción</h4>
          <p className="td-description">{current.description || 'Añade contexto desde Editar tarea.'}</p>
        </section>
        {planningContent}
        {recurrence && (
          <RecurrencePanel
            task={current}
            api={recurrence}
            calendar={calendar}
            disabled={disabled || projectArchived}
            canEdit={mayEdit}
            canCreate={recurrenceCanCreate}
          />
        )}
        <form onSubmit={saveDetails} className="td-details-form">
          {changed && (
            <div className="pw-info">
              <p>La tarea cambió desde que abriste este detalle. Tu borrador sigue aquí; guardar comprobará su versión.</p>
              <button className="btn btn-secondary btn-sm" type="button" disabled={disabled} onClick={reloadDetails}>
                Cargar detalle actual
              </button>
            </div>
          )}
          <section className="td-section" aria-label="Etiquetas y estimación">
            <div className="td-section-title">
              <h4>
                <Tag size={15} aria-hidden="true" />
                Etiquetas
              </h4>
              <span className="faint">{labels.length}/10</span>
            </div>
            <div className="td-labels">
              {labels.map(name => (
                <span className="td-label" key={name} style={{ '--label-color': labelColor(name) } as CSSProperties}>
                  {name}
                  <button
                    type="button"
                    aria-label={`Quitar etiqueta ${name}`}
                    disabled={metadataDisabled}
                    onClick={() => setLabels(previous => previous.filter(item => item !== name))}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              ))}
              {!labels.length && <span className="faint">Sin etiquetas</span>}
            </div>
            <div className="td-add-line">
              <div className="td-input-icon">
                <Tag size={14} aria-hidden="true" />
                <input
                  aria-label="Nueva etiqueta"
                  placeholder="Añadir etiqueta"
                  maxLength={40}
                  value={label}
                  disabled={metadataDisabled || labels.length >= 10}
                  onChange={event => setLabel(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addLabel();
                    }
                  }}
                />
              </div>
              <button
                type="button"
                className="ibtn"
                aria-label="Añadir etiqueta"
                disabled={metadataDisabled || !label.trim() || labels.length >= 10}
                onClick={addLabel}
              >
                <Plus size={15} aria-hidden="true" />
              </button>
            </div>
            <label className="pw-field td-estimate">
              Estimación de trabajo
              <div className="td-input-icon td-estimate-control">
                <Timer size={14} aria-hidden="true" />
                <input
                  aria-label="Estimación en minutos"
                  type="number"
                  min={0}
                  max={100000}
                  step={1}
                  placeholder="Sin estimación"
                  value={estimate}
                  disabled={metadataDisabled}
                  onChange={event => setEstimate(event.target.value)}
                />
                <span className="td-estimate-unit" aria-hidden="true">
                  min
                </span>
              </div>
            </label>
          </section>
          <section className="td-section" aria-label="Subtareas">
            <div className="td-section-title">
              <h4>
                <ListChecks size={16} aria-hidden="true" />
                Subtareas
              </h4>
              <span className="td-subtask-count">
                {completed}/{subtasks.length}
              </span>
            </div>
            {!!subtasks.length && <progress className="td-progress" max={subtasks.length} value={completed} aria-label="Progreso de subtareas" />}
            <div className="td-subtasks">
              {subtasks.map((item, index) => (
                <div className={`td-subtask${item.done ? ' is-done' : ''}`} key={item.id}>
                  <input
                    type="checkbox"
                    checked={item.done}
                    disabled={metadataDisabled}
                    aria-label={`${item.done ? 'Reabrir' : 'Completar'} subtarea ${item.title || index + 1}`}
                    onChange={event => patchSubtask(item.id, { done: event.target.checked })}
                  />
                  <input
                    className="td-subtask-title"
                    aria-label={`Título de subtarea ${index + 1}`}
                    value={item.title}
                    maxLength={240}
                    disabled={metadataDisabled}
                    onChange={event => patchSubtask(item.id, { title: event.target.value })}
                  />
                  <button
                    type="button"
                    className="ibtn ibtn-xs"
                    aria-label={`Eliminar subtarea ${item.title || index + 1}`}
                    disabled={metadataDisabled}
                    onClick={() => setSubtasks(previous => previous.filter(value => value.id !== item.id))}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
            <div className="td-add-line">
              <div className="td-input-icon">
                <Plus size={15} aria-hidden="true" />
                <input
                  aria-label="Nueva subtarea"
                  placeholder="Añadir subtarea"
                  value={subtaskTitle}
                  maxLength={240}
                  disabled={metadataDisabled || subtasks.length >= 100}
                  onChange={event => setSubtaskTitle(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addSubtask();
                    }
                  }}
                />
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={metadataDisabled || !subtaskTitle.trim() || subtasks.length >= 100}
                onClick={addSubtask}
              >
                Añadir
              </button>
            </div>
          </section>
          <div className="td-save-bar">
            <span className="faint">{dirty ? 'Cambios de detalle sin guardar' : 'Detalle guardado'}</span>
            {dirty && (
              <button className="btn btn-secondary" type="button" disabled={disabled} onClick={reloadDetails}>
                Descartar cambios de detalle
              </button>
            )}
            <button className="btn btn-primary" type="submit" disabled={metadataDisabled || !dirty}>
              <Save size={14} aria-hidden="true" />
              {busy ? 'Guardando…' : 'Guardar detalle'}
            </button>
          </div>
        </form>
        {communicationContent}
      </div>
    </Dialog>
  );
}
