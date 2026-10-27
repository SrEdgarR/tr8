import { useId, type CSSProperties } from 'react';
import { Check, CircleCheck, Monitor, Moon, Palette, PanelLeft, RotateCcw, Rows3, Sun, Waves } from 'lucide-react';
import type { AppearancePreferences } from './appearance';
import type { AppearanceController } from './useAppearance';
import SettingsDisclosure from './SettingsDisclosure';
import './appearance.css';

const themes = [
  { id: 'light', label: 'Claro', icon: Sun },
  { id: 'dark', label: 'Oscuro', icon: Moon },
  { id: 'system', label: 'Sistema', icon: Monitor },
] as const;

const accents = [
  { id: 'indigo', label: 'Índigo', color: '#4B5BD6' },
  { id: 'blue', label: 'Azul', color: '#2F6CD4' },
  { id: 'violet', label: 'Violeta', color: '#7348CC' },
  { id: 'teal', label: 'Verde azulado', color: '#1A7F7A' },
  { id: 'rose', label: 'Rosa', color: '#B93D68' },
  { id: 'graphite', label: 'Grafito', color: '#34332F' },
] as const;

function ThemePreview({ theme }: { theme: AppearancePreferences['theme'] }) {
  if (theme === 'system')
    return (
      <span className="pw-theme-system" aria-hidden="true">
        <ThemePreview theme="light" />
        <ThemePreview theme="dark" />
      </span>
    );
  return (
    <span className={`pw-theme-preview is-${theme}`} aria-hidden="true">
      <span className="pw-theme-preview-side">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="pw-theme-preview-main">
        <i />
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

function DensityChoice({
  label,
  value,
  onChange,
}: {
  label: string;
  value: AppearancePreferences['taskDensity'];
  onChange: (value: AppearancePreferences['taskDensity']) => void;
}) {
  const name = useId();
  return (
    <fieldset className="pw-appearance-segment">
      <legend className="sr">{label}</legend>
      {(
        [
          ['comfortable', 'Cómoda'],
          ['compact', 'Compacta'],
        ] as const
      ).map(([id, text]) => (
        <label key={id}>
          <input type="radio" name={name} value={id} checked={value === id} onChange={() => onChange(id)} />
          <span>{text}</span>
        </label>
      ))}
    </fieldset>
  );
}

export default function AppearanceSettings({ appearance }: { appearance: AppearanceController }) {
  const themeName = useId();
  const accentName = useId();
  const motionId = useId();
  const { preferences, update } = appearance;
  return (
    <div className="pw-appearance">
      <SettingsDisclosure
        title="Tema"
        description="Elige una apariencia clara, oscura o la de tu dispositivo."
        icon={<Monitor size={18} />}
        value={themes.find(theme => theme.id === preferences.theme)?.label}
      >
        <fieldset className="pw-theme-options">
          <legend className="sr">Tema de TR8</legend>
          {themes.map(({ id, label, icon: Icon }) => (
            <label key={id} className="pw-theme-option">
              <input type="radio" name={themeName} value={id} checked={preferences.theme === id} onChange={() => update({ theme: id })} />
              <span className="pw-theme-option-body">
                <ThemePreview theme={id} />
                <span className="pw-theme-option-label">
                  <Icon size={15} aria-hidden="true" />
                  {label}
                  {preferences.theme === id && <CircleCheck size={15} className="pw-theme-check" aria-hidden="true" />}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      </SettingsDisclosure>
      <SettingsDisclosure
        title="Color de acento"
        description="Se aplica a botones principales, selección y foco."
        icon={<Palette size={18} />}
        value={accents.find(accent => accent.id === preferences.accent)?.label}
      >
        <fieldset className="pw-appearance-accents">
          <legend className="sr">Color de acento</legend>
          {accents.map(({ id, label, color }) => (
            <label key={id} title={label} className="pw-appearance-accent" style={{ '--appearance-swatch': color } as CSSProperties}>
              <input
                type="radio"
                name={accentName}
                value={id}
                checked={preferences.accent === id}
                onChange={() => update({ accent: id })}
                aria-label={`Acento ${label}`}
              />
              <span className="pw-appearance-swatch">{preferences.accent === id && <Check size={16} aria-hidden="true" />}</span>
              <span className="pw-appearance-accent-label">{label}</span>
            </label>
          ))}
        </fieldset>
      </SettingsDisclosure>
      <SettingsDisclosure title="Densidad" description="Ajusta el espacio de navegación, listas y tarjetas." icon={<Rows3 size={18} />}>
        <div className="pw-appearance-row">
          <span className="pw-appearance-row-copy">
            <strong>
              <PanelLeft size={15} aria-hidden="true" /> Barra lateral
            </strong>
            <span>La opción compacta muestra más proyectos.</span>
          </span>
          <DensityChoice label="Densidad de la barra lateral" value={preferences.sidebarDensity} onChange={sidebarDensity => update({ sidebarDensity })} />
        </div>
        <div className="pw-appearance-row">
          <span className="pw-appearance-row-copy">
            <strong>
              <Rows3 size={15} aria-hidden="true" /> Tareas
            </strong>
            <span>Altura de las filas y espacio de las tarjetas.</span>
          </span>
          <DensityChoice label="Densidad de tareas" value={preferences.taskDensity} onChange={taskDensity => update({ taskDensity })} />
        </div>
      </SettingsDisclosure>
      <SettingsDisclosure title="Movimiento" description="Controla las animaciones y transiciones de TR8." icon={<Waves size={18} />}>
        <div className="pw-appearance-row">
          <div className="pw-appearance-row-copy">
            <label htmlFor={motionId}>Animaciones</label>
            <span id={`${motionId}-description`}>La opción Sistema respeta la accesibilidad del dispositivo.</span>
          </div>
          <select
            id={motionId}
            aria-describedby={`${motionId}-description`}
            value={preferences.motion}
            onChange={event => update({ motion: event.target.value as AppearancePreferences['motion'] })}
          >
            <option value="system">Seguir al sistema</option>
            <option value="reduce">Reducir movimiento</option>
          </select>
        </div>
      </SettingsDisclosure>
      <div className="pw-appearance-footer">
        <p role="status">
          {appearance.persisted
            ? 'Ajustes guardados para tu cuenta en este navegador.'
            : 'Los ajustes se aplican a esta pestaña. El navegador no permite guardarlos.'}
        </p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={appearance.reset}>
          <RotateCcw size={13} aria-hidden="true" />
          Restablecer apariencia
        </button>
      </div>
    </div>
  );
}
