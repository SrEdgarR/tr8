import { useId, useRef, useState, type FormEvent } from 'react';
import { Copy, LockKeyhole, Type } from 'lucide-react';
import type { Project } from '../types';
import { Dialog, ErrorNotice, ProjectIcon } from './ui';
import { errorMessage } from './helpers';
import './project-planning.css';

export interface ProjectDuplicateDialogProps {
  project: Project;
  pending: boolean;
  includeTasksAllowed?: boolean;
  taskCount?: number;
  onClose: () => void;
  onSaved: (project: Project) => void;
  onDuplicate: (name: string, includeTasks: boolean, requestId: string) => Promise<Project>;
}

export default function ProjectDuplicateDialog({
  project,
  pending,
  includeTasksAllowed = true,
  taskCount,
  onClose,
  onSaved,
  onDuplicate,
}: ProjectDuplicateDialogProps) {
  const prefix = useId();
  const tasksAvailable = includeTasksAllowed && (taskCount === undefined || taskCount <= 50);
  const [name, setName] = useState(`${project.name.slice(0, 112)} (copia)`);
  const [includeTasks, setIncludeTasks] = useState(tasksAvailable);
  const [requestId] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const busy = pending || submitting;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || lock.current) return;
    if (!name.trim() || name.trim().length > 120) {
      setError('Escribe un nombre de hasta 120 caracteres para la copia.');
      return;
    }
    lock.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const saved = await onDuplicate(name.trim(), tasksAvailable && includeTasks, requestId);
      onSaved(saved);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }
  return (
    <Dialog title="Duplicar proyecto" busy={busy} onClose={onClose}>
      <form className="pw-form" onSubmit={event => void submit(event)}>
        <div className="pw-form-body">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <div className="pw-project-copy-intro">
            <ProjectIcon icon={project.icon} color={project.color} />
            <p>
              Crear una copia de <strong>{project.name}</strong> en este espacio.
            </p>
          </div>
          <label className="pw-field" htmlFor={`${prefix}-name`}>
            Nombre de la copia
            <span className="pw-planning-control">
              <Type size={15} aria-hidden="true" />
              <input
                id={`${prefix}-name`}
                data-initial-focus
                required
                maxLength={120}
                value={name}
                onChange={event => setName(event.target.value)}
                disabled={busy}
              />
            </span>
          </label>
          <label className="pw-project-copy-tasks">
            <input
              type="checkbox"
              checked={tasksAvailable && includeTasks}
              onChange={event => setIncludeTasks(event.target.checked)}
              disabled={busy || !tasksAvailable}
            />
            <span>
              <strong>Incluir tareas{taskCount !== undefined && includeTasksAllowed ? ` (${taskCount})` : ''}</strong>
              <small>
                Hasta 50 tareas. Se conservan sus descripciones, etiquetas y estimaciones; empiezan sin fechas ni responsables y con subtareas pendientes.
              </small>
            </span>
          </label>
          {!tasksAvailable && (
            <p className="pw-planning-help">
              {includeTasksAllowed
                ? 'Este proyecto supera el límite de 50 tareas por copia. Puedes copiar su configuración sin tareas.'
                : 'Tu acceso actual permite copiar la configuración del proyecto, pero no sus tareas.'}
            </p>
          )}
          <p className="pw-project-copy-privacy">
            <LockKeyhole size={14} aria-hidden="true" />
            La copia será privada. No se copian accesos, actividad ni conexiones con Google; el proyecto original se conserva.
          </p>
        </div>
        <div className="pw-form-footer">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            <Copy size={14} aria-hidden="true" />
            {submitting ? 'Duplicando…' : 'Duplicar proyecto'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
