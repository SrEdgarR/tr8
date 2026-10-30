import { useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { AlignLeft, CalendarDays, CalendarRange, ChevronDown, Info, TextCursorInput, Trash2, UserRound } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { PRIORITIES, STATUSES } from '../constants';
import type { CalendarApi, CollaborationApi, Priority, Project, Task, TaskInput, TaskStatus, WorkspaceProps } from '../types';
import CalendarSchedule from './CalendarSchedule';
import { Dialog, ErrorNotice } from './ui';
import { errorMessage } from './helpers';
import { PriorityIcon, ProjectGlyph, TaskStatusIcon } from './project-identity';
import './task-form.css';
import './mobile-form-communication.css';

interface Props {
  task?: Task;
  projectId?: string;
  initialStatus?: TaskStatus;
  projects: Project[];
  pending: boolean;
  readOnly?: boolean;
  canDelete?: boolean;
  canAssign?: boolean;
  collaboration?: CollaborationApi;
  calendar?: CalendarApi;
  onCreate: WorkspaceProps['onCreateTask'];
  onUpdate: WorkspaceProps['onUpdateTask'];
  onDelete: WorkspaceProps['onDeleteTask'];
  onClose: () => void;
}

function TaskAssignment({
  task,
  api,
  canAssign,
  disabled,
  onSaved,
}: {
  task: Task;
  api: CollaborationApi;
  canAssign: boolean;
  disabled: boolean;
  onSaved: (before: Task, saved: Task) => void;
}) {
  const members = useQuery({
    queryKey: [...api.scopeKey, 'assignable', task.project_id],
    queryFn: () => api.assignableMembers(task.project_id),
    refetchInterval: 30000,
    retry: false,
  });
  const [selected, setSelected] = useState(task.assignee_member_id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const available = members.error ? [] : (members.data ?? []);
  async function save() {
    if (lock.current || !canAssign || disabled || members.error) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const saved = await api.assignTask(task, selected || null);
      onSaved(task, saved);
      setNotice('Responsable guardado.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="pw-assignment" aria-label="Responsable de la tarea">
      <label className="pw-field">
        Responsable principal
        <span className="task-form-control">
          <UserRound size={15} aria-hidden="true" />
          <select
            value={selected}
            disabled={disabled || busy || !canAssign || members.isPending || !!members.error}
            onChange={event => setSelected(event.target.value)}
          >
            <option value="">Sin responsable</option>
            {!!selected && !available.some(member => member.id === selected) && <option value={selected}>Responsable no disponible</option>}
            {available.map(member => (
              <option key={member.id} value={member.id}>
                {member.display_name}
                {member.is_owner ? ' (propietario)' : ''}
              </option>
            ))}
          </select>
          <ChevronDown size={13} className="task-form-chevron" aria-hidden="true" />
        </span>
      </label>
      {members.error && <ErrorNotice>{errorMessage(members.error)}</ErrorNotice>}
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {notice && <p role="status">{notice}</p>}
      {canAssign && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={disabled || busy || members.isPending || !!members.error || selected === (task.assignee_member_id ?? '')}
          onClick={() => void save()}
        >
          {busy ? 'Guardando…' : 'Guardar responsable'}
        </button>
      )}
      <p className="faint">Una persona opcional con acceso vigente al proyecto. La asignación se guarda por separado del contenido.</p>
    </section>
  );
}

export default function TaskForm({
  task,
  projectId,
  initialStatus,
  projects,
  pending,
  readOnly = false,
  canDelete = !readOnly,
  canAssign = !readOnly,
  collaboration,
  calendar,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
}: Props) {
  const prefix = useId();
  const [selectedProject, setSelectedProject] = useState(task?.project_id ?? projectId ?? projects.find(project => !project.archived_at)?.id ?? '');
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? initialStatus ?? 'todo');
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'none');
  const [startDate, setStartDate] = useState(task?.start_date ?? '');
  const [dueDate, setDueDate] = useState(task?.due_date ?? '');
  const [requestId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [originalTask, setOriginalTask] = useState(task);
  const lock = useRef(false);
  const busy = pending || submitting;
  const archived = Boolean(projects.find(project => project.id === selectedProject)?.archived_at);
  const disabled = busy || archived || readOnly;
  const project = projects.find(project => project.id === selectedProject);
  const afterCreateOptions = [collaboration && canAssign ? 'el responsable' : null, calendar ? 'un bloque horario' : null, 'la repetición'].filter(
    (option): option is string => Boolean(option),
  );

  function independentSaved(before: Task, saved: Task, kind: 'assignment' | 'schedule') {
    const fields = [
      'id',
      'workspace_id',
      'owner_id',
      'project_id',
      'task_number',
      'title',
      'description',
      'status',
      'priority',
      'start_date',
      'due_date',
      'position',
      'created_at',
    ] as const;
    const scheduleFields = ['scheduled_start_at', 'scheduled_end_at', 'scheduled_time_zone'] as const;
    const sameContent = (left: Task, right: Task) =>
      fields.every(field => left[field] === right[field]) &&
      (kind === 'schedule' ? left.assignee_member_id === right.assignee_member_id : scheduleFields.every(field => left[field] === right[field]));
    if (saved.version !== before.version + 1 || !sameContent(before, saved)) return;
    setOriginalTask(previous => (previous && previous.version === before.version && sameContent(previous, before) ? saved : previous));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || lock.current) return;
    if (!title.trim()) {
      setError('Escribe un título para la tarea.');
      return;
    }
    if (!selectedProject) {
      setError('Selecciona un proyecto para la tarea.');
      return;
    }
    if (startDate && dueDate && dueDate < startDate) {
      setError('El vencimiento debe ser igual o posterior al inicio.');
      return;
    }
    lock.current = true;
    setSubmitting(true);
    setError(null);
    const input: TaskInput = {
      project_id: selectedProject,
      title: title.trim(),
      description: description.trim(),
      status,
      priority,
      start_date: startDate || null,
      due_date: dueDate || null,
    };
    try {
      if (task) {
        await onUpdate(originalTask ?? task, {
          title: input.title,
          description: input.description,
          status: input.status,
          priority: input.priority,
          start_date: input.start_date,
          due_date: input.due_date,
        });
      } else {
        await onCreate(input, requestId);
      }
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }

  async function remove() {
    if (!task || busy || !canDelete || lock.current) return;
    lock.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onDelete(originalTask ?? task);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog title={task ? 'Detalle de tarea' : 'Nueva tarea'} busy={busy} onClose={onClose} wide>
      <form
        onSubmit={event => {
          void submit(event);
        }}
        className="pw-form task-form"
      >
        <div className="pw-form-body">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {archived && <div className="pw-info">Este proyecto está archivado. Restáuralo para editar sus tareas.</div>}
          {readOnly && <div className="pw-info">Tienes acceso de lectura a las tareas de este espacio.</div>}
          {task && originalTask && task.version !== originalTask.version && (
            <div className="pw-info">
              <p>
                La tarea cambió desde que abriste el formulario. El contenido actual es: «{task.title}» ({STATUSES.find(item => item.id === task.status)?.name}
                ). Tu borrador sigue aquí.
              </p>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setOriginalTask(task)}>
                Revisé los cambios; usar la versión actual
              </button>
            </div>
          )}
          {task && (
            <span className="eyebrow">
              {projects.find(project => project.id === task.project_id)?.code ?? 'TAREA'}-{task.task_number}
            </span>
          )}
          <div className="task-form-content">
            <label className="pw-field" htmlFor={`${prefix}-title`}>
              Título
              <span className="task-form-control task-form-title-control">
                <TextCursorInput size={16} aria-hidden="true" />
                <input
                  id={`${prefix}-title`}
                  data-initial-focus
                  required
                  maxLength={240}
                  value={title}
                  onChange={event => setTitle(event.target.value)}
                  disabled={disabled}
                  placeholder="¿Qué hay que hacer?"
                />
              </span>
            </label>
            <label className="pw-field" htmlFor={`${prefix}-description`}>
              <span className="task-form-label">
                Descripción <span className="faint">Opcional</span>
              </span>
              <span className="task-form-control task-form-description-control">
                <AlignLeft size={16} aria-hidden="true" />
                <textarea
                  id={`${prefix}-description`}
                  rows={3}
                  maxLength={10000}
                  value={description}
                  onChange={event => setDescription(event.target.value)}
                  disabled={disabled}
                  placeholder="Añade contexto o los pasos de la tarea"
                />
              </span>
            </label>
          </div>
          <div className="task-form-properties">
            <label className="pw-field" htmlFor={`${prefix}-project`}>
              Proyecto
              <span
                className="task-form-control task-form-project-control"
                style={{ '--task-form-project-color': project?.color ?? 'var(--accent)' } as CSSProperties}
              >
                <ProjectGlyph icon={project?.icon} size={16} />
                <select
                  id={`${prefix}-project`}
                  required
                  value={selectedProject}
                  onChange={event => setSelectedProject(event.target.value)}
                  disabled={disabled || Boolean(task)}
                >
                  <option value="" disabled>
                    Selecciona un proyecto
                  </option>
                  {projects
                    .filter(project => !project.archived_at || project.id === selectedProject)
                    .map(project => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                        {project.archived_at ? ' (archivado)' : ''}
                      </option>
                    ))}
                </select>
                <ChevronDown size={13} className="task-form-chevron" aria-hidden="true" />
              </span>
            </label>
            <div className="pw-field-grid">
              <label className="pw-field" htmlFor={`${prefix}-status`}>
                Estado
                <span className="task-form-control">
                  <TaskStatusIcon status={status} size={15} />
                  <select id={`${prefix}-status`} value={status} onChange={event => setStatus(event.target.value as TaskStatus)} disabled={disabled}>
                    {STATUSES.map(item => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={13} className="task-form-chevron" aria-hidden="true" />
                </span>
              </label>
              <label className="pw-field" htmlFor={`${prefix}-priority`}>
                Prioridad
                <span className={`task-form-control task-form-priority is-${priority}`}>
                  <PriorityIcon priority={priority} size={15} />
                  <select id={`${prefix}-priority`} value={priority} onChange={event => setPriority(event.target.value as Priority)} disabled={disabled}>
                    {PRIORITIES.map(item => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={13} className="task-form-chevron" aria-hidden="true" />
                </span>
              </label>
              <label className="pw-field" htmlFor={`${prefix}-start`}>
                Fecha de inicio
                <span className="task-form-control">
                  <CalendarRange size={15} aria-hidden="true" />
                  <input
                    id={`${prefix}-start`}
                    type="date"
                    value={startDate}
                    max={dueDate || undefined}
                    onChange={event => setStartDate(event.target.value)}
                    disabled={disabled}
                  />
                </span>
              </label>
              <label className="pw-field" htmlFor={`${prefix}-due`}>
                Vencimiento
                <span className="task-form-control">
                  <CalendarDays size={15} aria-hidden="true" />
                  <input
                    id={`${prefix}-due`}
                    type="date"
                    value={dueDate}
                    min={startDate || undefined}
                    onChange={event => setDueDate(event.target.value)}
                    disabled={disabled}
                  />
                </span>
              </label>
            </div>
          </div>
          {task && collaboration && (
            <TaskAssignment
              key={`${task.id}:${task.version}`}
              task={task}
              api={collaboration}
              canAssign={canAssign && !archived}
              disabled={busy || archived}
              onSaved={(before, saved) => independentSaved(before, saved, 'assignment')}
            />
          )}
          {task && calendar && (
            <CalendarSchedule
              key={task.id}
              task={task}
              api={calendar}
              disabled={disabled}
              onSaved={(before, saved) => independentSaved(before, saved, 'schedule')}
            />
          )}
          {!task && (
            <p className="task-form-help">
              <Info size={15} aria-hidden="true" />
              <span>
                Después de crear la tarea podrás configurar {new Intl.ListFormat('es', { type: 'conjunction' }).format(afterCreateOptions)} desde el detalle.
              </span>
            </p>
          )}
          {confirmDelete && (
            <div className="pw-confirm" role="alert">
              <strong>¿Eliminar esta tarea?</strong>
              <p>Se eliminarán la tarea, sus subtareas, comentarios y reacciones. Esta acción no se puede deshacer.</p>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy || !canDelete}
                  onClick={() => {
                    void remove();
                  }}
                >
                  {submitting ? 'Eliminando…' : 'Sí, eliminar tarea'}
                </button>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  Conservar tarea
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="pw-form-footer">
          {task && canDelete && (
            <button type="button" className="btn btn-danger-ghost pw-delete" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 size={14} aria-hidden="true" />
              Eliminar
            </button>
          )}
          <button className="btn btn-secondary" type="button" onClick={onClose} disabled={busy}>
            {archived ? 'Cerrar' : 'Cancelar'}
          </button>
          {!archived && (
            <button className="btn btn-primary" type="submit" disabled={disabled || confirmDelete || !selectedProject}>
              {submitting ? 'Guardando…' : task ? 'Guardar cambios' : 'Crear tarea'}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
