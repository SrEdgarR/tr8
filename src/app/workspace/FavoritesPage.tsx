import { Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Task, TaskPatch, TaskStatus, WorkspaceProps } from '../types';
import { canInProject } from './permissions';
import FavoriteButton from './FavoriteButton';
import TasksView from './TasksView';
import type { ProductivityController } from './useProductivity';
import { Busy, EmptyState, ErrorNotice, ProjectIcon } from './ui';
import { buildDashboardModel } from './dashboard-model';
import { localDate } from './helpers';

export default function FavoritesPage({
  data,
  controller,
  onOpen,
  onMove,
  onPatch,
  onReorder,
}: {
  data: WorkspaceProps;
  controller: ProductivityController;
  onOpen: (task: Task) => void;
  onMove: (task: Task, status: TaskStatus) => Promise<void>;
  onPatch: (task: Task, patch: TaskPatch) => Promise<void>;
  onReorder: (tasks: Task[]) => Promise<void>;
}) {
  const projects = data.accessUnavailable
    ? []
    : data.projects.filter(
        project => (!data.workspace || project.workspace_id === data.workspace.id) && (!data.capabilities || canInProject(data, project.id, 'project.read')),
      );
  const projectMap = new Map(projects.map(project => [project.id, project]));
  const favoriteProjects = new Set(controller.state.favorites.filter(row => row.kind === 'project').map(row => row.id));
  const favoriteTaskIds = controller.state.favorites.filter(row => row.kind === 'task').map(row => row.id);
  const ids = new Set(favoriteTaskIds);
  const tasks = data.accessUnavailable
    ? []
    : data.tasks.filter(
        task =>
          ids.has(task.id) &&
          projectMap.get(task.project_id)?.workspace_id === task.workspace_id &&
          (!data.capabilities || canInProject(data, task.project_id, 'task.read')),
      );
  return (
    <div className="page pw-favorites-page">
      <div className="ph">
        <div>
          <h1>
            <Star size={21} aria-hidden="true" /> Favoritos
          </h1>
          <p>Los proyectos y las tareas que destacaste en este espacio.</p>
        </div>
      </div>
      {controller.error && (
        <ErrorNotice>
          {controller.error}
          <button className="btn btn-ghost btn-sm" onClick={controller.refresh}>
            Volver a cargar favoritos
          </button>
        </ErrorNotice>
      )}
      {controller.loading ? (
        <Busy />
      ) : !data.productivity ? (
        <EmptyState title="Favoritos no disponibles">Actualiza la aplicación para consultar tus favoritos.</EmptyState>
      ) : (
        <>
          <h2>Proyectos destacados</h2>
          {projects.some(project => favoriteProjects.has(project.id)) ? (
            <div className="pw-favorites-projects">
              {projects
                .filter(project => favoriteProjects.has(project.id))
                .map(project => (
                  <article key={project.id} className="pw-favorite-project">
                    <Link to={`/projects/${project.id}?${new URLSearchParams({ workspace: project.workspace_id, view: 'overview' })}`}>
                      <ProjectIcon icon={project.icon} color={project.color} />
                      <span>
                        <strong>{project.name}</strong>
                        <small>{project.archived_at ? 'Proyecto archivado' : 'Abrir resumen'}</small>
                      </span>
                    </Link>
                    <FavoriteButton
                      name={project.name}
                      active
                      disabled={!controller.available || controller.pending || data.pending}
                      onClick={() => {
                        void controller.setFavorite('project', project.id, false).catch(() => {});
                      }}
                    />
                  </article>
                ))}
            </div>
          ) : (
            <p className="faint">Usa la estrella de un proyecto para encontrarlo aquí.</p>
          )}
          <h2>Tareas destacadas</h2>
          <TasksView
            tasks={tasks}
            projects={projects}
            members={buildDashboardModel(data, localDate()).members}
            pending={data.pending || controller.pending}
            canCreate={false}
            scopeKey={JSON.stringify([data.currentUserId, data.workspace?.id, data.productivity?.scopeKey, 'favorites'])}
            onCreate={() => {}}
            onOpen={onOpen}
            onMove={onMove}
            onPatch={onPatch}
            onReorder={onReorder}
            canEditTask={task => !data.readOnly && !projectMap.get(task.project_id)?.archived_at && canInProject(data, task.project_id, 'task.edit')}
            favoriteTaskIds={favoriteTaskIds}
            onFavoriteTask={
              controller.available
                ? async (task, value) => {
                    await controller.setFavorite('task', task.id, value);
                  }
                : undefined
            }
            productivityLoading={controller.pending}
          />
        </>
      )}
    </div>
  );
}
