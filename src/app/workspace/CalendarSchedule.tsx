import { useMemo, useRef, useState } from 'react';
import type { CalendarApi, Task } from '../types';
import { ErrorNotice } from './ui';
import { errorMessage } from './helpers';
import { detectDeviceTimeZone, instantMicroseconds, localDateTime, localInstantChoices, moveBlock, resolveLocalInstant, validTimeZone } from './CalendarTime';
import TimeZonePicker from './TimeZonePicker';

function initialChoice(instant: string | null | undefined, zone: string): string {
  if (!instant) return '';
  const choices = localInstantChoices(localDateTime(instant, zone), zone);
  return choices.length > 1
    ? (choices.find(choice => Math.floor(Date.parse(choice.instant) / 60000) === Math.floor(Date.parse(instant) / 60000))?.instant ?? '')
    : '';
}

function OffsetChoice({
  label,
  value,
  zone,
  selected,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  zone: string;
  selected: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const choices = useMemo(() => localInstantChoices(value, zone), [value, zone]);
  if (!value || !validTimeZone(zone)) return null;
  if (!choices.length)
    return (
      <p className="pw-calendar-validation" role="status">
        {label}: esta hora no existe en la zona elegida. Selecciona otra hora.
      </p>
    );
  if (choices.length < 2) return null;
  return (
    <label className="pw-field">
      Desplazamiento del {label.toLocaleLowerCase('es')}
      <select value={selected} disabled={disabled} onChange={event => onChange(event.target.value)}>
        <option value="">Esta hora se repite: elige un desplazamiento</option>
        {choices.map(choice => (
          <option key={choice.instant} value={choice.instant}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Scheduling is an independent versioned mutation, just like assignment. */
export default function CalendarSchedule({
  task: liveTask,
  api,
  disabled,
  onSaved,
}: {
  task: Task;
  api: CalendarApi;
  disabled: boolean;
  onSaved: (before: Task, saved: Task) => void;
}) {
  const [task, setTask] = useState(liveTask);
  const [deviceZone] = useState(() => detectDeviceTimeZone() ?? 'UTC');
  const initialZone = task.scheduled_time_zone ?? deviceZone;
  const [enabled, setEnabled] = useState(Boolean(task.scheduled_start_at));
  const [zone, setZone] = useState(initialZone);
  const [zoneDraft, setZoneDraft] = useState(initialZone);
  const [start, setStart] = useState(task.scheduled_start_at ? localDateTime(task.scheduled_start_at, initialZone) : '');
  const [end, setEnd] = useState(task.scheduled_end_at ? localDateTime(task.scheduled_end_at, initialZone) : '');
  const [startChoice, setStartChoice] = useState(initialChoice(task.scheduled_start_at, initialZone));
  const [endChoice, setEndChoice] = useState(initialChoice(task.scheduled_end_at, initialZone));
  const [exactStart, setExactStart] = useState(
    task.scheduled_start_at
      ? {
          wall: localDateTime(task.scheduled_start_at, initialZone),
          zone: initialZone,
          choice: initialChoice(task.scheduled_start_at, initialZone),
          instant: task.scheduled_start_at,
        }
      : null,
  );
  const [exactEnd, setExactEnd] = useState(
    task.scheduled_end_at
      ? {
          wall: localDateTime(task.scheduled_end_at, initialZone),
          zone: initialZone,
          choice: initialChoice(task.scheduled_end_at, initialZone),
          instant: task.scheduled_end_at,
        }
      : null,
  );
  const [moveStart, setMoveStart] = useState('');
  const [moveChoice, setMoveChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const blocked = disabled || busy;
  const unchanged =
    enabled === Boolean(task.scheduled_start_at) &&
    (!enabled ||
      (zone === initialZone &&
        start === localDateTime(task.scheduled_start_at!, initialZone) &&
        end === localDateTime(task.scheduled_end_at!, initialZone) &&
        startChoice === initialChoice(task.scheduled_start_at, initialZone) &&
        endChoice === initialChoice(task.scheduled_end_at, initialZone)));

  function resolved() {
    // Preserve exact stored seconds when no wall-clock edit was made.
    const originalStart = exactStart && zone === exactStart.zone && start === exactStart.wall && startChoice === exactStart.choice;
    const originalEnd = exactEnd && zone === exactEnd.zone && end === exactEnd.wall && endChoice === exactEnd.choice;
    return {
      start: originalStart ? exactStart.instant : resolveLocalInstant(start, zone, startChoice),
      end: originalEnd ? exactEnd.instant : resolveLocalInstant(end, zone, endChoice),
    };
  }

  function applyZone() {
    if (blocked) return;
    setError(null);
    if (!validTimeZone(zoneDraft)) {
      setError('Escribe una zona horaria IANA válida, por ejemplo America/La_Paz.');
      return;
    }
    if (start || end) {
      try {
        const instants = resolved();
        setStart(localDateTime(instants.start, zoneDraft));
        setEnd(localDateTime(instants.end, zoneDraft));
        setStartChoice(initialChoice(instants.start, zoneDraft));
        setEndChoice(initialChoice(instants.end, zoneDraft));
        setExactStart({
          wall: localDateTime(instants.start, zoneDraft),
          zone: zoneDraft,
          choice: initialChoice(instants.start, zoneDraft),
          instant: instants.start,
        });
        setExactEnd({ wall: localDateTime(instants.end, zoneDraft), zone: zoneDraft, choice: initialChoice(instants.end, zoneDraft), instant: instants.end });
      } catch (cause) {
        setError(errorMessage(cause));
        return;
      }
    }
    setZone(zoneDraft);
    setMoveStart('');
    setMoveChoice('');
    setNotice('Zona aplicada; los instantes del bloque se conservan.');
  }

  function move() {
    if (blocked) return;
    setError(null);
    try {
      const instants = resolved();
      const next = moveBlock(instants.start, instants.end, resolveLocalInstant(moveStart, zone, moveChoice));
      setStart(localDateTime(next.start, zone));
      setEnd(localDateTime(next.end, zone));
      setStartChoice(initialChoice(next.start, zone));
      setEndChoice(initialChoice(next.end, zone));
      setExactStart({ wall: localDateTime(next.start, zone), zone, choice: initialChoice(next.start, zone), instant: next.start });
      setExactEnd({ wall: localDateTime(next.end, zone), zone, choice: initialChoice(next.end, zone), instant: next.end });
      setMoveStart('');
      setMoveChoice('');
      setNotice('Nuevo inicio aplicado al borrador; se conservó la duración. Guarda el bloque para confirmarlo.');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function save() {
    if (blocked || lock.current || unchanged) return;
    setError(null);
    setNotice('');
    let input: { scheduled_start_at: string | null; scheduled_end_at: string | null; scheduled_time_zone: string | null };
    try {
      if (enabled) {
        if (zoneDraft !== zone) throw new Error('Aplica la zona escrita antes de guardar el bloque.');
        if (!start || !end) throw new Error('Completa el inicio y el fin del bloque.');
        const instants = resolved();
        if (instantMicroseconds(instants.end) <= instantMicroseconds(instants.start)) throw new Error('El fin del bloque debe ser posterior al inicio.');
        input = { scheduled_start_at: instants.start, scheduled_end_at: instants.end, scheduled_time_zone: zone };
      } else input = { scheduled_start_at: null, scheduled_end_at: null, scheduled_time_zone: null };
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }
    lock.current = true;
    setBusy(true);
    try {
      const saved = await api.scheduleTask(task, input);
      onSaved(task, saved);
      setTask(saved);
      setNotice('Bloque horario guardado.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="pw-calendar-schedule" aria-label="Programación de la tarea">
      <h3>Bloque de trabajo</h3>
      <p className="faint">Opcional e independiente del vencimiento. Los cambios del bloque se guardan por separado.</p>
      {liveTask.version !== task.version && (
        <div className="pw-info">
          <p>La tarea cambió desde que abriste la programación. Tu borrador se conserva; revisa sus datos antes de guardar.</p>
          <button type="button" className="btn btn-secondary btn-sm" disabled={blocked} onClick={() => setTask(liveTask)}>
            Revisé la tarea; usar la versión actual para el bloque
          </button>
        </div>
      )}
      <label className="pw-calendar-check">
        <input type="checkbox" checked={enabled} disabled={blocked} onChange={event => setEnabled(event.target.checked)} />
        Programar un bloque horario
      </label>
      {enabled && (
        <>
          <div className="pw-calendar-zone-editor">
            <TimeZonePicker label="Zona del bloque" value={zoneDraft} onChange={setZoneDraft} disabled={blocked} />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={blocked || zoneDraft === zone || !validTimeZone(zoneDraft)}
              onClick={applyZone}
            >
              Aplicar zona
            </button>
          </div>
          <p className="faint">Horas en {zone}. Cambiar la zona conserva los instantes; editar las horas los modifica.</p>
          <div className="pw-field-grid">
            <label className="pw-field">
              Inicio del bloque
              <input
                type="datetime-local"
                value={start}
                disabled={blocked}
                onChange={event => {
                  setStart(event.target.value);
                  setStartChoice('');
                }}
              />
            </label>
            <label className="pw-field">
              Fin del bloque
              <input
                type="datetime-local"
                value={end}
                disabled={blocked}
                onChange={event => {
                  setEnd(event.target.value);
                  setEndChoice('');
                }}
              />
            </label>
            <OffsetChoice label="Inicio" value={start} zone={zone} selected={startChoice} disabled={blocked} onChange={setStartChoice} />
            <OffsetChoice label="Fin" value={end} zone={zone} selected={endChoice} disabled={blocked} onChange={setEndChoice} />
          </div>
          {task.due_date && end.slice(0, 10) > task.due_date && (
            <p className="pw-calendar-validation">Este bloque termina después del vencimiento. El vencimiento se conservará.</p>
          )}
          <details className="pw-calendar-move">
            <summary>Mover el bloque conservando su duración</summary>
            <label className="pw-field">
              Nuevo inicio del bloque
              <input
                type="datetime-local"
                value={moveStart}
                disabled={blocked}
                onChange={event => {
                  setMoveStart(event.target.value);
                  setMoveChoice('');
                }}
              />
            </label>
            <OffsetChoice label="Nuevo inicio" value={moveStart} zone={zone} selected={moveChoice} disabled={blocked} onChange={setMoveChoice} />
            <button type="button" className="btn btn-secondary btn-sm" disabled={blocked || !moveStart} onClick={move}>
              Aplicar nuevo inicio
            </button>
          </details>
        </>
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {notice && <p role="status">{notice}</p>}
      <button type="button" className="btn btn-secondary btn-sm" disabled={blocked || unchanged} onClick={() => void save()}>
        {busy ? 'Guardando…' : 'Guardar bloque horario'}
      </button>
    </section>
  );
}
