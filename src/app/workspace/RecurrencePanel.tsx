import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Check, ChevronDown, Clock3, LoaderCircle, Pause, Repeat2, Save } from 'lucide-react';
import type { CalendarApi, Task } from '../types';
import type { RecurrenceApi, RecurrenceRule, RecurrenceState } from '../recurrence-types';
import { previewRecurrenceDates, validRecurrenceRule } from '../recurrence-dates';
import { dateInTimeZone, detectDeviceTimeZone, formatCivilDate, validCivilDate } from './CalendarTime';
import { Busy, ErrorNotice } from './ui';
import { errorMessage } from './helpers';
import TimeZonePicker from './TimeZonePicker';
import './recurrence.css';
import './mobile-form-communication.css';

interface Props {
  task: Task;
  api: RecurrenceApi;
  calendar?: CalendarApi;
  disabled?: boolean;
  canEdit: boolean;
  canCreate: boolean;
}
interface Draft {
  task: Task;
  seriesVersion: number | null;
  rule: RecurrenceRule;
}
interface SavePlan {
  task: Task;
  seriesVersion: number | null;
  rule: RecurrenceRule | null;
  requestId: string;
}
const frequencies = { daily: 'Diaria', weekly: 'Semanal', monthly: 'Mensual' };
const states = { active: 'Activa', paused: 'Pausada', blocked: 'Por revisar', finished: 'Finalizada' };
const days = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const limits = { daily: 365, weekly: 52, monthly: 12 };
const units = { daily: 'días', weekly: 'semanas', monthly: 'meses' };
const singularUnits = { daily: 'día', weekly: 'semana', monthly: 'mes' };
const reasons: Record<string, string> = {
  authority_lost: 'El autor ya no puede editar y crear tareas en este proyecto. Una persona con ambos permisos puede revisar y reactivar la regla.',
  assignee_not_inherited: 'La nueva tarea quedó sin responsable porque no se pudo conservar la asignación anterior.',
  task_archived: 'Archivar la tarea pausó la repetición. Restaurarla no la reactiva automáticamente.',
  project_archived: 'Archivar el proyecto pausó la repetición. Restaurarlo no la reactiva automáticamente.',
  task_moved: 'La repetición se pausó al trasladar la tarea; la serie no se traslada a otro proyecto.',
  task_deleted: 'La repetición se pausó al eliminar su tarea actual.',
};
const copyRule = (rule: RecurrenceRule): RecurrenceRule => ({ ...rule, weekdays: [...rule.weekdays] });

export default function RecurrencePanel(props: Props) {
  return <ScopedRecurrencePanel key={JSON.stringify([props.api.scopeKey, props.task.workspace_id, props.task.id, props.task.created_at])} {...props} />;
}

