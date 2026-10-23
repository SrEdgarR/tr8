import type { ReactNode } from 'react';
import { Check, CircleCheck, Globe2, LoaderCircle, Save, SlidersHorizontal, UserRound } from 'lucide-react';
import type { CalendarApi } from '../types';
import { validTimeZone } from './CalendarTime';
import TimeZonePicker from './TimeZonePicker';
import useCalendarZonePreferences from './useCalendarZonePreferences';
import { Busy, ErrorNotice } from './ui';
import { errorMessage } from './helpers';

type ZoneState = ReturnType<typeof useCalendarZonePreferences>;

export function CalendarZoneEditor({ state, initial = false }: { state: ZoneState; initial?: boolean }) {
  const { profile, detectedZone, zone, zoneDraft, setZoneInput, zoneNotice, zoneError, savingZone, saveZone } = state;
  return (
    <>
      <section className="pw-calendar-zone" aria-label="Zona horaria del calendario">
        <div className="pw-calendar-zone-heading">
          <span className="pw-calendar-zone-icon">
            <Globe2 size={18} aria-hidden="true" />
          </span>
          <div className="pw-calendar-zone-title">
            <h2>Zona horaria</h2>
            <p className="faint">
              {zone
                ? 'Elige cómo ves las fechas y horas de tus proyectos.'
                : initial && detectedZone
                  ? 'Usamos la zona de tu dispositivo en el primer acceso.'
                  : initial
                    ? 'No pudimos detectar la zona del dispositivo. Elige una para empezar.'
                    : 'Busca tu ciudad o país y comprueba su hora antes de guardar.'}
            </p>
          </div>
          <span className="pw-calendar-zone-personal">
            <UserRound size={12} aria-hidden="true" />
            Personal
          </span>
        </div>
        <TimeZonePicker
          label="Zona horaria de visualización"
          value={zoneDraft}
          onChange={setZoneInput}
          disabled={savingZone || profile.isPending || !!profile.error}
        />
        <div className="pw-calendar-zone-footer">
          <span className={`pw-calendar-zone-state${zone && zoneDraft === zone ? ' is-saved' : ''}`}>
            {zone && zoneDraft === zone ? <CircleCheck size={14} aria-hidden="true" /> : <Globe2 size={14} aria-hidden="true" />}
            {zone && zoneDraft === zone ? 'Zona guardada en tu cuenta' : zone ? `Actual: ${zone}` : 'Se aplicará a tu calendario personal'}
          </span>
          <button
            className={`btn btn-sm${validTimeZone(zoneDraft) && zoneDraft !== zone ? ' btn-primary' : ' btn-secondary'}`}
            disabled={savingZone || profile.isPending || !!profile.error || zoneDraft === zone || !validTimeZone(zoneDraft)}
            onClick={saveZone}
          >
            {savingZone ? (
              <LoaderCircle className="pw-spin" size={14} aria-hidden="true" />
            ) : zone && zoneDraft === zone ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <Save size={14} aria-hidden="true" />
            )}
            {savingZone ? 'Guardando…' : zone ? 'Guardar zona' : 'Confirmar zona'}
          </button>
        </div>
        {zoneNotice && (
          <div className="pw-calendar-notice" role="status">
            <CircleCheck size={14} aria-hidden="true" />
            <span>{zoneNotice}</span>
          </div>
        )}
      </section>
      {profile.error && (
        <ErrorNotice>
          {errorMessage(profile.error)}{' '}
          <button className="btn btn-secondary btn-sm" onClick={() => void profile.refetch()}>
            Reintentar zona
          </button>
        </ErrorNotice>
      )}
      {zoneError && <ErrorNotice>{zoneError}</ErrorNotice>}
      {profile.isPending && <Busy>Cargando tu preferencia horaria…</Busy>}
    </>
  );
}

function SavedZoneSettings({ api }: { api: CalendarApi }) {
  const state = useCalendarZonePreferences(api);
  if (api.accessError)
    return (
      <ErrorNotice>
        {api.accessError}
        <button className="btn btn-secondary btn-sm" onClick={() => void api.retryAccess?.()}>
          Revisar acceso a preferencias
        </button>
      </ErrorNotice>
    );
  return <CalendarZoneEditor state={state} />;
}

export default function CalendarSettings({ api, processes }: { api?: CalendarApi; processes?: ReactNode }) {
  return (
    <div className="page pw-settings">
      <div className="ph">
        <div>
          <div className="eyebrow pw-settings-eyebrow">
            <SlidersHorizontal size={13} aria-hidden="true" />
            Preferencias personales
          </div>
          <h1>Configuración</h1>
          <p>Ajusta TR8 a tu forma de trabajar. Estas preferencias solo se aplican a tu cuenta.</p>
        </div>
      </div>
      {api && <SavedZoneSettings key={api.scopeKey.join(':')} api={api} />}
      {processes}
    </div>
  );
}
