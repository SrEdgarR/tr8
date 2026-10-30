import { useState, type ReactNode } from 'react';
import { Activity, Check, ChevronDown, CircleCheck, Globe2, LoaderCircle, Palette, Plug, Save, SlidersHorizontal, UserRound } from 'lucide-react';
import type { CalendarApi } from '../types';
import { validTimeZone } from './CalendarTime';
import TimeZonePicker from './TimeZonePicker';
import useCalendarZonePreferences from './useCalendarZonePreferences';
import { Busy, ErrorNotice } from './ui';
import { errorMessage } from './helpers';
import SettingsDisclosure from './SettingsDisclosure';
import AppearanceSettings from './AppearanceSettings';
import type { AppearanceController } from './useAppearance';
import './settings.css';
import './planning-mobile.css';

type ZoneState = ReturnType<typeof useCalendarZonePreferences>;

export function CalendarZoneEditor({ state, initial = false, embedded = false }: { state: ZoneState; initial?: boolean; embedded?: boolean }) {
  const { profile, detectedZone, zone, zoneDraft, setZoneInput, zoneNotice, zoneError, savingZone, saveZone } = state;
  const Container = embedded ? 'div' : 'section';
  return (
    <>
      <Container className={`pw-calendar-zone${embedded ? ' is-embedded' : ''}`} aria-label={embedded ? undefined : 'Zona horaria del calendario'}>
        {!embedded && (
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
        )}
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
      </Container>
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
  return (
    <SettingsDisclosure
      title="Zona horaria"
      description="Define cómo ves las fechas y horas de tus proyectos."
      icon={<Globe2 size={18} />}
      value={state.profile.isPending ? 'Comprobando…' : (state.zone ?? 'Por configurar')}
    >
      {api.accessError ? (
        <ErrorNotice>
          {api.accessError}
          <button className="btn btn-secondary btn-sm" onClick={() => void api.retryAccess?.()}>
            Revisar acceso a preferencias
          </button>
        </ErrorNotice>
      ) : (
        <CalendarZoneEditor state={state} embedded />
      )}
    </SettingsDisclosure>
  );
}

const categories = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, group: 'Personal' },
  { id: 'appearance', label: 'Apariencia', icon: Palette, group: 'Personal' },
  { id: 'connections', label: 'Conexiones', icon: Plug, group: 'Integraciones' },
  { id: 'activity', label: 'Actividad', icon: Activity, group: 'Integraciones' },
] as const;
type SettingsCategory = (typeof categories)[number]['id'];

export default function CalendarSettings({
  api,
  processes,
  integrations,
  appearance,
}: {
  api?: CalendarApi;
  processes?: ReactNode;
  integrations?: ReactNode;
  appearance?: AppearanceController;
}) {
  const [category, setCategory] = useState<SettingsCategory>('general');
  const [visited, setVisited] = useState<SettingsCategory[]>(['general']);
  const CurrentCategoryIcon = categories.find(item => item.id === category)?.icon ?? SlidersHorizontal;
  function changeCategory(next: SettingsCategory) {
    setCategory(next);
    setVisited(previous => (previous.includes(next) ? previous : [...previous, next]));
  }
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
      <div className="pw-settings-layout">
        <label className="pw-settings-mobile-category">
          <span>Sección de configuración</span>
          <span className="pw-settings-mobile-category-input">
            <CurrentCategoryIcon size={18} aria-hidden="true" />
            <select value={category} onChange={event => changeCategory(event.target.value as SettingsCategory)}>
              {categories.map(item => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <ChevronDown size={15} aria-hidden="true" />
          </span>
        </label>
        <nav className="pw-settings-nav" aria-label="Categorías de configuración">
          {['Personal', 'Integraciones'].map(group => (
            <div className="pw-settings-nav-group" key={group}>
              <p>{group}</p>
              {categories
                .filter(item => item.group === group)
                .map(({ id, label, icon: Icon }) => (
                  <button
                    type="button"
                    key={id}
                    className={category === id ? 'is-current' : ''}
                    aria-current={category === id ? 'page' : undefined}
                    aria-controls={`tr8-settings-${id}`}
                    onClick={() => changeCategory(id)}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <div className="pw-settings-content">
          <section id="tr8-settings-general" className="pw-settings-category" aria-label="Configuración general" hidden={category !== 'general'}>
            <header className="pw-settings-category-heading">
              <h2>General</h2>
              <p>Las preferencias que se aplican a tu cuenta.</p>
            </header>
            {api ? (
              <SavedZoneSettings key={api.scopeKey.join(':')} api={api} />
            ) : (
              <p className="faint">Las preferencias del calendario no están disponibles en este momento.</p>
            )}
          </section>
          <section id="tr8-settings-appearance" className="pw-settings-category" aria-label="Configuración de apariencia" hidden={category !== 'appearance'}>
            <header className="pw-settings-category-heading">
              <h2>Apariencia</h2>
              <p>Personaliza el aspecto de TR8 en este navegador.</p>
            </header>
            {visited.includes('appearance') &&
              (appearance ? (
                <AppearanceSettings appearance={appearance} />
              ) : (
                <p className="faint">Las preferencias de apariencia no están disponibles en este momento.</p>
              ))}
          </section>
          <section id="tr8-settings-connections" className="pw-settings-category" aria-label="Conexiones de la cuenta" hidden={category !== 'connections'}>
            <header className="pw-settings-category-heading">
              <h2>Conexiones</h2>
              <p>Conecta tus plataformas y gestiona sus permisos desde un solo lugar.</p>
            </header>
            {visited.includes('connections') && (integrations ?? <p className="faint">No hay conexiones disponibles en este momento.</p>)}
          </section>
          <section id="tr8-settings-activity" className="pw-settings-category" aria-label="Actividad de los procesos" hidden={category !== 'activity'}>
            <header className="pw-settings-category-heading">
              <h2>Actividad</h2>
              <p>Consulta el procesamiento de tus cambios en segundo plano.</p>
            </header>
            {visited.includes('activity') &&
              (processes ? (
                <SettingsDisclosure
                  title="Procesos en segundo plano"
                  description="Estado e historial de los cambios preparados por TR8."
                  icon={<Activity size={18} />}
                >
                  {processes}
                </SettingsDisclosure>
              ) : (
                <p className="faint">El estado de los procesos no está disponible en este momento.</p>
              ))}
          </section>
        </div>
      </div>
    </div>
  );
}
