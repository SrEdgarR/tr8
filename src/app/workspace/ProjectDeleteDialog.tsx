import { useId, useRef, useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import type { Project, WorkspaceProps } from '../types';
import { Dialog, ErrorNotice } from './ui';
import { errorMessage } from './helpers';

interface Props {
  project: Project;
  taskCount: number;
  pending: boolean;
  onDelete: WorkspaceProps['onDeleteProject'];
  onDeleted: () => void;
  onClose: () => void;
}

export default function ProjectDeleteDialog({ project, taskCount, pending, onDelete, onDeleted, onClose }: Props) {
  const prefix = useId();
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const locked = useRef(false);
  const busy = pending || submitting;
  const matches = confirmation === project.name;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || locked.current || !matches) return;
    locked.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onDelete(project, confirmation);
      onDeleted();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      locked.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog title="Eliminar proyecto" busy={busy} onClose={onClose}>
      <form className="pw-form" onSubmit={event => void submit(event)} aria-describedby={`${prefix}-consequences`}>
        <div className="pw-form-body">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <div id={`${prefix}-consequences`}>
            <p>
              Vas a eliminar definitivamente <strong>{project.name}</strong>, todas sus tareas, sus conversaciones y su historial de actividad. Hay {taskCount}{' '}
              {taskCount === 1 ? 'tarea visible' : 'tareas visibles'} en este proyecto.
            </p>
            <p>Esta acción no se puede deshacer. Los demás proyectos y sus tareas se conservarán.</p>
            <p className="faint">
              Si el proyecto contiene archivos o cargas pendientes, retíralos desde Archivos antes de eliminarlo. Puedes archivarlo para conservarlos.
            </p>
            <p className="faint">
              Se solicitará retirar las copias vinculadas en Google Calendar y Google Tasks. Una conexión pausada, un conflicto o un fallo puede dejar la
              limpieza pendiente.
            </p>
            <p className="faint">
              Si este proyecto recibe tareas importadas de Google Tasks, la integración podrá crear otro destino cuando lleguen nuevas tareas.
            </p>
          </div>
          <label className="pw-field" htmlFor={`${prefix}-confirmation`}>
            Escribe el nombre exacto del proyecto
            <input
              id={`${prefix}-confirmation`}
              value={confirmation}
              onChange={event => setConfirmation(event.target.value)}
              disabled={busy}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-describedby={`${prefix}-exact-name`}
            />
          </label>
          <p id={`${prefix}-exact-name`} className="faint">
            Nombre que debes escribir: <strong>{project.name}</strong>. Respeta mayúsculas y espacios.
          </p>
        </div>
        <div className="pw-form-footer">
          <button type="button" className="btn btn-secondary" data-initial-focus disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-danger" disabled={busy || !matches}>
            <Trash2 size={14} aria-hidden="true" />
            {submitting ? 'Eliminando…' : 'Eliminar proyecto definitivamente'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
