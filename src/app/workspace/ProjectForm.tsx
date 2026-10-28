import { useId, useRef, useState, type FormEvent } from 'react';
import { CalendarDays, Check, Flag, Layers3, UserRound } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { PROJECT_COLORS, PROJECT_STATUSES } from '../constants';
import { PROJECT_ICONS, projectIconName, type ProjectIconName } from '../project-identity';
import type { CollaborationApi, Project, ProjectInput, ProjectStatus, WorkspaceProps } from '../types';
import { PROJECT_TEMPLATES } from '../work-management-types';
import { Dialog, ErrorNotice, ProjectIcon } from './ui';
import { ProjectGlyph } from './project-identity';
import { errorMessage } from './helpers';
import './project-planning.css';

interface Props {
  project?: Project;
  pending: boolean;
  collaboration?: CollaborationApi;
  canAssignLead?: boolean;
  onCreate: WorkspaceProps['onCreateProject'];
  onUpdate: WorkspaceProps['onUpdateProject'];
  onSaved: (project: Project) => void;
  onClose: () => void;
}

function ProjectLeadField({
  project,
  api,
  selected,
  onChange,
  disabled,
}: {
  project: Project;
  api: CollaborationApi;
  selected: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const members = useQuery({
    queryKey: [...api.scopeKey, 'assignable', project.id],
    queryFn: () => api.assignableMembers(project.id),
    refetchInterval: 30000,
    retry: false,
  });
  const available = members.error ? [] : (members.data ?? []);
  return (
    <div className="pw-project-lead-field">
      <label className="pw-field">
        Responsable del proyecto <span className="faint">Opcional</span>
        <span className="pw-planning-control">
          <UserRound size={15} aria-hidden="true" />
          <select value={selected} onChange={event => onChange(event.target.value)} disabled={disabled || members.isPending || !!members.error}>
            <option value="">Sin responsable</option>
            {selected && !available.some(member => member.id === selected) && <option value={selected}>Responsable no disponible</option>}
            {available.map(member => (
              <option key={member.id} value={member.id}>
                {member.display_name}
              </option>
            ))}
          </select>
        </span>
      </label>
      {members.error && <ErrorNotice>{errorMessage(members.error)}</ErrorNotice>}
      <p className="pw-planning-help">Solo personas con acceso vigente al proyecto. Asignar un responsable no cambia sus permisos.</p>
    </div>
  );
}

export default function ProjectForm({ project, pending, collaboration, canAssignLead = Boolean(collaboration), onCreate, onUpdate, onSaved, onClose }: Props) {
  const prefix = useId();
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [color, setColor] = useState(project?.color ?? PROJECT_COLORS[0]);
  const [icon, setIcon] = useState<ProjectIconName>(projectIconName(project?.icon));
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? 'planning');
  const [startDate, setStartDate] = useState(project?.start_date ?? '');
  const [dueDate, setDueDate] = useState(project?.due_date ?? '');
  const [leadId, setLeadId] = useState(project?.lead_member_id ?? '');
  const [template, setTemplate] = useState<NonNullable<ProjectInput['template_key']> | ''>('');
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
    if (startDate && dueDate && startDate > dueDate) {
      setError('La fecha objetivo no puede ser anterior al inicio del proyecto.');
      return;
    }
    lock.current = true;
    setSubmitting(true);
    setError(null);
    const input: ProjectInput = {
      name: name.trim(),
      description: description.trim(),
      color,
      status,
      icon,
      ...(startDate || dueDate || project?.start_date !== undefined || project?.due_date !== undefined
        ? { start_date: startDate || null, due_date: dueDate || null }
        : {}),
      ...(project && canAssignLead && (leadId || project.lead_member_id !== undefined) ? { lead_member_id: leadId || null } : {}),
      ...(!project && template ? { template_key: template } : {}),
    };
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
    <Dialog title={project ? 'Editar proyecto' : 'Nuevo proyecto'} busy={busy} onClose={onClose} className="pw-project-dialog">
      <form
        onSubmit={event => {
          void submit(event);
        }}
        className="pw-form"
      >
        <div className="pw-form-body pw-project-planning-body">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <label className="pw-field pw-project-form-name" htmlFor={`${prefix}-name`}>
            Nombre del proyecto
            <span className="pw-project-name-row">
              <ProjectIcon icon={icon} color={color} />
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
            </span>
          </label>
          <label className="pw-field pw-project-form-description" htmlFor={`${prefix}-description`}>
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
          <label className="pw-field pw-project-form-status" htmlFor={`${prefix}-status`}>
            Estado
            <select id={`${prefix}-status`} value={status} onChange={event => setStatus(event.target.value as ProjectStatus)} disabled={busy}>
              {PROJECT_STATUSES.map(item => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className="pw-project-dates">
            <label className="pw-field" htmlFor={`${prefix}-start`}>
              Inicio <span className="faint">Opcional</span>
              <span className="pw-planning-control">
                <CalendarDays size={15} aria-hidden="true" />
                <input id={`${prefix}-start`} type="date" value={startDate} onChange={event => setStartDate(event.target.value)} disabled={busy} />
              </span>
            </label>
            <label className="pw-field" htmlFor={`${prefix}-due`}>
              Fecha objetivo <span className="faint">Opcional</span>
              <span className="pw-planning-control">
                <Flag size={15} aria-hidden="true" />
                <input
                  id={`${prefix}-due`}
                  type="date"
                  min={startDate || undefined}
                  value={dueDate}
                  onChange={event => setDueDate(event.target.value)}
                  disabled={busy}
                />
              </span>
            </label>
          </div>
          {project && collaboration && canAssignLead && (
            <ProjectLeadField project={project} api={collaboration} selected={leadId} onChange={setLeadId} disabled={busy} />
          )}
          {!project && (
            <fieldset className="pw-project-templates" disabled={busy}>
              <legend>
                <Layers3 size={15} aria-hidden="true" /> Empezar desde una plantilla
              </legend>
              <label className={`pw-template-option${!template ? ' selected' : ''}`}>
                <input type="radio" name={`${prefix}-template`} value="" checked={!template} onChange={() => setTemplate('')} />
                <span>
                  <strong>Proyecto vacío</strong>
                  <small>Organiza tus tareas desde cero.</small>
                </span>
                {!template && <Check size={15} aria-hidden="true" />}
              </label>
              <div className="pw-template-grid">
                {PROJECT_TEMPLATES.map(item => (
                  <label key={item.key} className={`pw-template-option${template === item.key ? ' selected' : ''}`}>
                    <input type="radio" name={`${prefix}-template`} value={item.key} checked={template === item.key} onChange={() => setTemplate(item.key)} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {item.tasks.length} tareas · {item.description}
                      </small>
                    </span>
                    {template === item.key && <Check size={15} aria-hidden="true" />}
                  </label>
                ))}
              </div>
              {template && (
                <p className="pw-planning-help">
                  Se crearán: {PROJECT_TEMPLATES.find(item => item.key === template)?.tasks.join(' · ')}. Sin fechas ni responsables asignados.
                </p>
              )}
            </fieldset>
          )}
          <div className="pw-project-identity-options">
            <fieldset className="pw-icon-options" disabled={busy}>
              <legend>Icono del proyecto</legend>
              <div>
                {PROJECT_ICONS.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className={`pw-icon-option${icon === item.id ? ' selected' : ''}`}
                    aria-label={`Icono ${item.label}`}
                    aria-pressed={icon === item.id}
                    title={item.label}
                    onClick={() => setIcon(item.id)}
                  >
                    <ProjectGlyph icon={item.id} size={16} />
                  </button>
                ))}
              </div>
            </fieldset>
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
