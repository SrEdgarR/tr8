import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Archive, Check, CircleAlert, ListChecks, LoaderCircle, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import type { BulkTaskItem, BulkTaskOperation, BulkTaskRequest, BulkTaskResult, BulkTasksApi } from '../bulk-task-types';
import type { Project, Task, WorkspaceMember } from '../types';
import { PRIORITIES, STATUSES } from '../constants';
import { Dialog, ErrorNotice } from './ui';

type Kind = BulkTaskOperation['kind'];
const kinds: readonly Kind[] = ['status', 'priority', 'assign', 'archive', 'delete'];
const labels: Record<Kind, string> = {
  status: 'Cambiar estado',
  priority: 'Cambiar prioridad',
  assign: 'Asignar responsable',
  archive: 'Archivar tareas',
  delete: 'Eliminar tareas',
};

export interface TaskSelection {
  selectedIds: readonly string[];
  disabled: boolean;
  canSelect: (task: Task) => boolean;
  toggle: (task: Task) => void;
}
interface Plan {
  request: BulkTaskRequest;
  operation: BulkTaskOperation;
  items: BulkTaskItem[];
  tasks: Task[];
  description: string;
  sent: boolean;
}
function rejection(code: string | null) {
  if (code === 'PT409') return 'Cambió en otra sesión. Revisa su versión actual.';
  if (code === '55000') return 'La tarea o su proyecto están archivados.';
  if (code === '22023' || code === '23514') return 'El valor o el responsable no son válidos para esta tarea.';
  if (code === '42501' || code === 'PT404') return 'Ya no está disponible o no tienes permiso para esta acción.';
  return 'No se aplicó. Revisa la tarea y sus permisos.';
}

