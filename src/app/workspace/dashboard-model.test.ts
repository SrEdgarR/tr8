import { describe, expect, it, vi } from 'vitest';
import type { Project, ProjectCapability, Task, WorkspaceMember, WorkspaceProps, WorkspaceSummary } from '../types';
import { buildDashboardModel, shiftDashboardDate, summarizeProject } from './dashboard-model';

const today = '2026-10-27';
const userId = 'signed-in-user';
const workspace: WorkspaceSummary = {
  id: 'current-space',
  kind: 'team',
  name: 'Equipo actual',
  owner_id: 'other-owner',
  version: 1,
  permissions: ['member.read'],
};
const project: Project = {
  id: 'project-current',
  workspace_id: workspace.id,
  owner_id: 'project-creator',
  code: 'P-CURRENT',
  name: 'Proyecto actual',
  description: '',
  color: '#23918A',
  icon: 'globe',
  status: 'active',
  archived_at: null,
  version: 1,
  created_at: '2026-10-01T12:00:00Z',
  updated_at: '2026-10-26T12:00:00Z',
};
function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    workspace_id: workspace.id,
    owner_id: 'project-creator',
    project_id: project.id,
    assignee_member_id: null,
    task_number: 1,
    title: id,
    description: '',
    status: 'todo',
    priority: 'none',
    start_date: null,
    due_date: today,
    position: 0,
    version: 1,
    created_at: project.created_at,
    updated_at: project.updated_at,
    ...patch,
  };
}
function member(id: string, patch: Partial<WorkspaceMember> = {}): WorkspaceMember {
  return {
    id,
    user_id: `user-${id}`,
    display_name: `Persona ${id}`,
    status: 'active',
    version: 1,
    is_owner: false,
    roles: [],
    permissions: [],
    can_manage_roles: false,
    can_remove: false,
    ...patch,
  };
}
function capability(id: string, permissions = ['project.read', 'task.read']): ProjectCapability {
  return { project_id: id, access_level: 'read', permissions };
}
function props(overrides: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    workspace,
    currentUserId: userId,
    projects: [project],
    tasks: [],
    members: [],
    capabilities: { [project.id]: capability(project.id) },
    email: 'qa@example.com',
    loading: false,
    refreshing: false,
    pending: false,
    error: null,
    onRetry: vi.fn(),
    onCreateProject: vi.fn(),
    onUpdateProject: vi.fn(),
    onArchiveProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onCreateTask: vi.fn(),
    onUpdateTask: vi.fn(),
    onDeleteTask: vi.fn(),
    onSignOut: vi.fn(),
    onPasswordReset: vi.fn(),
    ...overrides,
  };
}

