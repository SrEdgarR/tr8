import { describe, expect, it } from 'vitest';
import { summaryMember, summaryProject, summaryTask } from './summary-test-fixtures';
import { defaultTaskView, filterTaskView, groupTaskView, manualTaskOrder, reorderedProjectTasks } from './task-views';

describe('task view derivation', () => {
  const today = '2026-10-27';
  const second = { ...summaryProject, id: 'project-b', name: 'Aplicación' };
  const tasks = [
    { ...summaryTask, id: 'a', title: 'Portada', status: 'todo' as const, due_date: '2026-10-26', position: 100 },
    {
      ...summaryTask,
      id: 'b',
      title: 'Publicación',
      status: 'done' as const,
      priority: 'low' as const,
      due_date: '2026-10-27',
      position: 200,
      assignee_member_id: null,
    },
    {
      ...summaryTask,
      id: 'c',
      title: 'Aplicación',
      project_id: second.id,
      status: 'progress' as const,
      priority: 'high' as const,
      due_date: null,
      position: 100,
    },
    { ...summaryTask, id: 'd', title: 'Textos', due_date: '2026-11-03', position: 300 },
  ];
  it('finds authorized work through labels and subtask titles without including another project', () => {
    const detailed = { ...tasks[0], labels: ['Accesibilidad'], subtasks: [{ id: 'subtask-a', title: 'Validar teclado', done: false }] };
    expect(filterTaskView([detailed, tasks[2]], [summaryProject], { ...defaultTaskView(), query: 'accesibilidad' }, [], today)).toEqual([detailed]);
    expect(filterTaskView([detailed], [summaryProject], { ...defaultTaskView(), query: 'validar teclado' }, [], today)).toEqual([detailed]);
  });
  it('combines search, status, project, assignee, priority and favorites without mutating the snapshot', () => {
    const before = JSON.stringify(tasks);
    const config = {
      ...defaultTaskView(),
      query: 'port',
      statuses: ['todo' as const],
      priorities: ['urgent' as const],
      projectIds: [summaryProject.id],
      assigneeIds: [summaryMember.id],
      favoritesOnly: true,
    };
    expect(filterTaskView(tasks, [summaryProject, second], config, ['a', 'c'], today).map(task => task.id)).toEqual(['a']);
    expect(JSON.stringify(tasks)).toBe(before);
    expect(filterTaskView(tasks, [summaryProject, second], { ...config, assigneeIds: ['none'] }, ['a'], today)).toEqual([]);
  });
  it('cannot reintroduce orphan or cross-workspace rows through favorites or saved filters', () => {
    const bad = [
      { ...tasks[0], id: 'orphan', project_id: 'missing' },
      { ...tasks[0], id: 'foreign', workspace_id: 'foreign-workspace' },
    ];
    const config = { ...defaultTaskView(), favoritesOnly: true };
    expect(filterTaskView([...tasks, ...bad], [summaryProject], config, ['orphan', 'foreign', 'c', 'a'], today).map(task => task.id)).toEqual(['a']);
    expect(filterTaskView(tasks, [summaryProject], { ...defaultTaskView(), projectIds: ['missing'] }, [], today)).toEqual([]);
  });
  it('distinguishes overdue open work from completed and civil-date windows', () => {
    expect(filterTaskView(tasks, [summaryProject, second], { ...defaultTaskView(), due: 'overdue' }, [], today).map(task => task.id)).toEqual(['a']);
    expect(filterTaskView(tasks, [summaryProject, second], { ...defaultTaskView(), due: 'today' }, [], today).map(task => task.id)).toEqual(['b']);
    expect(filterTaskView(tasks, [summaryProject, second], { ...defaultTaskView(), due: 'next7' }, [], today).map(task => task.id)).toEqual(['b', 'd']);
    expect(filterTaskView(tasks, [summaryProject, second], { ...defaultTaskView(), due: 'undated' }, [], today).map(task => task.id)).toEqual(['c']);
  });
  it('keeps undated tasks last in either due-date direction and orders urgent work first', () => {
    const asc = filterTaskView(tasks, [summaryProject, second], { ...defaultTaskView(), sort: 'due_date' }, [], today);
    const desc = filterTaskView(tasks, [summaryProject, second], { ...defaultTaskView(), sort: 'due_date', direction: 'desc' }, [], today);
    expect(asc.map(task => task.id)).toEqual(['a', 'b', 'd', 'c']);
    expect(desc.map(task => task.id)).toEqual(['d', 'b', 'a', 'c']);
    expect(filterTaskView(tasks, [summaryProject, second], { ...defaultTaskView(), sort: 'priority' }, [], today).map(task => task.priority)).toEqual([
      'urgent',
      'urgent',
      'high',
      'low',
    ]);
  });
  it('withdraws member names as soon as the permitted directory changes', () => {
    const config = { ...defaultTaskView(), group: 'assignee' as const };
    expect(groupTaskView(tasks, config, [summaryProject, second], [summaryMember]).some(group => group.label === summaryMember.display_name)).toBe(true);
    expect(groupTaskView(tasks, config, [summaryProject, second], []).some(group => group.label === summaryMember.display_name)).toBe(false);
    expect(groupTaskView(tasks, config, [summaryProject, second], []).map(group => group.label)).toEqual(['Responsable no disponible', 'Sin responsable']);
  });
  it('reorders only one project, retaining filtered rows and exact task versions', () => {
    const before = JSON.stringify(tasks);
    const order = reorderedProjectTasks(tasks, 'd', 'a');
    expect(order?.map(task => task.id)).toEqual(['d', 'a', 'b']);
    expect(order?.every(task => task.version === summaryTask.version)).toBe(true);
    expect(reorderedProjectTasks(tasks, 'a', 'c')).toBeNull();
    expect(reorderedProjectTasks(tasks, 'missing', 'a')).toBeNull();
    expect(JSON.stringify(tasks)).toBe(before);
    expect(manualTaskOrder(tasks.filter(task => task.project_id === summaryProject.id)).map(task => task.id)).toEqual(['a', 'b', 'd']);
  });
});
