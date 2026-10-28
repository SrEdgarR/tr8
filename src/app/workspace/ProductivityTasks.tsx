import type { ComponentProps } from 'react';
import type { TaskViewContext } from '../productivity-types';
import type { WorkspaceProps } from '../types';
import TasksView from './TasksView';
import type { ProductivityController } from './useProductivity';
import { buildDashboardModel } from './dashboard-model';
import { localDate } from './helpers';
import { canInProject } from './permissions';

type Props = ComponentProps<typeof TasksView> & {
  data: WorkspaceProps;
  controller: ProductivityController;
  context: TaskViewContext;
  projectId?: string;
};

export default function ProductivityTasks({ data, controller, context, projectId, ...props }: Props) {
  const scope = JSON.stringify([
    data.currentUserId,
    data.workspace?.id,
    data.productivity?.scopeKey,
    data.bulkTasks?.scopeKey,
    context,
    projectId,
    props.scopeKey,
  ]);
  return (
    <TasksView
      {...props}
      bulkTasks={data.bulkTasks}
      canBulkTask={(task, kind) =>
        !data.readOnly &&
        !data.accessUnavailable &&
        task.workspace_id === data.workspace?.id &&
        !task.archived_at &&
        data.projects.some(project => project.id === task.project_id && project.workspace_id === task.workspace_id && !project.archived_at) &&
        canInProject(data, task.project_id, kind === 'assign' ? 'task.assign' : kind === 'delete' ? 'task.delete' : 'task.edit')
      }
      members={buildDashboardModel(data, localDate()).members}
      scopeKey={scope}
      favoriteTaskIds={controller.state.favorites.filter(row => row.kind === 'task').map(row => row.id)}
      onFavoriteTask={
        controller.available
          ? async (task, value) => {
              await controller.setFavorite('task', task.id, value);
            }
          : undefined
      }
      savedViews={controller.state.views.filter(view => view.context === context && view.project_id === (projectId ?? null))}
      onCreateView={controller.available ? (name, config, requestId) => controller.createView(name, context, projectId ?? null, config, requestId) : undefined}
      onUpdateView={controller.available ? controller.updateView : undefined}
      onDeleteView={
        controller.available
          ? async view => {
              await controller.deleteView(view);
            }
          : undefined
      }
      productivityLoading={controller.loading || controller.pending}
      productivityError={controller.error}
    />
  );
}