describe('resúmenes derivados de la instantánea autorizada', () => {
  it('excluye proyectos archivados, ajenos al espacio y tareas huérfanas o de otro espacio sin mutar los datos', () => {
    const archived = { ...project, id: 'archived', archived_at: project.updated_at };
    const foreign = { ...project, id: 'foreign', workspace_id: 'previous-space' };
    const data = props({
      projects: [project, archived, foreign],
      tasks: [
        task('visible'),
        task('archived-task', { project_id: archived.id }),
        task('foreign-task', { project_id: foreign.id, workspace_id: foreign.workspace_id }),
        task('wrong-space', { workspace_id: 'previous-space' }),
        task('orphan', { project_id: 'missing-project' }),
      ],
      capabilities: Object.fromEntries([project, archived, foreign].map(item => [item.id, capability(item.id)])),
    });
    const before = JSON.stringify(data);
    const model = buildDashboardModel(data, today);
    expect(model.projects.map(item => item.id)).toEqual([project.id]);
    expect(model.tasks.map(item => item.id)).toEqual(['visible']);
    expect(model.totals).toMatchObject({ projects: 1, tasks: 1, open: 1, done: 0, overdue: 0 });
    expect(JSON.stringify(data)).toBe(before);
  });

  it('no filtra recuentos de tareas de proyectos sin project.read ni task.read', () => {
    const projectOnly = { ...project, id: 'project-only', name: 'Descripción visible' };
    const denied = { ...project, id: 'denied' };
    const model = buildDashboardModel(
      props({
        projects: [project, projectOnly, denied],
        tasks: [task('visible'), task('no-task-read', { project_id: projectOnly.id }), task('no-project-read', { project_id: denied.id })],
        capabilities: {
          [project.id]: capability(project.id),
          [projectOnly.id]: capability(projectOnly.id, ['project.read']),
          [denied.id]: capability(denied.id, ['task.read']),
        },
      }),
      today,
    );
    expect(model.projects.map(item => item.id)).toEqual([project.id, projectOnly.id]);
    expect(model.tasks.map(item => item.id)).toEqual(['visible']);
    expect(model.taskCoveragePartial).toBe(true);
    expect(model.projectSummaries.find(item => item.project.id === projectOnly.id)).toMatchObject({
      taskReadable: false,
      tasks: [],
      total: 0,
      open: 0,
      progress: 0,
      nextDue: null,
    });
  });

  it('retira todas las cifras y los nombres cuando se pierde acceso al espacio aunque persistan props anteriores', () => {
    const model = buildDashboardModel(
      props({
        accessUnavailable: true,
        tasks: [task('stale-task', { assignee_member_id: 'stale-member' })],
        members: [member('stale-member', { user_id: userId })],
      }),
      today,
    );
    expect(model.projects).toEqual([]);
    expect(model.tasks).toEqual([]);
    expect(model.members).toEqual([]);
    expect(model.workloads).toEqual([]);
    expect(model.mine).toEqual([]);
    expect(model.mineAvailable).toBe(false);
    expect(model.totals).toEqual({ projects: 0, tasks: 0, open: 0, done: 0, overdue: 0, progress: 0 });
  });

  it('computa vencimientos de fechas civiles solo para tareas abiertas y no confunde actualizado con completado', () => {
    const model = buildDashboardModel(
      props({
        tasks: [
          task('past', { due_date: '2026-10-26' }),
          task('today'),
          task('future', { due_date: '2026-11-02' }),
          task('undated', { due_date: null }),
          task('done-old', { due_date: '2026-10-01', status: 'done' }),
        ],
      }),
      today,
    );
    expect(model.totals).toMatchObject({ tasks: 5, open: 4, done: 1, overdue: 1, progress: 20 });
    expect(model.projectSummaries[0]).toMatchObject({ nextDue: '2026-10-26', overdue: 1, done: 1 });
    expect(summarizeProject(project, [task('only-done', { status: 'done', due_date: '2026-10-01' })], true, today)).toMatchObject({
      progress: 100,
      overdue: 0,
      nextDue: null,
    });
  });

  it('identifica Mis tareas en equipo por user_id del miembro y nunca por autor o identidad parecida', () => {
    const mine = member('member-self', { user_id: userId });
    const other = member('member-other');
    const model = buildDashboardModel(
      props({
        members: [mine, other],
        tasks: [
          task('assigned-to-me', { assignee_member_id: mine.id, owner_id: 'someone-else' }),
          task('created-by-me', { assignee_member_id: other.id, owner_id: userId }),
          task('id-is-not-user-id', { assignee_member_id: userId }),
          task('unassigned-created-by-me', { owner_id: userId }),
        ],
      }),
      today,
    );
    expect(model.mineAvailable).toBe(true);
    expect(model.mine.map(item => item.id)).toEqual(['assigned-to-me']);
  });

  it.each(['denied', 'loading', 'error'] as const)('descarta nombres y cargas anteriores cuando el directorio está %s', state => {
    const data = props({
      members: [member('stale-name', { user_id: userId })],
      tasks: [task('assigned', { assignee_member_id: 'stale-name' })],
      ...(state === 'denied'
        ? { workspace: { ...workspace, permissions: [] } }
        : state === 'loading'
          ? { directoryLoading: true }
          : { directoryError: 'Acceso retirado' }),
    });
    const model = buildDashboardModel(data, today);
    expect(model.directoryState).toBe(state === 'denied' ? 'unavailable' : state);
    expect(model.directoryAvailable).toBe(false);
    expect(model.members).toEqual([]);
    expect(model.memberMap.size).toBe(0);
    expect(model.workloads).toEqual([]);
    expect(model.mineAvailable).toBe(false);
    expect(model.mine).toEqual([]);
  });

  it('separa sin responsable y responsables fuera del directorio sin incluir tareas denegadas ni miembros retirados', () => {
    const denied = { ...project, id: 'denied-project' };
    const model = buildDashboardModel(
      props({
        projects: [project, denied],
        members: [member('active'), member('removed', { status: 'removed' })],
        tasks: [
          task('active-assignment', { assignee_member_id: 'active' }),
          task('unknown-assignment', { assignee_member_id: 'unknown' }),
          task('removed-assignment', { assignee_member_id: 'removed' }),
          task('unassigned'),
          task('hidden', { project_id: denied.id, assignee_member_id: 'unknown' }),
          task('completed', { status: 'done', assignee_member_id: 'unknown' }),
        ],
      }),
      today,
    );
    expect(model.workloads.map(row => [row.member.id, row.tasks.map(item => item.id)])).toEqual([['active', ['active-assignment']]]);
    expect(model.unassigned.map(item => item.id)).toEqual(['unassigned']);
    expect(model.unavailableAssignees.map(item => item.id)).toEqual(['unknown-assignment', 'removed-assignment']);
  });

  it('el espacio personal muestra todas sus tareas visibles sin requerir directorio del equipo', () => {
    const data = props({
      workspace: { ...workspace, kind: 'personal', owner_id: userId, permissions: [] },
      tasks: [task('personal-task')],
      directoryError: 'No hay directorio',
    });
    const model = buildDashboardModel(data, today);
    expect(model.directoryAvailable).toBe(false);
    expect(model.mineAvailable).toBe(true);
    expect(model.mine.map(item => item.id)).toEqual(['personal-task']);
  });

  it('desplaza fechas civiles entre meses, años y febrero bisiesto', () => {
    expect(shiftDashboardDate('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftDashboardDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDashboardDate('2028-02-28', 2)).toBe('2028-03-01');
    expect(shiftDashboardDate('2026-03-01', -1)).toBe('2026-02-28');
  });
});
