import { useId, useRef, useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import { PROJECT_COLORS, PROJECT_STATUSES } from '../constants';
import type { Project, ProjectInput, ProjectStatus, WorkspaceProps } from '../types';
import { Dialog, ErrorNotice } from './ui';
import { errorMessage } from './helpers';

interface Props {
  project?: Project;
  pending: boolean;
  onCreate: WorkspaceProps['onCreateProject'];
  onUpdate: WorkspaceProps['onUpdateProject'];
  onSaved: (project: Project) => void;
  onClose: () => void;
}

export default function ProjectForm({ project, pending, onCreate, onUpdate, onSaved, onClose }: Props) {
  const prefix = useId();
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [color, setColor] = useState(project?.color ?? PROJECT_COLORS[0]);
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? 'planning');
  const [requestId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const lock = useRef(false);
  const busy = pending || submitting;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || lock.current) return;
    if (!name.trim()) {
      setError('Escribe un nombre para el proyecto.');
      return;
    }
    lock.current = true;
    setSubmitting(true);
    setError(null);
    const input: ProjectInput = { name: name.trim(), description: description.trim(), color, status };
    try {
      const saved = project ? await onUpdate(project, input) : await onCreate(input, requestId);
      onSaved(saved);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog title={project ? 'Editar proyecto' : 'Nuevo proyecto'} busy={busy} onClose={onClose}>
      <form
        onSubmit={event => {
          void submit(event);
        }}
        className="pw-form"
      >
        <div className="pw-form-body">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <label className="pw-field" htmlFor={`${prefix}-name`}>
            Nombre del proyecto
            <input
              id={`${prefix}-name`}
              data-initial-focus
              required
              maxLength={120}
              value={name}
              onChange={event => setName(event.target.value)}
              disabled={busy}
              placeholder="Por ejemplo: Mi próximo proyecto"
            />
          </label>
          <label className="pw-field" htmlFor={`${prefix}-description`}>
            Descripción <span className="faint">Opcional</span>
            <textarea
              id={`${prefix}-description`}
              rows={4}
              maxLength={5000}
              value={description}
              onChange={event => setDescription(event.target.value)}
              disabled={busy}
              placeholder="¿Qué quieres conseguir?"
            />
          </label>
          <label className="pw-field" htmlFor={`${prefix}-status`}>
            Estado
            <select id={`${prefix}-status`} value={status} onChange={event => setStatus(event.target.value as ProjectStatus)} disabled={busy}>
              {PROJECT_STATUSES.map(item => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="pw-colors">
            <legend>Color del proyecto</legend>
            <div>
              {PROJECT_COLORS.map((value, index) => (
                <button
                  key={value}
                  type="button"
                  className={`pw-color${color === value ? ' selected' : ''}`}
                  style={{ background: value }}
                  aria-label={`Color ${index + 1}`}
                  aria-pressed={color === value}
                  disabled={busy}
                  onClick={() => setColor(value)}
                >
                  {color === value && <Check size={15} aria-hidden="true" />}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="pw-form-footer">
          <button className="btn btn-secondary" type="button" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {submitting ? 'Guardando…' : project ? 'Guardar cambios' : 'Crear proyecto'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