function ScopedRecurrencePanel({ task, api, calendar, disabled = false, canEdit, canCreate }: Props) {
  const client = useQueryClient();
  const queryKey = [...api.scopeKey, 'task', task.id, task.created_at, task.version];
  const query = useQuery({ queryKey, queryFn: ({ signal }) => api.state(task, signal), retry: false, refetchInterval: 30000, gcTime: 0 });
  const profile = useQuery({
    queryKey: [...(calendar?.scopeKey ?? ['recurrence-zone-unavailable']), 'profile'],
    queryFn: ({ signal }) => calendar!.profile(signal),
    enabled: Boolean(calendar),
    retry: false,
  });
  const [deviceZone] = useState(() => detectDeviceTimeZone() ?? 'UTC');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<SavePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [ambiguous, setAmbiguous] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const state = query.error ? null : query.data;
  const series = state?.series ?? null;
  const head = !series || (series.current_task_id === task.id && series.current_task_created_at === task.created_at);
  const finished = series?.state === 'finished';
  const archived = Boolean(task.archived_at);
  const editable = canEdit && !disabled && !archived && head && !finished;
  const mayConfigure = editable && canCreate && Boolean(series || (task.status !== 'done' && task.due_date && validCivilDate(task.due_date)));
  const mayPause = editable && Boolean(series && series.state !== 'paused');
  const blocked = disabled || busy;
  const changed = Boolean(draft && (draft.task.version !== task.version || draft.seriesVersion !== (series?.version ?? null)));
  const anchor = series?.anchor_date ?? task.due_date;
  const rule = draft?.rule;
  const valid = Boolean(rule && validRecurrenceRule(rule) && anchor && validCivilDate(anchor) && (!rule.until_date || rule.until_date >= anchor));
  let preview: string[] = [];
  if (rule && valid && anchor) {
    const today = dateInTimeZone(new Date(), rule.time_zone);
    const occurrence = state?.occurrence_date ?? task.due_date ?? anchor;
    preview = previewRecurrenceDates(rule, anchor, occurrence > today ? occurrence : today);
  }

  function edit() {
    if (!mayConfigure || blocked || plan || !state) return;
    setDraft({
      task: { ...task },
      seriesVersion: series?.version ?? null,
      rule: series
        ? copyRule(series.rule)
        : { frequency: 'daily', interval: 1, weekdays: [], time_zone: profile.data?.time_zone ?? task.scheduled_time_zone ?? deviceZone, until_date: null },
    });
    setError('');
    setNotice('');
    setOpen(true);
  }
  function patch(patch: Partial<RecurrenceRule>) {
    if (blocked || plan) return;
    setDraft(previous => (previous ? { ...previous, rule: { ...previous.rule, ...patch } } : null));
    setError('');
  }
  function frequency(next: RecurrenceRule['frequency']) {
    const weekday = task.due_date ? ((new Date(`${task.due_date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1 : 1;
    patch({ frequency: next, interval: 1, weekdays: next === 'weekly' ? [weekday] : [] });
  }
  async function persist(frozen: SavePlan) {
    if (lock.current || blocked) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setPlan(frozen);
    setAmbiguous(false);
    try {
      const saved: RecurrenceState = await api.save(frozen.task, frozen.seriesVersion, frozen.rule, frozen.requestId);
      if (!active.current) return;
      client.setQueryData(queryKey, saved);
      setPlan(null);
      setDraft(null);
      setOpen(false);
      setNotice(
        frozen.rule === null
          ? 'Repetición pausada.'
          : saved.series?.state === 'blocked'
            ? 'Regla guardada. Revisa la creación de la siguiente tarea.'
            : 'Repetición guardada.',
      );
    } catch (cause) {
      if (!active.current) return;
      const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : '';
      if (['PT409', 'PT404', '42501', '22023', '55000', 'PT410', 'PT429', 'PGRST202', 'PGRST301', 'PGRST303'].includes(code)) {
        setPlan(null);
        setError(errorMessage(cause));
      } else {
        setAmbiguous(true);
        setError('No pudimos confirmar el guardado. Puede haberse aplicado; reintenta la misma solicitud antes de preparar otra.');
      }
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !rule || !valid || changed || !mayConfigure || blocked || plan) return;
    void persist({ task: { ...draft.task }, seriesVersion: draft.seriesVersion, rule: copyRule(rule), requestId: crypto.randomUUID() });
  }
  function pause() {
    if (!series || !mayPause || blocked || plan) return;
    void persist({ task: { ...task }, seriesVersion: series.version, rule: null, requestId: crypto.randomUUID() });
  }
  function cancel() {
    if (busy) return;
    setOpen(false);
    if (!ambiguous) {
      setDraft(null);
      setError('');
    }
  }

  return (
    <section className="td-section recurrence-panel" aria-label="Repetición de la tarea">
      <div className="td-section-title">
        <h4>
          <Repeat2 size={15} aria-hidden="true" /> Repetición
        </h4>
        {series && <span className={`recurrence-state is-${series.state}`}>{states[series.state]}</span>}
      </div>
      {query.isPending ? (
        <Busy>Cargando repetición…</Busy>
      ) : query.error ? (
        <ErrorNotice>
          {errorMessage(query.error)}{' '}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void query.refetch()}>
            Reintentar repetición
          </button>
        </ErrorNotice>
      ) : (
        <>
          {series ? (
            <div className="recurrence-summary">
              <strong>
                {frequencies[series.rule.frequency]}
                {series.rule.interval > 1 ? ` · Cada ${series.rule.interval} ${units[series.rule.frequency]}` : ''}
              </strong>
              <span>
                <Clock3 size={13} aria-hidden="true" /> {series.rule.time_zone}
              </span>
              {series.rule.frequency === 'weekly' && <span>{series.rule.weekdays.map(day => days[day - 1]).join(' · ')}</span>}
              <span>
                <CalendarDays size={13} aria-hidden="true" /> Ocurrencia actual: {formatCivilDate(series.current_occurrence_date)}
              </span>
              <p>
                {series.state === 'blocked'
                  ? 'La siguiente ocurrencia no pudo crearse. Revisa la configuración y los permisos del autor antes de reintentar.'
                  : series.state === 'paused'
                    ? 'La repetición está pausada. Activarla conserva el historial.'
                    : series.state === 'finished'
                      ? 'La serie llegó a su final. Sus ocurrencias permanecen en el proyecto.'
                      : 'Al completar la tarea actual se creará como máximo la siguiente.'}
              </p>
              {series.rule.until_date && <span>Hasta {formatCivilDate(series.rule.until_date)}</span>}
              {series.reason && reasons[series.reason] && <p className="faint">{reasons[series.reason]}</p>}
              {!head && <p className="pw-info">Esta ocurrencia pertenece al historial. La repetición se administra desde la tarea actual de la serie.</p>}
            </div>
          ) : (
            <p className="faint">Esta tarea no se repite. Puedes conservar cada ocurrencia en tu historial.</p>
          )}
          {!series && (!task.due_date || !validCivilDate(task.due_date)) && (
            <p className="faint">Añade un vencimiento desde Editar tarea antes de configurar la repetición.</p>
          )}
          {!series && task.status === 'done' && <p className="faint">Configura la repetición en una tarea pendiente.</p>}
          {head && !finished && !canCreate && canEdit && (
            <p className="faint">Para activar una repetición necesitas permiso para crear tareas en este proyecto. Puedes pausar una serie existente.</p>
          )}
          {!open && !plan && (mayConfigure || mayPause) && (
            <div className="recurrence-buttons">
              {mayConfigure && (
                <button type="button" className="btn btn-secondary btn-sm" disabled={blocked || Boolean(calendar && profile.isPending)} onClick={edit}>
                  <Repeat2 size={14} aria-hidden="true" />
                  {series ? 'Editar repetición' : 'Configurar repetición'}
                </button>
              )}
              {mayPause && (
                <button type="button" className="btn btn-ghost btn-sm" disabled={blocked} onClick={pause}>
                  <Pause size={14} aria-hidden="true" />
                  Pausar repetición
                </button>
              )}
            </div>
          )}
          {notice && (
            <p className="recurrence-notice" role="status">
              <Check size={14} aria-hidden="true" />
              {notice}
            </p>
          )}
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {plan && ambiguous && !open && (
            <p className="pw-info" role="status">
              Hay un guardado por confirmar.{' '}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
                Retomar guardado
              </button>
            </p>
          )}
          {open && draft && (
            <form className="recurrence-form" onSubmit={save}>
              {changed && !plan && (
                <p className="pw-info">
                  La tarea o su repetición cambiaron. Tu borrador sigue aquí; cancela y revisa la configuración actual antes de guardar.
                </p>
              )}
              <fieldset disabled={blocked || Boolean(plan) || !mayConfigure}>
                <legend className="sr">Configurar repetición</legend>
                <div className="pw-field-grid">
                  <label className="pw-field">
                    Frecuencia de repetición
                    <div className="recurrence-input-icon">
                      <Repeat2 size={14} aria-hidden="true" />
                      <select
                        aria-label="Frecuencia de repetición"
                        value={rule!.frequency}
                        onChange={event => frequency(event.target.value as RecurrenceRule['frequency'])}
                      >
                        {Object.entries(frequencies).map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={14} aria-hidden="true" className="recurrence-select-chevron" />
                    </div>
                  </label>
                  <label className="pw-field">
                    Intervalo de repetición
                    <div className="recurrence-input-icon">
                      <CalendarDays size={14} aria-hidden="true" />
                      <input
                        type="number"
                        aria-label="Intervalo de repetición"
                        min={1}
                        max={limits[rule!.frequency]}
                        step={1}
                        value={rule!.interval}
                        onChange={event => patch({ interval: Number(event.target.value) })}
                      />
                    </div>
                    <span className="faint">
                      Cada {rule!.interval || '…'} {rule!.interval === 1 ? singularUnits[rule!.frequency] : units[rule!.frequency]}
                    </span>
                  </label>
                </div>
                {rule!.frequency === 'weekly' && (
                  <fieldset className="recurrence-weekdays">
                    <legend>Días de la semana</legend>
                    <div>
                      {days.map((day, index) => (
                        <button
                          type="button"
                          key={day}
                          aria-label={`Repetir los ${day}`}
                          aria-pressed={rule!.weekdays.includes(index + 1)}
                          onClick={() =>
                            patch({
                              weekdays: rule!.weekdays.includes(index + 1)
                                ? rule!.weekdays.filter(value => value !== index + 1)
                                : [...rule!.weekdays, index + 1].sort((a, b) => a - b),
                            })
                          }
                        >
                          {day.slice(0, 3)}
                        </button>
                      ))}
                    </div>
                    {!rule!.weekdays.length && <p className="faint">Selecciona al menos un día.</p>}
                  </fieldset>
                )}
                {rule!.frequency === 'monthly' && anchor && (
                  <p className="recurrence-date-note">
                    <CalendarDays size={14} aria-hidden="true" />
                    Día {Number(anchor.slice(8))} de cada mes seleccionado. Si ese día no existe, se usa el último del mes sin cambiar el día original de la
                    serie.
                  </p>
                )}
                <TimeZonePicker
                  label="Zona horaria de repetición"
                  value={rule!.time_zone}
                  onChange={time_zone => patch({ time_zone })}
                  disabled={blocked || Boolean(plan) || !mayConfigure}
                />
                <label className="recurrence-check">
                  <input type="checkbox" checked={rule!.until_date !== null} onChange={event => patch({ until_date: event.target.checked ? anchor : null })} />
                  Finalizar en una fecha
                </label>
                {rule!.until_date !== null && (
                  <label className="pw-field">
                    Última fecha de repetición
                    <div className="recurrence-input-icon">
                      <CalendarDays size={14} aria-hidden="true" />
                      <input
                        type="date"
                        aria-label="Última fecha de repetición"
                        min={anchor ?? undefined}
                        value={rule!.until_date}
                        onChange={event => patch({ until_date: event.target.value })}
                      />
                    </div>
                  </label>
                )}
              </fieldset>
              {valid && (
                <div className="recurrence-preview" aria-label="Próximas fechas estimadas">
                  <strong>Próximas fechas estimadas</strong>
                  {preview.length ? (
                    <ul>
                      {preview.map(date => (
                        <li key={date}>
                          <CalendarDays size={13} aria-hidden="true" />
                          {formatCivilDate(date)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No habrá nuevas ocurrencias después de la actual con esta fecha final.</p>
                  )}
                  <p>Se crea una al completar la actual; se saltan las fechas ya pasadas.</p>
                </div>
              )}
              <p className="faint">
                Las siguientes ocurrencias usan fechas, sin copiar bloques horarios. Solo las tareas ya creadas aparecen en el calendario.
              </p>
              <div className="recurrence-buttons">
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={cancel}>
                  {ambiguous ? 'Comprobar más tarde' : 'Cancelar'}
                </button>
                {plan && ambiguous ? (
                  <button type="button" className="btn btn-primary btn-sm" disabled={blocked} onClick={() => void persist(plan)}>
                    <Save size={14} aria-hidden="true" />
                    Reintentar el mismo guardado
                  </button>
                ) : (
                  <button type="submit" className="btn btn-primary btn-sm" disabled={blocked || !mayConfigure || !valid || changed || Boolean(plan)}>
                    {busy ? <LoaderCircle size={14} className="pw-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
                    {series?.state === 'blocked' ? 'Guardar y reintentar' : 'Guardar repetición'}
                  </button>
                )}
              </div>
            </form>
          )}
          {plan && ambiguous && open && !draft && (
            <div className="recurrence-buttons">
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={cancel}>
                Comprobar más tarde
              </button>
              <button type="button" className="btn btn-primary btn-sm" disabled={blocked} onClick={() => void persist(plan)}>
                Reintentar el mismo guardado
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
