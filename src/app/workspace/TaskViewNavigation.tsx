import {
  Activity,
  Archive,
  CalendarDays,
  ChartGantt,
  ChevronDown,
  LayoutDashboard,
  List,
  Paperclip,
  SquareKanban,
  Table2,
  type LucideIcon,
} from 'lucide-react';

interface Props {
  view: string;
  disabled: boolean;
  onChange: (view: string) => void;
  summary: boolean;
  calendar: boolean;
  timeline: boolean;
  files: boolean;
  activity: boolean;
  archived: boolean;
}

export default function TaskViewNavigation({ view, disabled, onChange, ...available }: Props) {
  const views: { id: string; name: string; icon: LucideIcon; enabled: boolean }[] = [
    { id: 'overview', name: 'Resumen', icon: LayoutDashboard, enabled: available.summary },
    { id: 'list', name: 'Lista', icon: List, enabled: true },
    { id: 'board', name: 'Tablero', icon: SquareKanban, enabled: true },
    { id: 'table', name: 'Tabla', icon: Table2, enabled: true },
    { id: 'calendar', name: 'Calendario', icon: CalendarDays, enabled: available.calendar },
    { id: 'timeline', name: 'Timeline', icon: ChartGantt, enabled: available.timeline },
    { id: 'files', name: 'Archivos', icon: Paperclip, enabled: available.files },
    { id: 'activity', name: 'Actividad', icon: Activity, enabled: available.activity },
    { id: 'archived', name: 'Archivadas', icon: Archive, enabled: available.archived },
  ].filter(item => item.enabled);
  const ActiveIcon = views.find(item => item.id === view)?.icon ?? List;

  return (
    <div className="pw-view-navigation">
      <div className="pw-view-tabs" aria-label="Vista de tareas">
        {views.map(({ id, name, icon: Icon }) => (
          <button
            key={id}
            className={`pw-view-tab${id === 'archived' ? ' wm-archive-tab' : ''}${view === id ? ' on' : ''}`}
            aria-pressed={view === id}
            disabled={disabled}
            onClick={() => onChange(id)}
          >
            <Icon size={15} aria-hidden="true" />
            {name}
          </button>
        ))}
      </div>
      <label className="pw-mobile-view-picker">
        <ActiveIcon size={18} aria-hidden="true" />
        <span className="sr">Cambiar vista de tareas</span>
        <select value={view} disabled={disabled} onChange={event => onChange(event.target.value)}>
          {views.map(item => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <ChevronDown size={15} aria-hidden="true" />
      </label>
    </div>
  );
}
