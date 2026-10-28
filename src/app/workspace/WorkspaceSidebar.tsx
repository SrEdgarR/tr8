import { useId, useState, type CSSProperties } from 'react';
import {
  Archive,
  Activity,
  CalendarDays,
  ChartGantt,
  ChevronRight,
  SquareKanban,
  Home,
  LayoutGrid,
  LayoutDashboard,
  List,
  ListTodo,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings2,
  Star,
  Table2,
  Users,
  Wallet,
} from 'lucide-react';
import { Link, NavLink, useLocation, useSearchParams } from 'react-router-dom';
import type { Project, WorkspaceProps } from '../types';
import { IdentityAvatar, ProjectGlyph, ProjectStatusDot } from './project-identity';
import { canInProject, canInWorkspace } from './permissions';
import { buildDashboardModel } from './dashboard-model';
import { localDate } from './helpers';
import FavoriteButton from './FavoriteButton';

interface Props {
  favoriteProjectIds?: readonly string[];
  favoriteCount?: number;
  favoritesBusy?: boolean;
  onFavoriteProject?: (project: Project) => void;
  data: WorkspaceProps;
  collapsed: boolean;
  pending: boolean;
  showFinance: boolean;
  onToggle: () => void;
  onNavigate: () => void;
  onCreateProject: () => void;
  onCreateTeam: () => void;
}

