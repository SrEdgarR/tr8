import { describe, expect, it } from 'vitest';
import type { PlanningState, ProjectMilestone, TaskDependency } from '../planning-types';
import type { Task } from '../types';
import { summaryMember, summaryProject, summaryProps, summaryTask } from './summary-test-fixtures';
import {
  buildTimelineModel,
  canRescheduleTimelineTask,
  civilDay,
  daysBetween,
  dependencyConflict,
  emptyTimelineFilters,
  shiftedInterval,
  shiftCivilDate,
  taskInterval,
  timelineWindow,
} from './timeline-model';

const today = '2026-10-28';
const task = (id: string, patch: Partial<Task> = {}): Task => ({ ...summaryTask, id, title: id, start_date: today, due_date: '2026-10-30', ...patch });
const edge: TaskDependency = {
  id: 'dependency',
  workspace_id: summaryProject.workspace_id,
  blocker_task_id: 'prepare',
  task_id: 'publish',
  version: 1,
  created_at: summaryTask.created_at,
};
const milestone: ProjectMilestone = {
  id: 'milestone',
  workspace_id: summaryProject.workspace_id,
  project_id: summaryProject.id,
  name: 'Publicación',
  date: today,
  completed: false,
  version: 1,
  created_at: summaryTask.created_at,
  updated_at: summaryTask.updated_at,
};
const empty: PlanningState = { dependencies: [], milestones: [] };

