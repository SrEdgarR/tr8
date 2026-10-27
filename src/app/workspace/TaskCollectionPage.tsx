import { Plus } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Task, TaskPatch, TaskStatus, WorkspaceProps } from '../types';
import { buildDashboardModel } from './dashboard-model';
import { localDate } from './helpers';
import { canInProject, canInWorkspace } from './permissions';
import ProductivityTasks from './ProductivityTasks';
import type { ProductivityController } from './useProductivity';
import { EmptyState } from './ui';

export default function TaskCollectionPage({
  data,
  controller,
  mine,
  onNewTask,
  onNewProject,
  onOpen,
  onMove,
  onPatch,
  onReorder,
}: {
  data: WorkspaceProps;
  controller: ProductivityController;
  mine: boolean;
  onNewTask: () => void;
  onNewProject: () => void;
  onOpen: (task: Task) => void;
  onMove: (task: Task, status: TaskStatus) => Promise<void>;
  onPatch: (task: Task, patch: TaskPatch) => Promise<void>;
  onReorder: (tasks: Task[]) => Promise<void>;
}) {
  const [params] = useSearchParams();
  const today = localDate();
  const model = buildDashboardModel(data, today);
  const filter = params.get('filter');
  const personal = mine || filter === 'mine';
  const base = personal ? model.mine : model.tasks;
  const tasks = base.filter(task =>
    filter === 'done'
      ? task.status === 'done'
      : filter === 'open'
        ? task.status !== 'done'
        : filter === 'overdue'
          ? task.status !== 'done' && Boolean(task.due_date && task.due_date < today)
          : true,
  );
  const label = new Map([
    ['done', 'Completadas'],
    ['open', 'Por completar'],
    ['overdue', 'Vencidas'],
  ]).get(filter ?? '');
  const scope = data.workspace ? `?workspace=${data.workspace.id}` : '';
  const canCreate = !data.readOnly && model.projects.some(project => canInProject(data, project.id, 'task.create'));
  return (
    <div className="page flush">
      <div className="ph">
        <div>
          <h1>{personal ? 'Mis tareas' : 'Tareas'}</h1>
          <p>
            {personal
              ? data.workspace?.kind === 'team'
                ? 'Solo las tareas asignadas a ti en este equipo.'
                : 'Tus tareas en el espacio personal.'
              : 'Todas las tareas visibles del espacio, en un solo lugar.'}
          </p>
        </div>
        <div className="acts">
          <button className="btn btn-primary" disabled={data.pending || !canCreate} onClick={onNewTask}>
            <Plus size={14} aria-hidden="true" />
            Nueva tarea
          </button>
        </div>
      </div>
      {label && (
        <div className="pw-dashboard-filter">
          <span>Mostrando: {label}</span>
          <Link to={`${personal ? '/my-tasks' : '/tasks'}${scope}`} className="pw-text-link">
            Ver todas las tareas
          </Link>
        </div>
      )}
      {personal && !model.mineAvailable && <p className="pw-info">Tu asignación no está disponible sin acceso al directorio de miembros.</p>}
      {model.projects.length ? (
        <ProductivityTasks
          data={data}
          controller={controller}
          context={personal ? 'mine' : 'tasks'}
          scopeKey={`${personal ? 'mine' : 'tasks'}:${filter ?? ''}`}
          tasks={tasks}
          projects={model.projects}
          members={model.members}
          pending={data.pending || controller.pending}
          canCreate={canCreate}
          canEditTask={task => !data.readOnly && canInProject(data, task.project_id, 'task.edit')}
          onCreate={onNewTask}
          onOpen={onOpen}
          onMove={onMove}
          onPatch={onPatch}
          onReorder={onReorder}
        />
      ) : (
        <EmptyState
          title="Primero, un proyecto"
          action={
            canInWorkspace(data, 'project.create') && !data.readOnly ? (
              <button className="btn btn-primary" disabled={data.pending} onClick={onNewProject}>
                Crear proyecto
              </button>
            ) : undefined
          }
        >
          Crea un proyecto para empezar a organizar tus tareas.
        </EmptyState>
      )}
    </div>
  );
}
