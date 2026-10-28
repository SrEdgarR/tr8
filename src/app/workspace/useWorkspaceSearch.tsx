import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Bell,
  CalendarDays,
  ChartGantt,
  FolderPlus,
  House,
  Inbox,
  Keyboard,
  LayoutDashboard,
  LayoutGrid,
  List,
  ListTodo,
  PanelLeft,
  Paperclip,
  Plus,
  Search,
  Settings2,
  SquareKanban,
  Star,
  Table2,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import type { GlobalSearchResult, SearchCategory } from '../search-types';
import type { WorkspaceProps } from '../types';
import GlobalSearch, { type SearchCommand } from './GlobalSearch';
import { Busy, Dialog, EmptyState } from './ui';
import { canInProject, canInWorkspace } from './permissions';
import { IdentityAvatar } from './project-identity';

interface Options {
  data: WorkspaceProps;
  showFinance: boolean;
  canCreateProject: boolean;
  canCreateTask: boolean;
  onCreateProject: () => void;
  onCreateTask: () => void;
  onToggleSidebar: () => void;
}
const editingTarget = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"]'));

export default function useWorkspaceSearch({ data, showFinance, canCreateProject, canCreateTask, onCreateProject, onCreateTask, onToggleSidebar }: Options) {
  const location = useLocation();
  const navigate = useNavigate();
  const scope = JSON.stringify(data.globalSearch?.scopeKey ?? [data.currentUserId, data.workspace?.id]);
  const [paletteScope, setPaletteScope] = useState<string | null>(null);
  const [guideScope, setGuideScope] = useState<string | null>(null);
  const pageQuery = useRef({ scope, query: '', kind: 'all' as SearchCategory });
  const chord = useRef({ scope, at: 0 });
  const available = Boolean(data.globalSearch && !data.accessUnavailable && !data.loading && canInWorkspace(data, 'project.read'));
  const open = available && paletteScope === scope;
  const guideOpen = guideScope === scope;
  const suffix = data.workspace ? `?workspace=${data.workspace.id}` : '';
  const go = (path: string) => navigate(`${path}${suffix}`);
  const currentProject = data.projects.find(project => location.pathname === `/projects/${project.id}`);
  const close = () => setPaletteScope(null);
  const showGuide = () => {
    close();
    setGuideScope(scope);
  };
  const commands: SearchCommand[] = [];
  function command(id: string, label: string, icon: SearchCommand['icon'], run: () => void, shortcut?: string) {
    commands.push({
      id,
      label,
      icon,
      run: () => {
        close();
        run();
      },
      shortcut,
    });
  }
  if (canCreateTask) command('new-task', 'Crear tarea', Plus, onCreateTask, 'N');
  if (canCreateProject) command('new-project', 'Crear proyecto', FolderPlus, onCreateProject, 'P');
  const routes = [
    { id: 'home', path: '/', label: 'Ir a Inicio', icon: House, shortcut: 'G H', enabled: true },
    { id: 'mine', path: '/my-tasks', label: 'Ir a Mis tareas', icon: ListTodo, shortcut: 'G T', enabled: canInWorkspace(data, 'project.read') },
    { id: 'projects', path: '/projects', label: 'Ir a Proyectos', icon: LayoutGrid, shortcut: 'G P', enabled: canInWorkspace(data, 'project.read') },
    { id: 'overview', path: '/overview', label: 'Ir a Vista general', icon: LayoutDashboard, enabled: canInWorkspace(data, 'project.read') },
    { id: 'tasks', path: '/tasks', label: 'Ir a Tareas', icon: ListTodo, enabled: canInWorkspace(data, 'task.read') },
    { id: 'favorites', path: '/favorites', label: 'Ir a Favoritos', icon: Star, enabled: Boolean(data.productivity) },
    {
      id: 'inbox',
      path: '/inbox',
      label: 'Ir a Bandeja de entrada',
      icon: Inbox,
      shortcut: 'G I',
      enabled: Boolean(data.communication && canInWorkspace(data, 'project.read')),
    },
    {
      id: 'notifications',
      path: '/notifications',
      label: 'Ir a Notificaciones',
      icon: Bell,
      shortcut: 'G N',
      enabled: Boolean(data.communication && canInWorkspace(data, 'project.read')),
    },
    { id: 'calendar', path: '/calendar', label: 'Ir a Calendario', icon: CalendarDays, shortcut: 'G C', enabled: Boolean(data.calendar) },
    { id: 'timeline', path: '/timeline', label: 'Ir a Timeline', icon: ChartGantt, enabled: Boolean(data.planning && canInWorkspace(data, 'project.read')) },
    { id: 'team', path: '/team', label: 'Ir a Equipo', icon: Users, shortcut: 'G M', enabled: data.workspace?.kind === 'team' },
    {
      id: 'activity',
      path: '/activity',
      label: 'Ir a Actividad',
      icon: Activity,
      shortcut: 'G A',
      enabled: Boolean(data.collaboration && canInWorkspace(data, 'audit.read')),
    },
    { id: 'finance', path: '/finance', label: 'Ir a Finanzas', icon: Wallet, enabled: showFinance && data.workspace?.kind === 'personal' },
    { id: 'settings', path: '/settings', label: 'Abrir Configuración', icon: Settings2, shortcut: 'G S', enabled: true },
    { id: 'account', path: '/account', label: 'Abrir Mi cuenta', icon: UserRound, enabled: true },
  ];
  for (const row of routes) if (row.enabled) command(row.id, row.label, row.icon, () => go(row.path), row.shortcut);
  if (currentProject && canInProject(data, currentProject.id, 'project.read')) {
    const taskReadable = canInProject(data, currentProject.id, 'task.read');
    const views = [
      { id: 'overview', label: 'Resumen', icon: LayoutDashboard, enabled: true },
      { id: 'list', label: 'Lista', icon: List, enabled: taskReadable },
      { id: 'table', label: 'Tabla', icon: Table2, enabled: taskReadable },
      { id: 'board', label: 'Tablero', icon: SquareKanban, enabled: taskReadable },
      { id: 'calendar', label: 'Calendario', icon: CalendarDays, enabled: taskReadable && Boolean(data.calendar) },
      { id: 'timeline', label: 'Timeline', icon: ChartGantt, enabled: taskReadable && Boolean(data.planning) },
      { id: 'files', label: 'Archivos', icon: Paperclip, enabled: Boolean(data.projectFiles) },
    ];
    for (const view of views)
      if (view.enabled)
        command(`view-${view.id}`, `Vista del proyecto: ${view.label}`, view.icon, () =>
          navigate(`/projects/${currentProject.id}?${new URLSearchParams({ ...(data.workspace ? { workspace: data.workspace.id } : {}), view: view.id })}`),
        );
  }
  for (const workspace of data.workspaces ?? [])
    if (workspace.id !== data.workspace?.id && data.onSelectWorkspace) {
      command(`workspace-${workspace.id}`, `Cambiar a ${workspace.kind === 'personal' ? 'Mi espacio personal' : workspace.name}`, Users, () =>
        data.onSelectWorkspace!(workspace.id),
      );
    }
  command('sidebar', 'Contraer o expandir barra lateral', PanelLeft, onToggleSidebar, '[');
  command('shortcuts', 'Atajos de teclado', Keyboard, showGuide, '?');

  const handleKeydown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'k') {
      if (!available || (!open && document.querySelector('dialog[open]'))) return;
      event.preventDefault();
      setPaletteScope(open ? null : scope);
      return;
    }
    if (event.ctrlKey || event.metaKey || editingTarget(event.target) || document.querySelector('dialog[open]') || data.loading || data.accessUnavailable)
      return;
    if (chord.current.scope === scope && chord.current.at && Date.now() - chord.current.at < 1200) {
      chord.current.at = 0;
      const selected = commands.find(item => item.shortcut?.toLowerCase() === `g ${key}`);
      if (selected) {
        event.preventDefault();
        selected.run();
      }
      return;
    }
    chord.current = { scope, at: key === 'g' ? Date.now() : 0 };
    if (key === 'g') return;
    if (event.key === '/' && available) {
      event.preventDefault();
      setPaletteScope(scope);
      return;
    }
    const selected = commands.find(item => item.shortcut?.toLowerCase() === key);
    if (selected) {
      event.preventDefault();
      selected.run();
    }
  });
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => handleKeydown(event);
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, []);

  function select(result: GlobalSearchResult) {
    if (result.workspace_id !== data.workspace?.id || data.accessUnavailable) return;
    close();
    data.onRetry();
    const params = new URLSearchParams({ workspace: result.workspace_id });
    if (result.kind === 'member') {
      if (!canInWorkspace(data, 'member.read') || data.workspace?.kind !== 'team') return;
      params.set('member', result.id);
      navigate(`/team?${params}`);
    } else if (result.project_id) {
      if (result.task_id) params.set('task', result.task_id);
      if (result.kind === 'comment') params.set('comment', result.id);
      if (result.kind === 'file') {
        params.set('view', 'files');
        params.set('file', result.id);
      }
      navigate(`/projects/${result.project_id}?${params}`);
    }
  }
  function showAll(query: string, kind: SearchCategory) {
    pageQuery.current = { scope, query, kind };
    close();
    go('/search');
  }
  const params = new URLSearchParams(location.search);
  const memberId = location.pathname === '/team' ? params.get('member') : null;
  const memberAllowed = data.workspace?.kind === 'team' && canInWorkspace(data, 'member.read') && !data.accessUnavailable;
  const member = memberAllowed && !data.directoryError ? data.members?.find(row => row.id === memberId && row.status === 'active') : undefined;
  function closeMember() {
    params.delete('member');
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }
  return {
    available,
    openGuide: showGuide,
    trigger: available ? (
      <button
        type="button"
        className="ws-search-trigger"
        aria-label="Buscar o ir a…"
        aria-keyshortcuts="Control+K Meta+K"
        onClick={() => setPaletteScope(scope)}
      >
        <Search size={15} aria-hidden="true" />
        <span>Buscar o ir a…</span>
        <kbd>Ctrl K</kbd>
      </button>
    ) : null,
    page:
      available && data.globalSearch ? (
        <GlobalSearch
          key={`${scope}:${location.key}`}
          api={data.globalSearch}
          mode="page"
          initialQuery={pageQuery.current.scope === scope ? pageQuery.current.query : ''}
          initialKind={pageQuery.current.scope === scope ? pageQuery.current.kind : 'all'}
          onQueryChange={(query, kind) => {
            pageQuery.current = { scope, query, kind };
          }}
          onSelect={select}
        />
      ) : (
        <div className="page">
          <EmptyState title="Búsqueda no disponible">Actualiza el espacio para comprobar tu acceso.</EmptyState>
        </div>
      ),
    overlays: (
      <>
        {open && data.globalSearch && (
          <GlobalSearch key={scope} api={data.globalSearch} mode="palette" actions={commands} onSelect={select} onClose={close} onShowAll={showAll} />
        )}
        {guideOpen && (
          <Dialog title="Atajos de teclado" onClose={() => setGuideScope(null)}>
            <div className="pw-form-body ws-shortcut-guide">
              <p className="muted">Los atajos de una letra funcionan fuera de los campos de texto y las ventanas abiertas.</p>
              <dl>
                {available && (
                  <>
                    <dt>Buscar o abrir acciones</dt>
                    <dd>
                      <kbd>Ctrl / ⌘ K</kbd> <kbd>/</kbd>
                    </dd>
                  </>
                )}
                {commands
                  .filter(row => row.shortcut)
                  .map(row => (
                    <div key={row.id}>
                      <dt>{row.label}</dt>
                      <dd>
                        <kbd>{row.shortcut}</kbd>
                      </dd>
                    </div>
                  ))}
                <dt>Navegar por resultados</dt>
                <dd>
                  <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Enter</kbd>
                </dd>
                <dt>Cerrar ventana</dt>
                <dd>
                  <kbd>Esc</kbd>
                </dd>
              </dl>
            </div>
          </Dialog>
        )}
        {memberId && memberAllowed && (
          <Dialog title="Miembro del equipo" onClose={closeMember}>
            <div className="pw-form-body">
              {data.directoryLoading ? (
                <Busy>Cargando miembro…</Busy>
              ) : member ? (
                <div className="ws-search-member">
                  <IdentityAvatar name={member.display_name} />
                  <div>
                    <h3>{member.display_name}</h3>
                    <p className="muted">{member.is_owner ? 'Propietario del equipo' : 'Miembro activo'}</p>
                  </div>
                </div>
              ) : (
                <p className="muted">Este miembro ya no está disponible. Actualiza el equipo para comprobar su acceso.</p>
              )}
            </div>
          </Dialog>
        )}
      </>
    ),
  };
}
