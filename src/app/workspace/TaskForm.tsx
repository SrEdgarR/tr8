import { useId, useRef, useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { PRIORITIES, STATUSES } from '../constants';
import type { Priority, Project, Task, TaskInput, TaskStatus, WorkspaceProps } from '../types';
import { Dialog, ErrorNotice } from './ui';
import { errorMessage } from './helpers';

interface Props {
  task?: Task;
  projectId?: string;
  initialStatus?: TaskStatus;
  projects: Project[];
  pending: boolean;
  onCreate: WorkspaceProps['onCreateTask'];
  onUpdate: WorkspaceProps['onUpdateTask'];
  onDelete: WorkspaceProps['onDeleteTask'];
  onClose: () => void;
}

export default function TaskForm({ task, projectId, initialStatus, projects, pending, onCreate, onUpdate, onDelete, onClose }: Props) {
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
  const lock = useRef(false);
  const busy = pending || submitting;
  const archived = Boolean(projects.find(project => project.id === selectedProject)?.archived_at);
  const disabled = busy || archived;

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
        await onUpdate(task, {
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
    if (!task || disabled || lock.current) return;
    lock.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onDelete(task);
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
        className="pw-form"
      >
        <div className="pw-form-body">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {archived && <div className="pw-info">Este proyecto está archivado. Restáuralo para editar sus tareas.</div>}
          {task && (
            <span className="eyebrow">
              {projects.find(project => project.id === task.project_id)?.code ?? 'TAREA'}-{task.task_number}
            </span>
          )}
          <label className="pw-field" htmlFor={`${prefix}-title`}>
            Título
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
          </label>
          <label className="pw-field" htmlFor={`${prefix}-description`}>
            Descripción <span className="faint">Opcional</span>
            <textarea
              id={`${prefix}-description`}
              rows={5}
              maxLength={10000}
              value={description}
              onChange={event => setDescription(event.target.value)}
              disabled={disabled}
              placeholder="Añade contexto o los pasos de la tarea"
            />
          </label>
          <label className="pw-field" htmlFor={`${prefix}-project`}>
            Proyecto
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
          </label>
          <div className="pw-field-grid">
            <label className="pw-field" htmlFor={`${prefix}-status`}>
              Estado
              <select id={`${prefix}-status`} value={status} onChange={event => setStatus(event.target.value as TaskStatus)} disabled={disabled}>
                {STATUSES.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="pw-field" htmlFor={`${prefix}-priority`}>
              Prioridad
              <select id={`${prefix}-priority`} value={priority} onChange={event => setPriority(event.target.value as Priority)} disabled={disabled}>
                {PRIORITIES.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="pw-field" htmlFor={`${prefix}-start`}>
              Fecha de inicio
              <input
                id={`${prefix}-start`}
                type="date"
                value={startDate}
                max={dueDate || undefined}
                onChange={event => setStartDate(event.target.value)}
                disabled={disabled}
              />
            </label>
            <label className="pw-field" htmlFor={`${prefix}-due`}>
              Vencimiento
              <input
                id={`${prefix}-due`}
                type="date"
                value={dueDate}
                min={startDate || undefined}
                onChange={event => setDueDate(event.target.value)}
                disabled={disabled}
              />
            </label>
          </div>
          {confirmDelete && (
            <div className="pw-confirm" role="alert">
              <strong>¿Eliminar esta tarea?</strong>
              <p>Se eliminará de tu cuenta. Esta acción no se puede deshacer.</p>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={disabled}
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
          {task && !archived && (
            <button type="button" className="btn btn-danger-ghost pw-delete" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 size={14} aria-hidden="true" />
              Eliminar
            </button>
          )}
          <button className="btn btn-secondary" type="button" onClick={onClose} disabled={busy}>
            {archived ? 'Cerrar' : 'Cancelar'}
          </button>
          {!archived && (
            <button className="btn btn-primary" type="submit" disabled={busy || confirmDelete || !selectedProject}>
              {submitting ? 'Guardando…' : task ? 'Guardar cambios' : 'Crear tarea'}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
