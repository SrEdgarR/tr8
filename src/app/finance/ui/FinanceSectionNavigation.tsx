import { CalendarClock, ChevronDown, LayoutGrid, List, ShieldCheck, Wallet } from 'lucide-react';

const sections = [
  { name: 'Resumen', icon: LayoutGrid },
  { name: 'Cuentas', icon: Wallet },
  { name: 'Movimientos', icon: List },
  { name: 'Planes', icon: CalendarClock },
  { name: 'Seguridad', icon: ShieldCheck },
];

export default function FinanceSectionNavigation({ selected, onChange }: { selected: string; onChange: (section: string) => void }) {
  const Icon = sections.find(section => section.name === selected)?.icon ?? LayoutGrid;
  return (
    <div className="tf-section-navigation">
      <nav className="pw-view-tabs tf-project-tabs" aria-label="Secciones de finanzas">
        {sections.map(({ name, icon: SectionIcon }) => (
          <button
            type="button"
            key={name}
            className={`pw-view-tab${selected === name ? ' on' : ''}`}
            aria-pressed={selected === name}
            onClick={() => onChange(name)}
          >
            <SectionIcon size={15} aria-hidden="true" />
            {name}
          </button>
        ))}
      </nav>
      <label className="tf-mobile-section-picker">
        <span className="sr">Cambiar sección de finanzas</span>
        <Icon size={18} aria-hidden="true" />
        <select value={selected} onChange={event => onChange(event.target.value)}>
          {sections.map(section => (
            <option key={section.name}>{section.name}</option>
          ))}
        </select>
        <ChevronDown size={15} aria-hidden="true" />
      </label>
    </div>
  );
}
