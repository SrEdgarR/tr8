import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  CheckCheck,
  Command,
  FileArchive,
  FileImage,
  FileText,
  FolderClosed,
  Layers,
  LoaderCircle,
  MessageSquare,
  Presentation,
  Search,
  Sheet,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { GlobalSearchApi, GlobalSearchPage, GlobalSearchResult, SearchCategory, SearchKind } from '../search-types';
import { SEARCH_MAX_LENGTH, SEARCH_MIN_LENGTH } from '../search-types';
import type { TaskStatus } from '../types';
import { IdentityAvatar, TaskStatusIcon } from './project-identity';
import { Dialog, ErrorNotice, ProjectIcon } from './ui';
import { errorMessage } from './helpers';
import './global-search.css';

export interface SearchCommand {
  id: string;
  label: string;
  description?: string;
  icon: LucideIcon;
  shortcut?: string;
  run: () => void;
  disabled?: boolean;
}

export interface GlobalSearchProps {
  api: GlobalSearchApi;
  mode: 'palette' | 'page';
  initialQuery?: string;
  initialKind?: SearchCategory;
  actions?: SearchCommand[];
  onSelect: (result: GlobalSearchResult) => void;
  onClose?: () => void;
  onShowAll?: (query: string, kind: SearchCategory) => void;
  onQueryChange?: (query: string, kind: SearchCategory) => void;
}

const categories: { kind: SearchCategory; name: string; icon: LucideIcon }[] = [
  { kind: 'all', name: 'Todos', icon: Layers },
  { kind: 'project', name: 'Proyectos', icon: FolderClosed },
  { kind: 'task', name: 'Tareas', icon: CheckCheck },
  { kind: 'member', name: 'Personas', icon: Users },
  { kind: 'file', name: 'Archivos', icon: FileText },
  { kind: 'comment', name: 'Comentarios', icon: MessageSquare },
];
const kinds = categories.slice(1).map(row => row.kind as SearchKind);
const taskStatuses = new Set(['backlog', 'todo', 'progress', 'review', 'done']);

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.toLocaleLowerCase('es');
  if (!needle) return text;
  const lower = text.toLocaleLowerCase('es');
  const parts: ReactNode[] = [];
  let from = 0,
    index = lower.indexOf(needle);
  while (index >= 0) {
    parts.push(text.slice(from, index), <mark key={index}>{text.slice(index, index + query.length)}</mark>);
    from = index + query.length;
    index = lower.indexOf(needle, from);
  }
  parts.push(text.slice(from));
  return parts;
}

function ResultIcon({ row }: { row: GlobalSearchResult }) {
  if (row.kind === 'project') return <ProjectIcon color={row.project_color ?? '#6B7280'} icon={row.project_icon ?? undefined} />;
  if (row.kind === 'member') return <IdentityAvatar name={row.title} small decorative />;
  if (row.kind === 'task' && taskStatuses.has(row.status ?? ''))
    return (
      <span className="gs-kind-icon gs-kind-task">
        <TaskStatusIcon status={row.status as TaskStatus} size={18} />
      </span>
    );
  let Icon: LucideIcon = row.kind === 'comment' ? MessageSquare : FileText;
  let tone: string = row.kind;
  if (row.kind === 'file') {
    if (row.content_type?.startsWith('image/')) {
      Icon = FileImage;
      tone = 'image';
    } else if (row.content_type?.includes('spreadsheet') || row.content_type === 'text/csv') {
      Icon = Sheet;
      tone = 'sheet';
    } else if (row.content_type?.includes('presentation')) {
      Icon = Presentation;
      tone = 'presentation';
    } else if (row.content_type?.includes('zip')) {
      Icon = FileArchive;
      tone = 'zip';
    } else if (row.content_type === 'application/pdf') tone = 'pdf';
  }
  return (
    <span className={`gs-kind-icon gs-kind-${tone}`}>
      <Icon size={17} aria-hidden="true" />
    </span>
  );
}

/** Queries and drafts are replaced on account, workspace, permission or entry-point changes. */
export default function GlobalSearch(props: GlobalSearchProps) {
  return <ScopedGlobalSearch key={JSON.stringify([props.api.scopeKey, props.mode])} {...props} />;
}

