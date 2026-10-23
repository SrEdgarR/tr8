import { useEffect, useId, useMemo, useState } from 'react';
import { timeZoneClock, validTimeZone } from './CalendarTime';
import { loadTimeZoneCatalog, searchTimeZones, type TimeZoneCatalog } from './timeZones';

/** A place is a search query; only an explicit IANA choice is a saved value. */
export default function TimeZonePicker({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<TimeZoneCatalog | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [active, setActive] = useState(-1);
  const [now, setNow] = useState(() => new Date());
  const resolved = validTimeZone(value);
  const results = useMemo(() => (catalog && value.trim().length >= 2 ? searchTimeZones(catalog, value, { limit: 12 }) : null), [catalog, value]);
  const expanded = open && !disabled;
  const options = results?.options ?? [];
  const clock = resolved ? timeZoneClock(value, now) : null;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open || catalog) return;
    let current = true;
    void loadTimeZoneCatalog().then(
      data => {
        if (current) {
          setCatalog(data);
          setLoadError(false);
        }
      },
      () => {
        if (current) setLoadError(true);
      },
    );
    return () => {
      current = false;
    };
  }, [open, catalog]);

  function select(zone: string) {
    onChange(zone);
    setOpen(false);
    setActive(-1);
  }

  return (
    <div className="pw-time-zone-picker">
      <label className="pw-field" htmlFor={id}>
        {label}
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={`${id}-options`}
          aria-activedescendant={expanded && active >= 0 && options[active] ? `${id}-option-${active}` : undefined}
          aria-describedby={`${id}-hint ${id}-preview`}
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
          }}
          onChange={event => {
            onChange(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={event => {
            if (event.key === 'Escape' && expanded) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              setActive(-1);
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
              setActive(index =>
                options.length
                  ? index < 0
                    ? event.key === 'ArrowDown'
                      ? 0
                      : options.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
                  : -1,
              );
            }
            if (event.key === 'Enter' && expanded && active >= 0 && options[active]) {
              event.preventDefault();
              select(options[active].timeZone);
            }
          }}
          placeholder="País, ciudad o zona horaria"
        />
      </label>
      <p id={`${id}-hint`} className="pw-time-zone-hint">
        Busca un país o ciudad, o escribe una zona como America/La_Paz.
      </p>
      {expanded && (
        <div className="pw-time-zone-results">
          {results?.countryMatch && (
            <p>
              {results.countryMatch.name}:{' '}
              {results.countryMatch.timeZoneCount === 1 ? 'una zona horaria' : `${results.countryMatch.timeZoneCount} zonas horarias`}. Elige una opción.
            </p>
          )}
          <ul id={`${id}-options`} role="listbox" aria-label="Zonas horarias encontradas">
            {options.map((option, index) => {
              const local = timeZoneClock(option.timeZone, now);
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    role="option"
                    id={`${id}-option-${index}`}
                    aria-selected={active === index}
                    tabIndex={-1}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => select(option.timeZone)}
                  >
                    <strong>{option.label}</strong>
                    <span>{option.timeZone}</span>
                    <span>
                      {local.time} · {local.offset}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!catalog && !loadError && <p role="status">Cargando países y ciudades…</p>}
          {loadError && <p role="status">No se pudo cargar la búsqueda. Puedes escribir una zona IANA o volver a abrir el campo para reintentar.</p>}
          {catalog && !results && <p>Escribe al menos dos caracteres para buscar.</p>}
          {results && !options.length && <p>No encontramos ese lugar. Prueba una ciudad cercana o escribe su zona IANA.</p>}
          {results && results.total > options.length && (
            <p>
              Mostrando {options.length} de {results.total} opciones. Añade el país o más letras para precisar.
            </p>
          )}
          <p className="pw-time-zone-sources">
            Lugares:{' '}
            <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">
              GeoNames
            </a>{' '}
            · Zonas:{' '}
            <a href="https://www.iana.org/time-zones" target="_blank" rel="noreferrer">
              IANA
            </a>
          </p>
        </div>
      )}
      <div id={`${id}-preview`} className="pw-time-zone-preview" aria-label="Fecha y hora de la zona seleccionada">
        {clock ? (
          <>
            <strong>
              {clock.time} · {clock.offset}
            </strong>
            <span>{clock.date}</span>
            <span>{value}</span>
          </>
        ) : (
          <span>Selecciona una zona de los resultados para ver su fecha y hora actuales.</span>
        )}
      </div>
    </div>
  );
}