export default function WorkspaceSidebar({
  data,
  collapsed,
  pending,
  showFinance,
  onToggle,
  onNavigate,
  onCreateProject,
  onCreateTeam,
  favoriteProjectIds = [],
  favoriteCount = 0,
  favoritesBusy = false,
  onFavoriteProject,
}: Props) {
  const location = useLocation();
  const [params] = useSearchParams();
  const prefix = useId();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const mine = buildDashboardModel(data, localDate());
  const projects = mine.projects;
  const count = mine.totals.open;
  const mineCount = mine.mineAvailable ? mine.mine.filter(task => task.status !== 'done').length : '—';
  const scope = data.workspace ? `?workspace=${data.workspace.id}` : '';
  const workspaceName = data.workspace?.kind === 'team' ? data.workspace.name : 'Mi espacio personal';
  const navClass = ({ isActive }: { isActive: boolean }) => `sitem${isActive ? ' on' : ''}`;
  const view = ['overview', 'table', 'board', 'calendar', 'timeline', 'activity', 'archived'].includes(params.get('view') ?? '') ? params.get('view') : 'list';

  function href(project: Project, nextView: string) {
    const search = new URLSearchParams();
    if (data.workspace) search.set('workspace', data.workspace.id);
    search.set('view', nextView);
    return `/projects/${project.id}?${search}`;
  }

  return (
    <aside className="side" id="tr8-sidebar" aria-label="Navegación principal">
      <div className="side-top pw-side-brand">
        <Link to={`/${scope}`} className="ws" aria-label="Inicio de TR8" title="TR8" onClick={onNavigate}>
          <span className="ws-logo brand">
            <img src="/favicon.svg" width="22" height="22" alt="" />
          </span>
          <span className="ws-name">TR8</span>
        </Link>
        <button
          type="button"
          className="ibtn pw-sidebar-toggle"
          aria-label={collapsed ? 'Expandir barra lateral' : 'Contraer barra lateral'}
          title={collapsed ? 'Expandir barra lateral' : 'Contraer barra lateral'}
          aria-expanded={!collapsed}
          aria-controls="tr8-sidebar-navigation"
          onClick={onToggle}
        >
          {collapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
        </button>
      </div>
      {data.workspace && data.workspaces && (
        <div className="pw-workspace-picker">
          <label className="sr" htmlFor="workspace-select">
            Espacio de trabajo
          </label>
          <select id="workspace-select" value={data.workspace.id} disabled={pending} onChange={event => data.onSelectWorkspace?.(event.target.value)}>
            {data.workspaces.map(space => (
              <option key={space.id} value={space.id}>
                {space.kind === 'personal' ? 'Mi espacio personal' : space.name}
              </option>
            ))}
          </select>
          {data.onCreateTeam && (
            <button className="ibtn" aria-label="Crear equipo" title="Crear equipo" disabled={pending} onClick={onCreateTeam}>
              <Plus size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      <div className="side-scroll">
        <nav id="tr8-sidebar-navigation" aria-label="Secciones del espacio">
          <div className="pw-personal-navigation">
            <NavLink to={`/${scope}`} end className={navClass} aria-label="Inicio" title="Inicio" onClick={onNavigate}>
              <Home className="i" size={16} aria-hidden="true" />
              <span>Inicio</span>
            </NavLink>
            <NavLink to={`/my-tasks${scope}`} className={navClass} aria-label={`Mis tareas ${mineCount}`} title="Mis tareas" onClick={onNavigate}>
              <ListTodo className="i" size={16} aria-hidden="true" />
              <span>Mis tareas</span>
              <span className="ct">{mineCount}</span>
            </NavLink>
            <NavLink to={`/favorites${scope}`} className={navClass} aria-label={`Favoritos ${favoriteCount}`} title="Favoritos" onClick={onNavigate}>
              <Star className="i" size={16} aria-hidden="true" />
              <span>Favoritos</span>
              <span className="ct">{favoriteCount}</span>
            </NavLink>
          </div>
          <div className="sgroup">
            <div className="sgroup-h">{workspaceName}</div>
            <NavLink to={`/overview${scope}`} className={navClass} aria-label="Vista general" title="Vista general" onClick={onNavigate}>
              <LayoutDashboard className="i" size={16} aria-hidden="true" />
              <span>Vista general</span>
            </NavLink>
            <NavLink to={`/tasks${scope}`} className={navClass} aria-label={`Tareas ${count}`} title="Tareas" onClick={onNavigate}>
              <ListTodo className="i" size={16} aria-hidden="true" />
              <span>Tareas</span>
              <span className="ct">{count}</span>
            </NavLink>
            <NavLink to={`/projects${scope}`} className={navClass} aria-label={`Proyectos ${projects.length}`} title="Proyectos" onClick={onNavigate}>
              <LayoutGrid className="i" size={16} aria-hidden="true" />
              <span>Proyectos</span>
              <span className="ct">{projects.length}</span>
            </NavLink>
            {data.calendar && (
              <NavLink to={`/calendar${scope}`} className={navClass} aria-label="Calendario" title="Calendario" onClick={onNavigate}>
                <CalendarDays className="i" size={16} aria-hidden="true" />
                <span>Calendario</span>
              </NavLink>
            )}
            {data.planning && !data.accessUnavailable && canInWorkspace(data, 'project.read') && (
              <NavLink to={`/timeline${scope}`} className={navClass} aria-label="Timeline" title="Timeline" onClick={onNavigate}>
                <ChartGantt className="i" size={16} aria-hidden="true" />
                <span>Timeline</span>
              </NavLink>
            )}
            {data.workspace?.kind === 'personal' && showFinance && (
              <NavLink to={`/finance${scope}`} className={navClass} aria-label="Finanzas" title="Finanzas" onClick={onNavigate}>
                <Wallet className="i" size={16} aria-hidden="true" />
                <span>Finanzas</span>
              </NavLink>
            )}
            {data.workspace?.kind === 'team' && (
              <NavLink to={`/team${scope}`} className={navClass} aria-label="Equipo" title="Equipo" onClick={onNavigate}>
                <Users className="i" size={16} aria-hidden="true" />
                <span>Equipo</span>
              </NavLink>
            )}
            {data.collaboration && !data.accessUnavailable && canInWorkspace(data, 'audit.read') && (
              <NavLink to={`/activity${scope}`} className={navClass} aria-label="Actividad" title="Actividad" onClick={onNavigate}>
                <Activity className="i" size={16} aria-hidden="true" />
                <span>Actividad</span>
              </NavLink>
            )}
          </div>
          <div className="sgroup pw-sidebar-projects">
            <div className="sgroup-h">
              <span>Proyectos activos</span>
              <span className="sp" />
              <button
                className="ibtn ibtn-xs"
                aria-label="Crear proyecto"
                disabled={pending || data.loading || data.readOnly || !canInWorkspace(data, 'project.create')}
                onClick={onCreateProject}
              >
                <Plus size={13} aria-hidden="true" />
              </button>
            </div>
            {projects.map(project => {
              const current = location.pathname === `/projects/${project.id}`;
              const open = expanded[project.id] ?? current;
              const regionId = `${prefix}-${project.id}`;
              const views = [
                { id: 'overview', label: 'Resumen', icon: LayoutDashboard },
                { id: 'list', label: 'Lista', icon: List },
                { id: 'board', label: 'Tablero', icon: SquareKanban },
                { id: 'table', label: 'Tabla', icon: Table2 },
                ...(data.workManagement ? [{ id: 'archived', label: 'Archivadas', icon: Archive }] : []),
                ...(data.calendar ? [{ id: 'calendar', label: 'Calendario', icon: CalendarDays }] : []),
                ...(data.planning ? [{ id: 'timeline', label: 'Timeline', icon: ChartGantt }] : []),
                ...(data.collaboration && canInProject(data, project.id, 'audit.read') ? [{ id: 'activity', label: 'Actividad', icon: Activity }] : []),
              ];
              return (
                <div className={`pw-sidebar-project${current ? ' is-current' : ''}`} key={project.id}>
                  <div className="pw-sidebar-project-row">
                    <NavLink to={`/projects/${project.id}${scope}`} className={navClass} aria-label={project.name} title={project.name} onClick={onNavigate}>
                      <span className="pico" style={{ '--c': project.color } as CSSProperties}>
                        <ProjectGlyph icon={project.icon} size={12} />
                      </span>
                      <span className="trunc">{project.name}</span>
                      <ProjectStatusDot status={project.status} />
                    </NavLink>
                    {data.productivity && onFavoriteProject && (
                      <FavoriteButton
                        name={project.name}
                        active={favoriteProjectIds.includes(project.id)}
                        disabled={pending || favoritesBusy}
                        onClick={() => onFavoriteProject(project)}
                      />
                    )}
                    <button
                      type="button"
                      className="ibtn ibtn-xs pw-project-expand"
                      aria-label={`${open ? 'Ocultar' : 'Mostrar'} vistas de ${project.name}`}
                      title={`${open ? 'Ocultar' : 'Mostrar'} vistas`}
                      aria-expanded={open}
                      aria-controls={regionId}
                      onClick={() => setExpanded(previous => ({ ...previous, [project.id]: !open }))}
                    >
                      <ChevronRight size={13} className={open ? 'is-open' : ''} aria-hidden="true" />
                    </button>
                  </div>
                  <div id={regionId} className="pw-sidebar-subviews" role="region" aria-label={`Vistas de ${project.name}`} hidden={!open}>
                    {views.map(({ id, label, icon: Icon }) => (
                      <Link
                        key={id}
                        to={href(project, id)}
                        className={`sitem${current && view === id ? ' on' : ''}`}
                        aria-current={current && view === id ? 'page' : undefined}
                        onClick={onNavigate}
                      >
                        <Icon size={14} aria-hidden="true" />
                        <span>{label}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
            {!projects.length && <p className="pw-side-empty">Tus proyectos aparecerán aquí.</p>}
          </div>
        </nav>
      </div>
      <div className="side-bot">
        <NavLink to={`/settings${scope}`} className={navClass} aria-label="Configuración" title="Configuración" onClick={onNavigate}>
          <Settings2 className="i" size={16} aria-hidden="true" />
          <span>Configuración</span>
        </NavLink>
        <NavLink
          to={`/account${scope}`}
          className={`${navClass({ isActive: location.pathname === '/account' })} pw-account-link`}
          aria-label={data.email}
          title="Mi cuenta"
          onClick={onNavigate}
        >
          <IdentityAvatar name={data.email} small decorative />
          <span className="trunc">{data.email}</span>
          <ChevronRight className="pw-account-chevron" size={13} aria-hidden="true" />
        </NavLink>
      </div>
    </aside>
  );
}