function ScopedGlobalSearch({
  api,
  mode,
  initialQuery = '',
  initialKind = 'all',
  actions = [],
  onSelect,
  onClose,
  onShowAll,
  onQueryChange,
}: GlobalSearchProps) {
  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState<SearchCategory>(initialKind);
  const [archived, setArchived] = useState(false);
  const [debounced, setDebounced] = useState('');
  const [typing, setTyping] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prefix = useId();
  const listId = `${prefix}-results`;
  const normalized = query.trim();
  const length = Array.from(normalized).length;
  const controls = Array.from(normalized).some(character => {
    const point = character.codePointAt(0)!;
    return point < 32 || (point >= 127 && point <= 159) || (point >= 0xd800 && point <= 0xdfff);
  });
  const valid = length >= SEARCH_MIN_LENGTH && length <= SEARCH_MAX_LENGTH && !controls;
  const eligible = valid && !typing && debounced === normalized;
  const palette = mode === 'palette';
  const limit = palette ? 5 : kind === 'all' ? 10 : 25;

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebounced(query.trim());
      setTyping(false);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const results = useInfiniteQuery({
    queryKey: [...api.scopeKey, 'global-search', mode, normalized, kind, archived, limit],
    queryFn: async ({ pageParam, signal }) => {
      const page = await api.search({ query: normalized, kind, include_archived: archived, offset: pageParam, limit }, signal);
      if (signal.aborted) throw new DOMException('La búsqueda cambió.', 'AbortError');
      return page;
    },
    initialPageParam: 0,
    getNextPageParam: (page: GlobalSearchPage) => page.next_offset ?? undefined,
    enabled: eligible,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const available = eligible && !results.error && !!results.data && (!results.isFetching || results.isFetchingNextPage);
  const counts = available ? results.data!.pages[0].counts : null;
  const rows = available ? [...new Map(results.data!.pages.flatMap(page => page.items).map(row => [`${row.kind}:${row.id}`, row])).values()] : [];
  const total = counts ? Object.values(counts).reduce((sum, count) => sum + count, 0) : null;
  const commands = palette
    ? actions.filter(row => !normalized || `${row.label} ${row.description ?? ''}`.toLocaleLowerCase('es').includes(normalized.toLocaleLowerCase('es')))
    : [];
  const entries = [
    ...commands.filter(command => !command.disabled).map(command => ({ id: `command-${command.id}`, run: () => execute(command) })),
    ...rows.map(row => ({ id: `${row.kind}-${row.id}`, run: () => select(row) })),
  ];
  const selectedIndex = entries.findIndex(entry => entry.id === activeId);
  const selected = selectedIndex >= 0 ? entries[selectedIndex] : entries[0];
  const searching = eligible && results.isFetching && !results.isFetchingNextPage;

  function changeQuery(value: string) {
    if (value === query) return;
    setQuery(value);
    setTyping(true);
    setActiveId(null);
    setActionError(null);
    if (!palette) onQueryChange?.(value, kind);
  }
  function changeKind(value: SearchCategory) {
    setKind(value);
    setActiveId(null);
    setActionError(null);
    if (!palette) onQueryChange?.(query, value);
    inputRef.current?.focus();
  }
  function select(row: GlobalSearchResult) {
    if (palette) onClose?.();
    onSelect(row);
  }
  function execute(command: SearchCommand) {
    if (command.disabled) return;
    onClose?.();
    try {
      command.run();
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }
  function showAll() {
    onClose?.();
    onShowAll?.(normalized, kind);
  }
  function keyboard(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && palette) {
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!entries.length) return;
      const current = selectedIndex >= 0 ? selectedIndex : 0;
      const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
      setActiveId(entries[next].id);
      document.getElementById(`${prefix}-${entries[next].id}`)?.scrollIntoView?.({ block: 'nearest' });
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault();
      selected.run();
    }
  }

  const content = (
    <>
      <div className="gs-search-area">
        <label className="gs-input-wrap">
          <Search size={19} aria-hidden="true" />
          <span className="sr">Buscar en TR8</span>
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-label="Buscar en TR8"
            placeholder={palette ? 'Busca o escribe una acción…' : 'Buscar proyectos, tareas, personas, archivos y comentarios…'}
            value={query}
            onChange={event => changeQuery(event.target.value)}
            onKeyDown={keyboard}
            autoComplete="off"
            spellCheck={false}
            data-initial-focus
            aria-expanded={entries.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={selected ? `${prefix}-${selected.id}` : undefined}
            aria-describedby={`${prefix}-help`}
          />
          {searching ? <LoaderCircle size={16} className="pw-spin" aria-label="Buscando" /> : palette ? <kbd>Esc</kbd> : null}
        </label>
        <div className="gs-controls">
          <div className="gs-categories" aria-label="Tipos de resultado">
            {categories.map(category => (
              <button
                key={category.kind}
                type="button"
                aria-label={`${category.name}${counts ? ` ${category.kind === 'all' ? total : counts[category.kind]}` : ''}`}
                className={kind === category.kind ? 'on' : ''}
                aria-pressed={kind === category.kind}
                onClick={() => changeKind(category.kind)}
              >
                <category.icon size={13} aria-hidden="true" />
                <span>{category.name}</span>
                {counts && <span className="gs-count">{category.kind === 'all' ? total : counts[category.kind]}</span>}
              </button>
            ))}
          </div>
          <label className="gs-archived">
            <input
              type="checkbox"
              checked={archived}
              onChange={event => {
                setArchived(event.target.checked);
                setActiveId(null);
              }}
            />
            <Archive size={12} aria-hidden="true" />
            Incluir archivados
          </label>
        </div>
      </div>
      <div className="gs-results" id={listId} role="listbox" aria-label="Resultados y acciones" aria-busy={searching}>
        {commands.length > 0 && (
          <div className="gs-group" role="group" aria-label="Acciones rápidas">
            <div className="gs-group-title">
              <Command size={12} aria-hidden="true" />
              <h2>Acciones rápidas</h2>
            </div>
            {commands.map(command => (
              <button
                key={command.id}
                type="button"
                role="option"
                id={`${prefix}-command-${command.id}`}
                aria-selected={selected?.id === `command-${command.id}`}
                tabIndex={palette ? -1 : 0}
                disabled={command.disabled}
                className={`gs-option${selected?.id === `command-${command.id}` ? ' is-selected' : ''}`}
                onMouseEnter={() => setActiveId(`command-${command.id}`)}
                onClick={() => execute(command)}
              >
                <span className="gs-command-icon">
                  <command.icon size={16} aria-hidden="true" />
                </span>
                <span className="gs-option-content">
                  <strong>
                    <Highlight text={command.label} query={normalized} />
                  </strong>
                  {command.description && <span className="gs-secondary">{command.description}</span>}
                </span>
                {command.shortcut && <kbd>{command.shortcut}</kbd>}
                <ArrowUpRight size={13} className="gs-open-icon" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
        {searching && (
          <div className="gs-state" role="status">
            <LoaderCircle size={20} className="pw-spin" aria-hidden="true" />
            <p>Buscando en tu espacio…</p>
          </div>
        )}
        {results.error && eligible && (
          <div className="gs-state">
            <ErrorNotice>{errorMessage(results.error)}</ErrorNotice>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void results.refetch()}>
              Reintentar búsqueda
            </button>
          </div>
        )}
        {actionError && <ErrorNotice>{actionError}</ErrorNotice>}
        {available &&
          kinds.map(groupKind => {
            const group = rows.filter(row => row.kind === groupKind);
            if (!group.length) return null;
            const category = categories.find(row => row.kind === groupKind)!;
            return (
              <div className="gs-group" key={groupKind} role="group" aria-label={category.name}>
                <div className="gs-group-title">
                  <category.icon size={12} aria-hidden="true" />
                  <h2>{category.name}</h2>
                  <span>{counts![groupKind]}</span>
                  {kind === 'all' && counts![groupKind] > group.length && (
                    <button type="button" className="gs-see-category" onClick={() => changeKind(groupKind)}>
                      Ver todos
                      <ArrowUpRight size={12} aria-hidden="true" />
                    </button>
                  )}
                </div>
                {group.map(row => (
                  <button
                    key={`${row.kind}:${row.id}`}
                    type="button"
                    role="option"
                    id={`${prefix}-${row.kind}-${row.id}`}
                    aria-selected={selected?.id === `${row.kind}-${row.id}`}
                    tabIndex={palette ? -1 : 0}
                    className={`gs-option gs-result${selected?.id === `${row.kind}-${row.id}` ? ' is-selected' : ''}`}
                    onMouseEnter={() => setActiveId(`${row.kind}-${row.id}`)}
                    onClick={() => select(row)}
                  >
                    <ResultIcon row={row} />
                    <span className="gs-option-content">
                      <strong>
                        <Highlight text={row.title} query={normalized} />
                      </strong>
                      {row.snippet && (
                        <span className="gs-snippet">
                          <Highlight text={row.snippet} query={normalized} />
                        </span>
                      )}
                      <span className="gs-secondary">
                        {row.author_name && <span>{row.author_name}</span>}
                        {row.project_name && row.kind !== 'project' && (
                          <span className="gs-project-name">
                            <i style={{ background: row.project_color ?? undefined }} />
                            {row.project_name}
                          </span>
                        )}
                        {row.archived && (
                          <span className="gs-archived-tag">
                            <Archive size={11} aria-hidden="true" />
                            Archivado
                          </span>
                        )}
                      </span>
                    </span>
                    <ArrowUpRight size={13} className="gs-open-icon" aria-hidden="true" />
                  </button>
                ))}
              </div>
            );
          })}
        {available && !rows.length && (
          <div className="gs-state">
            <Search size={23} aria-hidden="true" />
            <h2>No encontramos resultados</h2>
            <p>Prueba con otro término o tipo de resultado.</p>
          </div>
        )}
        {(!valid || typing || debounced !== normalized) && !searching && (
          <div className="gs-state gs-hint">
            <Search size={22} aria-hidden="true" />
            <p>
              {controls
                ? 'Usa texto sin saltos de línea ni caracteres de control.'
                : length > SEARCH_MAX_LENGTH
                  ? `Usa como máximo ${SEARCH_MAX_LENGTH} caracteres.`
                  : valid
                    ? 'Preparando la búsqueda…'
                    : normalized
                      ? `Escribe al menos ${SEARCH_MIN_LENGTH} caracteres para buscar.`
                      : palette
                        ? 'Busca contenido o elige una acción rápida.'
                        : 'Encuentra contenido dentro del espacio seleccionado.'}
            </p>
          </div>
        )}
      </div>
      {available && results.hasNextPage && (
        <div className="gs-pagination">
          <button type="button" className="btn btn-secondary" disabled={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>
            {results.isFetchingNextPage ? <LoaderCircle size={14} className="pw-spin" aria-hidden="true" /> : null}
            {results.isFetchingNextPage ? 'Cargando…' : 'Cargar más resultados'}
          </button>
        </div>
      )}
      <div className="gs-footer">
        <span className="gs-key-help">
          <kbd>
            <ArrowUp size={10} aria-hidden="true" />
          </kbd>
          <kbd>
            <ArrowDown size={10} aria-hidden="true" />
          </kbd>
          moverse <kbd>↵</kbd>abrir
        </span>
        <span className="gs-scope-note">Solo contenido al que tienes acceso.</span>
        {palette && onShowAll && available && (
          <button type="button" className="gs-show-all" onClick={showAll}>
            Ver todos los resultados
            <ArrowUpRight size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      <span className="sr" id={`${prefix}-help`}>
        Búsqueda en el espacio seleccionado. Usa las flechas para recorrer los resultados.
      </span>
    </>
  );

  return palette ? (
    <Dialog title="Buscar en TR8" className="gs-dialog" onClose={() => onClose?.()}>
      {content}
    </Dialog>
  ) : (
    <section className="page gs-page" aria-label="Búsqueda global">
      <div className="ph">
        <div>
          <h1>
            <Search size={23} aria-hidden="true" />
            Búsqueda
          </h1>
          <p>Encuentra el contenido de tu espacio en un solo lugar.</p>
        </div>
      </div>
      <div className="gs-page-panel">{content}</div>
    </section>
  );
}