describe('timeline civil dates and scheduling', () => {
  it('adds whole civil days across leap years, DST and year boundaries', () => {
    expect(shiftCivilDate('2024-02-28', 1)).toBe('2024-02-29');
    expect(shiftCivilDate('2024-02-29', 1)).toBe('2024-03-01');
    expect(shiftCivilDate('2026-03-07', 2)).toBe('2026-03-09');
    expect(shiftCivilDate('2026-11-01', -1)).toBe('2026-10-31');
    expect(shiftCivilDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(civilDay('2026-02-29')).toBeNull();
    expect(civilDay('2026-13-01')).toBeNull();
    expect(civilDay('2026-1-01')).toBeNull();
  });
  it('anchors Monday windows with the original demo scales', () => {
    expect(timelineWindow(today, 'week')).toMatchObject({ start: '2026-10-05', end: '2027-01-03', days: 91, dayWidth: 32 });
    expect(timelineWindow(today, 'month')).toMatchObject({ start: '2026-08-31', days: 238, dayWidth: 11 });
  });
  it('keeps one-sided dates as one day and leaves undated tasks out of the chart', () => {
    expect(taskInterval({ start_date: null, due_date: today })).toEqual({ start: today, end: today });
    expect(taskInterval({ start_date: today, due_date: null })).toEqual({ start: today, end: today });
    expect(taskInterval({ start_date: null, due_date: null })).toBeNull();
    expect(taskInterval({ start_date: '2026-02-30', due_date: null })).toBeNull();
    expect(taskInterval({ start_date: '2026-11-02', due_date: today })).toEqual({ start: today, end: today });
  });
  it('previews move and resize without crossing either endpoint or mutating its source', () => {
    const interval = { start: today, end: '2026-10-30' };
    expect(shiftedInterval(interval, 4, 'move')).toEqual({ start: '2026-11-01', end: '2026-11-03' });
    expect(shiftedInterval(interval, 12, 'start')).toEqual({ start: '2026-10-30', end: '2026-10-30' });
    expect(shiftedInterval(interval, -12, 'end')).toEqual({ start: today, end: today });
    expect(interval).toEqual({ start: today, end: '2026-10-30' });
  });
  it('requires the next day for finish-to-start dependencies with inclusive dates', () => {
    const blocker = { start: '2026-10-27', end: today };
    expect(dependencyConflict(blocker, { start: today, end: '2026-10-30' })).toBe(true);
    expect(dependencyConflict(blocker, { start: '2026-10-29', end: '2026-10-30' })).toBe(false);
  });
});

describe('timeline authorized view model', () => {
  it('sorts scheduled tasks by start date by default and by every priority when selected without changing task data', () => {
    const tasks = [
      task('none', { priority: 'none', start_date: '2026-10-24' }),
      task('low', { priority: 'low', start_date: '2026-10-25' }),
      task('medium', { priority: 'medium', start_date: '2026-10-26' }),
      task('high', { priority: 'high', start_date: '2026-10-27' }),
      task('urgent', { priority: 'urgent', start_date: today }),
    ];
    const original = structuredClone(tasks);
    tasks.forEach(Object.freeze);
    Object.freeze(tasks);
    const data = summaryProps({ tasks });
    const chronological = buildTimelineModel(data, today, empty, emptyTimelineFilters(), 'none');
    expect(chronological.scheduled.map(value => value.id)).toEqual(['none', 'low', 'medium', 'high', 'urgent']);
    expect(buildTimelineModel(data, today, empty, emptyTimelineFilters(), 'none', undefined, 'start_date').scheduled).toEqual(chronological.scheduled);
    const prioritized = buildTimelineModel(data, today, empty, emptyTimelineFilters(), 'none', undefined, 'priority');
    expect(prioritized.groups[0].tasks.map(value => value.id)).toEqual(['urgent', 'high', 'medium', 'low', 'none']);
    expect(data.tasks).toEqual(original);
    expect(prioritized.scheduled[0]).toBe(tasks[4]);
  });
  it('breaks equal priorities by effective start date, then position, then id', () => {
    const tasks = [
      task('late', { priority: 'high', start_date: '2026-10-29', position: 0 }),
      task('z-same-position', { priority: 'high', position: 3 }),
      task('a-same-position', { priority: 'high', position: 3 }),
      task('earlier-position', { priority: 'high', position: 2 }),
      task('due-only', { priority: 'high', start_date: null, due_date: '2026-10-27', position: 99 }),
    ];
    const result = buildTimelineModel(summaryProps({ tasks }), today, empty, emptyTimelineFilters(), 'none', undefined, 'priority');
    expect(result.scheduled.map(value => value.id)).toEqual(['due-only', 'earlier-position', 'a-same-position', 'z-same-position', 'late']);
  });
  it('preserves undated input order for date sorting and orders undated tasks by priority with deterministic ties', () => {
    const undated = (id: string, patch: Partial<Task>) => task(id, { start_date: null, due_date: null, ...patch });
    const tasks = [
      undated('none', { priority: 'none' }),
      undated('low', { priority: 'low' }),
      undated('z-high', { priority: 'high', position: 2 }),
      undated('medium', { priority: 'medium' }),
      undated('urgent', { priority: 'urgent' }),
      undated('a-high', { priority: 'high', position: 2 }),
      undated('first-high', { priority: 'high', position: 1 }),
    ];
    const data = summaryProps({ tasks });
    expect(buildTimelineModel(data, today, empty).undated).toEqual(tasks);
    expect(buildTimelineModel(data, today, empty, emptyTimelineFilters(), 'status', undefined, 'priority').undated.map(value => value.id)).toEqual([
      'urgent',
      'first-high',
      'a-high',
      'z-high',
      'medium',
      'low',
      'none',
    ]);
    expect(buildTimelineModel(data, today, empty, emptyTimelineFilters(), 'status', undefined, 'start_date').undated).toEqual(tasks);
  });
  it('orders tasks within each status group and combines priority sorting with the existing filters', () => {
    const otherProject = { ...summaryProject, id: 'second-project', name: 'Distribución' };
    const tasks = [
      task('todo-low', { title: 'Preparar baja', priority: 'low', start_date: '2026-10-26' }),
      task('review-low', { title: 'Revisar baja', status: 'review', priority: 'low', start_date: '2026-10-26' }),
      task('todo-urgent', { title: 'Preparar urgente', priority: 'urgent' }),
      task('review-high', { title: 'Revisar alta', status: 'review', priority: 'high' }),
      task('wrong-project', { title: 'Preparar otro proyecto', project_id: otherProject.id }),
      task('wrong-assignee', { title: 'Preparar sin responsable', assignee_member_id: null }),
    ];
    const data = summaryProps({ projects: [summaryProject, otherProject], tasks });
    const grouped = buildTimelineModel(data, today, empty, emptyTimelineFilters(), 'status', undefined, 'priority');
    expect(grouped.groups.map(group => ({ id: group.id, tasks: group.tasks.map(value => value.id) }))).toEqual([
      { id: 'todo', tasks: ['todo-urgent', 'wrong-assignee', 'wrong-project', 'todo-low'] },
      { id: 'review', tasks: ['review-high', 'review-low'] },
    ]);
    const filtered = buildTimelineModel(
      data,
      today,
      empty,
      { query: 'PREPARAR', status: 'todo', priority: '', projectId: summaryProject.id, assigneeId: summaryMember.id },
      'project',
      undefined,
      'priority',
    );
    expect(filtered.groups.map(group => ({ id: group.id, tasks: group.tasks.map(value => value.id) }))).toEqual([
      { id: summaryProject.id, tasks: ['todo-urgent', 'todo-low'] },
    ]);
  });
  it('excludes other workspaces, archived projects/tasks, and inaccessible project data', () => {
    const archived = { ...summaryProject, id: 'archived', archived_at: summaryTask.updated_at };
    const hidden = { ...summaryProject, id: 'hidden', name: 'Secreto' };
    const foreign = { ...summaryProject, id: 'foreign', workspace_id: 'other-space' };
    const data = summaryProps({
      projects: [summaryProject, archived, hidden, foreign],
      tasks: [
        task('visible'),
        task('archived-task', { archived_at: today }),
        task('archived-project-task', { project_id: archived.id }),
        task('hidden-task', { project_id: hidden.id }),
        task('foreign-task', { project_id: foreign.id, workspace_id: foreign.workspace_id }),
        task('orphan', { project_id: 'unknown' }),
      ],
      capabilities: {
        [summaryProject.id]: { project_id: summaryProject.id, access_level: 'read', permissions: ['project.read', 'task.read'] },
        [archived.id]: { project_id: archived.id, access_level: 'read', permissions: ['project.read', 'task.read'] },
      },
    });
    const result = buildTimelineModel(data, today, empty);
    expect(result.tasks.map(value => value.id)).toEqual(['visible']);
    expect(result.projects.map(value => value.id)).toEqual([summaryProject.id]);
    expect(buildTimelineModel({ ...data, accessUnavailable: true }, today, empty).tasks).toEqual([]);
    expect(data.tasks).toHaveLength(6);
  });
  it('permits reading an explicitly opened archived project without scheduling or leaking its archived tasks', () => {
    const archived = { ...summaryProject, archived_at: today };
    const data = summaryProps({ projects: [archived], tasks: [task('visible'), task('archived', { archived_at: today })] });
    expect(buildTimelineModel(data, today, empty).tasks).toEqual([]);
    const result = buildTimelineModel(data, today, empty, emptyTimelineFilters(), 'status', archived);
    expect(result.tasks.map(value => value.id)).toEqual(['visible']);
    expect(canRescheduleTimelineTask(data, result.tasks[0], archived)).toBe(false);
    expect(buildTimelineModel({ ...data, projects: [] }, today, empty, emptyTimelineFilters(), 'status', archived).tasks).toEqual([]);
  });
  it('requires project and task read capabilities and checks edit independently', () => {
    const current = task('visible');
    const capability = { project_id: summaryProject.id, access_level: 'write' as const, permissions: ['project.read', 'task.read', 'task.edit'] };
    const data = summaryProps({ tasks: [current], capabilities: { [summaryProject.id]: capability } });
    expect(canRescheduleTimelineTask(data, current, summaryProject)).toBe(true);
    expect(canRescheduleTimelineTask({ ...data, readOnly: true }, current, summaryProject)).toBe(false);
    expect(canRescheduleTimelineTask({ ...data, pending: true }, current, summaryProject)).toBe(false);
    expect(canRescheduleTimelineTask({ ...data, capabilities: {} }, current, summaryProject)).toBe(false);
    expect(
      buildTimelineModel({ ...data, capabilities: { [summaryProject.id]: { ...capability, permissions: ['project.read'] } } }, today, empty).tasks,
    ).toEqual([]);
  });
  it('combines search, status, priority, project and authorized assignee filters', () => {
    const tasks = [
      task('portada', { title: 'Preparar portada', status: 'todo', priority: 'high' }),
      task('review', { title: 'Preparar notas', status: 'review', priority: 'high' }),
      task('undated', { start_date: null, due_date: null }),
    ];
    const result = buildTimelineModel(summaryProps({ tasks }), today, empty, {
      query: 'PREPARAR',
      status: 'todo',
      priority: 'high',
      projectId: summaryProject.id,
      assigneeId: summaryMember.id,
    });
    expect(result.tasks.map(value => value.id)).toEqual(['portada']);
    const all = buildTimelineModel(summaryProps({ tasks }), today, empty);
    expect(all.scheduled).toHaveLength(2);
    expect(all.undated.map(value => value.id)).toEqual(['undated']);
  });
  it('never names or filters a directory the user cannot read', () => {
    const data = summaryProps({ currentUserId: 'not-owner', tasks: [task('a')] });
    const result = buildTimelineModel(data, today, empty, emptyTimelineFilters(), 'assignee');
    expect(result.directoryAvailable).toBe(false);
    expect(result.members).toEqual([]);
    expect(result.effectiveGrouping).toBe('status');
    expect(buildTimelineModel(data, today, empty, { ...emptyTimelineFilters(), assigneeId: summaryMember.id }).tasks).toEqual([]);
  });
  it('keeps links only when both authorized scheduled endpoints remain in the filters', () => {
    const tasks = [task('prepare'), task('publish', { status: 'review' })];
    const state = {
      dependencies: [edge, { ...edge, id: 'wrong-space', workspace_id: 'other-space' }, { ...edge, id: 'missing', blocker_task_id: 'inaccessible' }],
      milestones: [],
    };
    const data = summaryProps({ tasks });
    expect(buildTimelineModel(data, today, state).dependencies.map(value => value.id)).toEqual([edge.id]);
    expect(buildTimelineModel(data, today, state, { ...emptyTimelineFilters(), status: 'review' }).dependencies).toEqual([]);
  });
  it('permits dependencies between readable projects in the same workspace, without leaking their other endpoint in a project view', () => {
    const otherProject = { ...summaryProject, id: 'second-project', name: 'Distribución' };
    const data = summaryProps({ projects: [summaryProject, otherProject], tasks: [task('prepare'), task('publish', { project_id: otherProject.id })] });
    const state = { dependencies: [edge], milestones: [] };
    expect(buildTimelineModel(data, today, state).dependencies).toEqual([edge]);
    expect(buildTimelineModel(data, today, state, emptyTimelineFilters(), 'status', summaryProject).dependencies).toEqual([]);
  });
  it('keeps project-colored milestones scoped, dated and sorted independently of task status', () => {
    const state = {
      dependencies: [],
      milestones: [
        milestone,
        { ...milestone, id: 'foreign', workspace_id: 'foreign' },
        { ...milestone, id: 'hidden', project_id: 'hidden' },
        { ...milestone, id: 'bad-date', date: '2026-02-30' },
      ],
    };
    expect(buildTimelineModel(summaryProps(), today, state).milestones).toEqual([milestone]);
    expect(buildTimelineModel(summaryProps(), today, state, { ...emptyTimelineFilters(), projectId: 'other' }).milestones).toEqual([]);
  });
});