export default function BulkTaskActions({
  tasks,
  projects,
  members,
  api,
  can,
  pending,
  onBusyChange,
  children,
}: {
  tasks: Task[];
  projects: Project[];
  members: WorkspaceMember[];
  api: BulkTasksApi;
  can: (task: Task, kind: Kind) => boolean;
  pending: boolean;
  onBusyChange: (busy: boolean) => void;
  children: (selection: TaskSelection) => ReactNode;
}) {
  const [selected, setSelected] = useState<Task[]>([]);
  const [kind, setKind] = useState<Kind>('status');
  const [value, setValue] = useState('todo');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [ambiguous, setAmbiguous] = useState(false);
  const [terminalError, setTerminalError] = useState('');
  const [result, setResult] = useState<BulkTaskResult | null>(null);
  const [notice, setNotice] = useState('');
  const submitting = useRef(false);
  const active = useRef(true);
  const checkAll = useRef<HTMLInputElement>(null);
  const projectMap = new Map(projects.map(project => [project.id, project]));
  const current = new Map(tasks.map(task => [task.id, task]));
  const canSelect = (task: Task) => !task.archived_at && !projectMap.get(task.project_id)?.archived_at && kinds.some(action => can(task, action));
  const eligible = tasks.filter(canSelect);
  const selectedCurrent = selected.every(task => {
    const latest = current.get(task.id);
    return latest?.version === task.version && latest.project_id === task.project_id && canSelect(latest);
  });
  const chosen = selectedCurrent ? selected : [];
  const selectedIds = chosen.map(task => task.id);
  const allChecked = eligible.length > 0 && eligible.every(task => selectedIds.includes(task.id));
  const validPlan = !plan || plan.sent || plan.tasks.every(task => current.get(task.id)?.version === task.version && can(task, plan.operation.kind));
  const allowed = chosen.length > 0 && chosen.every(task => can(task, kind));
  const blocked = pending || busy;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (checkAll.current) checkAll.current.indeterminate = selectedIds.length > 0 && !allChecked;
  }, [selectedIds.length, allChecked]);
  useEffect(() => {
    if (!selectedCurrent && !plan?.sent) {
      setSelected([]);
      setPlan(null);
      setNotice('La selección cambió o se actualizó una tarea. Vuelve a seleccionar las versiones que quieres modificar.');
    }
  }, [selectedCurrent, plan?.sent]);

  function toggle(task: Task) {
    if (blocked || plan || !canSelect(task)) return;
    setNotice('');
    if (selectedIds.includes(task.id)) setSelected(chosen.filter(row => row.id !== task.id));
    else if (chosen.length < 50) setSelected([...chosen, { ...task }]);
    else setNotice('Puedes seleccionar hasta 50 tareas por operación.');
  }
  function selectAll() {
    if (blocked || plan) return;
    setSelected(allChecked ? [] : eligible.slice(0, 50).map(task => ({ ...task })));
    setNotice(eligible.length > 50 && !allChecked ? 'Se seleccionaron las primeras 50 tareas visibles. Completa este lote antes de seleccionar otro.' : '');
  }
  function changeKind(next: Kind) {
    setKind(next);
    setValue(next === 'priority' ? 'none' : next === 'assign' ? '' : 'todo');
  }
  function open() {
    if (blocked || !allowed || chosen.length > 50) return;
    const operation: BulkTaskOperation =
      kind === 'status'
        ? { kind, status: value as Task['status'] }
        : kind === 'priority'
          ? { kind, priority: value as Task['priority'] }
          : kind === 'assign'
            ? { kind, assignee_member_id: value || null }
            : { kind };
    const description =
      kind === 'status'
        ? STATUSES.find(row => row.id === value)?.name
        : kind === 'priority'
          ? PRIORITIES.find(row => row.id === value)?.name
          : kind === 'assign'
            ? (members.find(row => row.id === value)?.display_name ?? 'Sin responsable')
            : kind === 'archive'
              ? 'Archivar las tareas seleccionadas'
              : 'Eliminar definitivamente las tareas seleccionadas';
    setPlan({
      request: { id: crypto.randomUUID(), requested_at: new Date().toISOString() },
      operation,
      items: chosen.map(({ id, project_id, version }) => ({ id, project_id, version })),
      tasks: [...chosen],
      description: description ?? '',
      sent: false,
    });
    setConfirmation('');
    setResult(null);
    setAmbiguous(false);
    setTerminalError('');
    setReviewOpen(true);
  }
  async function apply() {
    if (
      !plan ||
      submitting.current ||
      blocked ||
      !validPlan ||
      result ||
      (plan.operation.kind === 'delete' && confirmation !== `ELIMINAR ${plan.tasks.length}`)
    )
      return;
    submitting.current = true;
    setBusy(true);
    onBusyChange(true);
    setAmbiguous(false);
    const frozen = { ...plan, sent: true };
    setPlan(frozen);
    let unresolved = false;
    try {
      const response = await api.apply(frozen.operation, frozen.items, frozen.request);
      if (!active.current) return;
      setResult(response);
      const applied = new Set(response.results.filter(row => row.outcome === 'applied').map(row => row.id));
      setSelected(previous => previous.filter(row => !applied.has(row.id)));
    } catch (cause) {
      if (active.current) {
        const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : '';
        if (code === 'PT410') setTerminalError('Este lote caducó. Cierra la revisión y prepara una nueva selección con los datos actuales.');
        else if (code === 'PT429')
          setTerminalError(
            'Se alcanzó el límite de acciones masivas de las últimas 24 horas. No se aplicó este lote. Espera antes de preparar una nueva acción.',
          );
        else if (['42501', 'PT404', 'PT409', '22023', 'PGRST202', 'PGRST301', 'PGRST303'].includes(code))
          setTerminalError('No se pudo aplicar este lote. Actualiza los datos y revisa tus permisos antes de preparar una nueva acción.');
        else {
          setAmbiguous(true);
          unresolved = true;
        }
      }
    } finally {
      submitting.current = false;
      if (active.current) {
        setBusy(false);
        onBusyChange(unresolved);
      }
    }
  }
  function close() {
    if (busy) return;
    if (ambiguous) {
      setReviewOpen(false);
      return;
    }
    setPlan(null);
    setResult(null);
    setReviewOpen(false);
  }
  return (
    <>
      <div className={`tv-bulk-toolbar${chosen.length ? ' has-selection' : ''}`} aria-label="Acciones masivas de tareas">
        <label className="tv-bulk-select-all">
          <input
            ref={checkAll}
            type="checkbox"
            checked={allChecked}
            onChange={selectAll}
            disabled={blocked || !!plan || eligible.length === 0}
            aria-label="Seleccionar tareas visibles"
          />
          <span>{chosen.length ? `${chosen.length} seleccionadas` : 'Seleccionar tareas'}</span>
        </label>
        {chosen.length > 0 ? (
          <>
            <label className="tv-bulk-field">
              <ListChecks size={14} aria-hidden="true" />
              <span className="sr">Acción masiva</span>
              <select aria-label="Acción masiva" value={kind} onChange={event => changeKind(event.target.value as Kind)} disabled={blocked || !!plan}>
                {kinds.map(action => (
                  <option key={action} value={action} disabled={!chosen.every(task => can(task, action))}>
                    {labels[action]}
                  </option>
                ))}
              </select>
            </label>
            {(kind === 'status' || kind === 'priority' || kind === 'assign') && (
              <label className="tv-bulk-field">
                {kind === 'assign' ? <UserRound size={14} aria-hidden="true" /> : <ListChecks size={14} aria-hidden="true" />}
                <span className="sr">{kind === 'status' ? 'Nuevo estado' : kind === 'priority' ? 'Nueva prioridad' : 'Nuevo responsable'}</span>
                <select
                  aria-label={kind === 'status' ? 'Nuevo estado' : kind === 'priority' ? 'Nueva prioridad' : 'Nuevo responsable'}
                  value={value}
                  disabled={blocked || !!plan}
                  onChange={event => setValue(event.target.value)}
                >
                  {kind === 'status' ? (
                    STATUSES.map(row => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                      </option>
                    ))
                  ) : kind === 'priority' ? (
                    PRIORITIES.map(row => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="">Sin responsable</option>
                      {members
                        .filter(row => row.status === 'active')
                        .map(row => (
                          <option key={row.id} value={row.id}>
                            {row.display_name}
                          </option>
                        ))}
                    </>
                  )}
                </select>
              </label>
            )}
            <button className={`btn btn-sm ${kind === 'delete' ? 'btn-danger' : 'btn-primary'}`} disabled={blocked || !!plan || !allowed} onClick={open}>
              {kind === 'delete' ? (
                <Trash2 size={14} aria-hidden="true" />
              ) : kind === 'archive' ? (
                <Archive size={14} aria-hidden="true" />
              ) : (
                <Check size={14} aria-hidden="true" />
              )}{' '}
              Revisar acción
            </button>
            <button className="ibtn ibtn-sm" aria-label="Quitar selección" disabled={blocked || !!plan} onClick={() => setSelected([])}>
              <X size={14} aria-hidden="true" />
            </button>
            {!allowed && <span className="tv-bulk-permission">Elige una acción permitida para todas las tareas seleccionadas.</span>}
          </>
        ) : (
          <span className="faint">Solo las filas visibles · Hasta 50 tareas</span>
        )}
      </div>
      {notice && (
        <p className="pw-info" role="status">
          {notice}
        </p>
      )}
      {children({ selectedIds, disabled: blocked || !!plan, canSelect, toggle })}
      {plan && ambiguous && !reviewOpen && (
        <div className="pw-info" role="status">
          El resultado de un lote sigue por confirmar. Conservamos la misma operación para comprobarla antes de preparar otro lote.{' '}
          <button className="btn btn-secondary btn-sm" onClick={() => setReviewOpen(true)}>
            Retomar comprobación
          </button>
        </div>
      )}
      {plan && reviewOpen && (
        <Dialog title={result ? 'Resultado de la acción masiva' : labels[plan.operation.kind]} onClose={close} busy={busy} wide>
          <div className="pw-form-body tv-bulk-dialog">
            <div className="tv-bulk-review">
              <ShieldCheck size={20} aria-hidden="true" />
              <div>
                <strong>{plan.description}</strong>
                <p>{plan.tasks.length} tareas · Se comprobarán los permisos y la versión de cada tarea.</p>
              </div>
            </div>
            {plan.operation.kind === 'assign' && !result && (
              <p className="faint">El responsable debe tener acceso a cada proyecto. Las tareas donde no pueda asignarse se indicarán en el resultado.</p>
            )}
            <ul className="tv-bulk-task-review" aria-label="Tareas del lote">
              {plan.tasks.map(task => {
                const outcome = result?.results.find(row => row.id === task.id);
                return (
                  <li key={task.id}>
                    <div>
                      <strong>{task.title}</strong>
                      <span>
                        {projectMap.get(task.project_id)?.name ?? 'Proyecto'} · Versión {task.version}
                      </span>
                    </div>
                    {outcome && (
                      <span className={outcome.outcome === 'applied' ? 'tv-bulk-applied' : 'tv-bulk-rejected'}>
                        {outcome.outcome === 'applied' ? (
                          <>
                            <Check size={14} aria-hidden="true" /> Aplicada
                          </>
                        ) : (
                          <>
                            <CircleAlert size={14} aria-hidden="true" /> {rejection(outcome.code)}
                          </>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {result && (
              <p role="status">
                {result.results.filter(row => row.outcome === 'applied').length} aplicadas · {result.results.filter(row => row.outcome === 'rejected').length}{' '}
                no aplicadas. Revisa las tareas rechazadas antes de preparar un nuevo lote.
              </p>
            )}
            {!validPlan && !plan.sent && <ErrorNotice>Una tarea cambió. Cierra esta revisión y vuelve a seleccionarla antes de continuar.</ErrorNotice>}
            {ambiguous && (
              <ErrorNotice>
                No pudimos confirmar el resultado. El servidor puede haber aplicado el lote. Reintentar comprobará la misma operación, sin crear otra copia.
              </ErrorNotice>
            )}
            {terminalError && <ErrorNotice>{terminalError}</ErrorNotice>}
            {plan.operation.kind === 'delete' && !result && (
              <label className="pw-field">
                Escribe ELIMINAR {plan.tasks.length} para confirmar
                <input
                  aria-label="Confirmación de eliminación masiva"
                  value={confirmation}
                  onChange={event => setConfirmation(event.target.value)}
                  disabled={busy || plan.sent}
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="faint">Se eliminarán solo estas tareas y su conversación. Esta acción es definitiva.</span>
              </label>
            )}
          </div>
          <div className="pw-form-foot">
            {ambiguous ? (
              <button className="btn btn-secondary" onClick={close}>
                Comprobar más tarde
              </button>
            ) : (
              <button className="btn btn-secondary" disabled={busy} onClick={close}>
                {result ? 'Cerrar resultado' : 'Cancelar'}
              </button>
            )}
            {!result && (
              <button
                className={`btn ${plan.operation.kind === 'delete' ? 'btn-danger' : 'btn-primary'}`}
                disabled={blocked || !!terminalError || !validPlan || (plan.operation.kind === 'delete' && confirmation !== `ELIMINAR ${plan.tasks.length}`)}
                onClick={() => void apply()}
              >
                {busy ? <LoaderCircle size={14} className="pw-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                {busy ? 'Aplicando…' : ambiguous ? 'Reintentar el mismo lote' : 'Confirmar acción'}
              </button>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
