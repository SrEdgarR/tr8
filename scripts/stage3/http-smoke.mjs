/**
 * Stage-3 HTTP integration suite. Run only after installing the calendar schema
 * in the designated disposable project. The private config reuses stage-2's
 * synthetic Auth fixtures; passwords/JWTs are never emitted or written.
 * Usage: node scripts/stage3/http-smoke.mjs <private-fixture-config.json>
 * This script rejects production and privileged keys before any network call.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const TEST_HOST = 'kajcbwlnqcwcpbtqyieo.supabase.co';
const PRODUCTION_REF = 'ggbjezprlsnhidlbjivl';
const USERS = ['owner', 'otherOwner', 'outsider', 'editor', 'admin', 'assigner'];
let assertions = 0;
let requests = 0;

class SmokeError extends Error {}
function check(condition, label) {
  if (!condition) throw new SmokeError(label);
  assertions += 1;
}
function first(value) {
  return Array.isArray(value) ? value[0] : value;
}
function success(response, label) {
  check(response.status >= 200 && response.status < 300, label);
  return first(response.body);
}
function denied(response, label, code = 'PT404') {
  check(response.status >= 400 && response.status < 500 && response.body?.code === code, label);
}
function instantEquals(a, b) {
  return typeof a === 'string' && Date.parse(a) === Date.parse(b);
}

async function main() {
  if (!process.argv[2]) throw new SmokeError('Usage: http-smoke.mjs <private-config.json>');
  const configPath = resolve(process.argv[2]);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const base = new URL(config.url);
  if (
    base.protocol !== 'https:' ||
    base.hostname !== TEST_HOST ||
    base.port ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    config.url.includes(PRODUCTION_REF)
  ) {
    throw new SmokeError('Refusing network access: only the designated disposable project is allowed');
  }
  if (typeof config.key !== 'string' || !config.key || config.key.startsWith('sb_secret_')) throw new SmokeError('A public test-project key is required');
  if (!config.key.startsWith('sb_publishable_')) {
    let claims;
    try {
      claims = JSON.parse(Buffer.from(config.key.split('.')[1] || '', 'base64url').toString('utf8'));
    } catch {
      throw new SmokeError('The configured key is not publishable/anon');
    }
    if (claims.role !== 'anon' || claims.ref !== TEST_HOST.split('.')[0]) throw new SmokeError('Privileged or foreign API keys are prohibited');
  }
  if (!/^[0-9a-f-]{36}$/i.test(config.teamId || '')) throw new SmokeError('Private test fixture team ID is required');
  for (const name of USERS) {
    const user = config.users?.[name];
    if (!user || !/^[^@\s]+@example\.test$/i.test(user.email) || typeof user.password !== 'string' || user.password.length < 20)
      throw new SmokeError('Only synthetic example.test users with strong disposable passwords are permitted');
  }

  async function request(path, token, method = 'GET', body) {
    requests += 1;
    const response = await fetch(new URL(path, base), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        apikey: config.key,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    let parsed = null;
    try {
      if (raw) parsed = JSON.parse(raw);
    } catch {
      throw new SmokeError('The test API returned a non-JSON response');
    }
    return { status: response.status, body: parsed };
  }
  const tokens = {};
  for (const name of USERS) {
    const user = config.users[name];
    const login = success(
      await request('/auth/v1/token?grant_type=password', null, 'POST', { email: user.email, password: user.password }),
      `${name}: synthetic password login failed`,
    );
    check(typeof login.access_token === 'string' && login.access_token.length > 20, `${name}: access token missing`);
    tokens[name] = login.access_token;
  }
  const rpc = (actor, name, params = {}) => request(`/rest/v1/rpc/tr8_v2_${name}`, tokens[actor], 'POST', params);
  const table = (actor, name, filters = {}, method = 'GET', body) =>
    request(`/rest/v1/${name}?${new URLSearchParams({ select: '*', ...filters })}`, tokens[actor], method, body);
  const ws = config.teamId;
  const scope = { p_workspace_id: ws };
  const context = success(await rpc('owner', 'get_context'), 'owner context failed');
  check(context.external_invites_enabled === false, 'external onboarding must remain disabled');
  check(
    context.workspaces.some(workspace => workspace.id === ws),
    'synthetic collaboration team is missing',
  );
  denied(await rpc('outsider', 'get_context'), 'non-enabled outsider gained application access', '42501');

  const savedRoles = new Map();
  async function member(name) {
    const page = success(await rpc('owner', 'list_members_page', { ...scope, p_limit: 250 }), 'refresh member failed');
    const found = page.items.find(item => item.id === config.users[name].memberId);
    check(found?.status === 'active', `${name}: active synthetic member missing`);
    return found;
  }
  async function setRoles(name, ids) {
    const before = await member(name);
    return success(
      await rpc('owner', 'set_member_roles', { ...scope, p_member_id: before.id, p_version: before.version, p_role_ids: ids }),
      `${name}: role setup failed`,
    );
  }
  for (const name of ['editor', 'admin', 'assigner'])
    savedRoles.set(
      name,
      (await member(name)).roles.map(role => role.id),
    );

  let result;
  try {
    result = await exercise();
  } finally {
    // Restore only role bindings changed by this suite. Synthetic work remains
    // available for browser QA, and no invitation or external signup is issued.
    for (const [name, ids] of savedRoles) await setRoles(name, ids);
  }
  result.assertions = assertions;
  result.requests = requests;
  await writeFile(join(dirname(configPath), 'http-stage3-result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));

  async function exercise() {
    const roleIds = {};
    for (const [key, permissions] of Object.entries({
      read: ['project.read', 'task.read'],
      edit: ['project.read', 'task.read', 'task.edit'],
      assign: ['project.read', 'task.read', 'task.assign'],
      noProject: ['task.read', 'task.edit'],
      noTask: ['project.read', 'task.edit'],
    })) {
      const id = randomUUID();
      const created = success(
        await rpc('owner', 'create_role', { ...scope, p_id: id, p_name: `HTTP stage 3 ${key}`, p_permissions: permissions }),
        `${key}: create synthetic role failed`,
      );
      check(created.id === id, `${key}: role creation identity changed`);
      roleIds[key] = id;
    }
    await setRoles('editor', [roleIds.edit]);
    await setRoles('assigner', [roleIds.assign]);
    const templates = success(await rpc('owner', 'list_roles', scope), 'load role templates failed');
    const adminRole = templates.items.find(role => role.template_key === 'admin');
    check(adminRole?.permissions.length === 18, 'admin template is missing');
    await setRoles('admin', [adminRole.id]);

    const beforePreferences = success(await rpc('owner', 'get_calendar_preferences'), 'read own calendar preference failed');
    const otherBefore = success(await rpc('otherOwner', 'get_calendar_preferences'), 'read another own preference failed');
    check(Number.isInteger(beforePreferences.version) && beforePreferences.version >= 1, 'calendar preference lacks version');
    let preferences = success(
      await rpc('owner', 'set_calendar_preferences', { p_version: beforePreferences.version, p_time_zone: 'America/La_Paz' }),
      'save explicit IANA preference failed',
    );
    check(
      preferences.time_zone === 'America/La_Paz' && preferences.version === beforePreferences.version + 1,
      'preference write did not confirm durable version',
    );
    denied(
      await rpc('owner', 'set_calendar_preferences', { p_version: beforePreferences.version, p_time_zone: 'Asia/Tokyo' }),
      'stale preference overwrote current value',
      'PT409',
    );
    for (const zone of ['EST', '+04:00', 'Europe/Not_A_Zone', ' UTC', 'posix/America/New_York', 'right/America/New_York', null]) {
      denied(
        await rpc('owner', 'set_calendar_preferences', { p_version: preferences.version, p_time_zone: zone }),
        'invalid/non-IANA profile zone was accepted',
        '22023',
      );
    }
    const otherAfter = success(await rpc('otherOwner', 'get_calendar_preferences'), 'reread other preference failed');
    check(JSON.stringify(otherAfter) === JSON.stringify(otherBefore), 'setting own preference modified another user');
    denied(await rpc('outsider', 'get_calendar_preferences'), 'unapproved account read calendar profile', '42501');

    const projectId = randomUUID();
    const secretId = randomUUID();
    const personalProjectId = randomUUID();
    const personalId = context.personal_workspace_id;
    async function createProject(id, workspaceId, name) {
      const created = success(
        await rpc('owner', 'create_project', {
          p_workspace_id: workspaceId,
          p_id: id,
          p_name: name,
          p_description: 'Synthetic internal calendar verification',
          p_color: '#5A67D8',
          p_status: 'active',
        }),
        'create calendar fixture project failed',
      );
      check(created.id === id, 'project creation changed its identity');
      return created;
    }
    let project = await createProject(projectId, ws, 'HTTP stage 3 calendar');
    await createProject(secretId, ws, 'PRIVATE STAGE 3 PROJECT');
    await createProject(personalProjectId, personalId, 'HTTP stage 3 personal calendar');
    const acls = {};
    for (const name of ['editor', 'assigner']) {
      acls[name] = success(
        await rpc('owner', 'set_project_access', {
          ...scope,
          p_project_id: projectId,
          p_member_id: config.users[name].memberId,
          p_version: 0,
          p_access_level: 'write',
        }),
        'create synthetic calendar ACL failed',
      );
    }

    async function createTask(title, startDate = null, dueDate = null, targetProject = projectId, targetWorkspace = ws, status = 'todo') {
      const id = randomUUID();
      const task = success(
        await rpc('owner', 'create_task', {
          p_workspace_id: targetWorkspace,
          p_id: id,
          p_project_id: targetProject,
          p_title: title,
          p_description: 'Synthetic internal calendar verification',
          p_status: status,
          p_priority: 'medium',
          p_start_date: startDate,
          p_due_date: dueDate,
        }),
        'create calendar fixture task failed',
      );
      check(
        task.id === id && task.scheduled_start_at === null && task.scheduled_end_at === null && task.scheduled_time_zone === null,
        'legacy creation changed scheduling defaults',
      );
      return task;
    }
    const schedule = (actor, task, start, end, zone = 'America/New_York') =>
      rpc(actor, 'schedule_task', {
        p_workspace_id: task.workspace_id,
        p_id: task.id,
        p_version: task.version,
        p_scheduled_start_at: start,
        p_scheduled_end_at: end,
        p_scheduled_time_zone: zone,
      });
    const readTask = async task => {
      const current = success(
        await table('owner', 'tr8_workspace_tasks', { workspace_id: `eq.${task.workspace_id}`, id: `eq.${task.id}` }),
        'read fixture task failed',
      );
      check(current?.id === task.id, 'fixture task disappeared');
      return current;
    };
    let dual = await createTask('HTTP dual block and due', '2026-10-31', '2026-11-01');
    const due = await createTask('HTTP due civil date', null, '2026-11-02');
    const start = await createTask('HTTP start fallback', '2026-11-03');
    const span = await createTask('HTTP start does not span', '2026-10-31', '2026-11-04');
    const unscheduled = await createTask('HTTP no schedule');
    const unscheduledSecond = await createTask('HTTP second no schedule');
    let overlap = await createTask('HTTP overlapping window');
    let after = await createTask('HTTP exclusive window end');
    let before = await createTask('HTTP exclusive window start');
    const secret = await createTask('PRIVATE STAGE 3 TASK', null, '2026-11-02', secretId);
    const personal = await createTask('HTTP personal mine task', null, '2026-11-02', personalProjectId, personalId);
    const completed = await createTask('HTTP completed due', null, '2026-11-02', projectId, ws, 'done');
    dual = success(await schedule('editor', dual, '2026-11-01T01:30:30-04:00', '2026-11-01T01:30:45-05:00'), 'explicit repeated-hour scheduling failed');
    check(
      instantEquals(dual.scheduled_start_at, '2026-11-01T05:30:30Z') && instantEquals(dual.scheduled_end_at, '2026-11-01T06:30:45Z'),
      'DST repeated-hour instants or seconds were changed',
    );
    check(dual.due_date === '2026-11-01' && dual.start_date === '2026-10-31', 'scheduling changed independent civil dates');
    overlap = success(await schedule('owner', overlap, '2026-11-05T02:00:00Z', '2026-11-05T06:00:00Z'), 'overlap scheduling failed');
    after = success(await schedule('owner', after, '2026-11-05T05:00:00Z', '2026-11-05T06:00:00Z'), 'end-boundary scheduling failed');
    before = success(await schedule('owner', before, '2026-11-01T03:00:00Z', '2026-11-01T04:00:00Z'), 'start-boundary scheduling failed');

    const calendarArgs = {
      p_workspace_ids: [ws],
      p_date_from: '2026-11-01',
      p_date_to: '2026-11-05',
      p_time_zone: 'America/New_York',
      p_project_ids: [projectId],
    };
    const calendar = (actor, extra = {}) => rpc(actor, 'list_calendar', { ...calendarArgs, ...extra });
    const unscheduledArgs = { p_workspace_ids: [ws], p_project_ids: [projectId] };
    const listUnscheduled = (actor, extra = {}) => rpc(actor, 'list_unscheduled', { ...unscheduledArgs, ...extra });
    const all = success(await calendar('editor'), 'authorized calendar listing failed');
    const expectedItems = [
      dual.id + ':block',
      dual.id + ':due',
      due.id + ':due',
      start.id + ':start',
      span.id + ':due',
      overlap.id + ':block',
      completed.id + ':due',
    ];
    check(
      all.items.length === expectedItems.length && expectedItems.every(id => all.items.some(item => item.id === id)),
      'calendar projection/boundary set is incorrect',
    );
    check(
      all.items.every(item => item.workspace_id === ws && item.project_id === projectId && item.task_id !== secret.id && item.task_id !== unscheduled.id),
      'calendar leaked a private/undated task',
    );
    check(
      all.items.every(item => item.can_edit === true && typeof item.workspace_name === 'string'),
      'calendar omitted effective edit capability or workspace label',
    );
    check(
      all.items.every(item => !Object.hasOwn(item, 'description') && !Object.hasOwn(item, 'email') && !Object.hasOwn(item, 'owner_id')),
      'calendar projection contains unnecessary private fields',
    );
    check(
      all.items.filter(item => item.task_id === dual.id).length === 2 && all.items.every(item => item.task_id !== span.id || item.kind === 'due'),
      'block/due identity or start fallback precedence is incorrect',
    );
    const noDates = success(await listUnscheduled('editor'), 'unscheduled listing failed');
    check(
      noDates.items.length === 2 && noDates.items.every(item => [unscheduled.id, unscheduledSecond.id].includes(item.task_id) && item.kind === 'unscheduled'),
      'unscheduled projection is incorrect',
    );
    const completedOnly = success(await calendar('editor', { p_statuses: ['done'] }), 'status filter failed');
    check(completedOnly.items.length === 1 && completedOnly.items[0].task_id === completed.id, 'status filter returned incorrect tasks');

    for (const timeZone of ['UTC', 'America/La_Paz', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
      const changedZone = success(await calendar('editor', { p_time_zone: timeZone }), 'calendar display zone change failed');
      check(changedZone.items.find(item => item.id === dual.id + ':due')?.date === '2026-11-01', 'changing display zone shifted a civil due date');
      const block = changedZone.items.find(item => item.id === dual.id + ':block');
      check(
        block && instantEquals(block.start_at, dual.scheduled_start_at) && instantEquals(block.end_at, dual.scheduled_end_at),
        'changing display zone changed block instants',
      );
    }
    // March's civil DST day has 23 real hours. Exact window boundaries are
    // converted independently instead of adding 24 hours to an instant.
    let springInside = await createTask('HTTP spring late hour');
    let springOutside = await createTask('HTTP spring exclusive end');
    springInside = success(await schedule('owner', springInside, '2026-03-09T03:30:00Z', '2026-03-09T03:59:59Z'), 'spring inner fixture failed');
    springOutside = success(await schedule('owner', springOutside, '2026-03-09T04:00:00Z', '2026-03-09T04:30:00Z'), 'spring end fixture failed');
    const spring = success(await calendar('editor', { p_date_from: '2026-03-08', p_date_to: '2026-03-09' }), 'spring DST window failed');
    check(
      spring.items.some(item => item.task_id === springInside.id) && spring.items.every(item => item.task_id !== springOutside.id),
      'DST window used a fixed 24-hour duration',
    );

    // Private project filters are selections, not an existence probe.
    const editorMixed = success(await calendar('editor', { p_project_ids: [projectId, secretId] }), 'authorized/private mixed project selection failed');
    check(
      editorMixed.items.length === all.items.length && editorMixed.items.every(item => item.project_id === projectId),
      'project filters exposed a hidden project',
    );
    const adminHidden = success(await calendar('admin', { p_project_ids: [projectId, secretId] }), 'administrator hidden selection failed');
    check(adminHidden.items.length === 0 && adminHidden.next_cursor === null, 'administrator without ACL enumerated hidden calendar items');
    const privateSelection = success(await calendar('editor', { p_project_ids: [secretId] }), 'private selection failed closed incorrectly');
    const missingSelection = success(await calendar('editor', { p_project_ids: [randomUUID()] }), 'missing selection failed closed incorrectly');
    check(JSON.stringify(privateSelection) === JSON.stringify(missingSelection), 'hidden and nonexistent project filters reveal existence');
    const ownerHidden = success(await calendar('owner', { p_project_ids: [secretId] }), 'protected owner cannot read private calendar');
    check(ownerHidden.items.length === 1 && ownerHidden.items[0].task_id === secret.id, 'protected owner lost private project access');
    denied(await calendar('otherOwner'), 'another team owner gained cross-workspace calendar access');
    const otherContext = success(await rpc('otherOwner', 'get_context'), 'other owner context failed');
    denied(
      await calendar('owner', { p_workspace_ids: [ws, otherContext.personal_workspace_id] }),
      'a multi-workspace calendar returned partial content for an unauthorized explicit space',
    );
    denied(await calendar('outsider'), 'unapproved account accessed calendar', '42501');
    denied(await request('/rest/v1/rpc/tr8_v2_list_calendar', null, 'POST', calendarArgs), 'anonymous calendar access succeeded', '42501');

    // Mine means personal work plus assigned team work; it does not default the
    // general calendar to only the current actor's own tasks.
    const mineBefore = success(await calendar('editor', { p_mine: true }), 'mine empty filter failed');
    check(mineBefore.items.length === 0, 'unassigned team tasks were treated as mine');
    const assigned = success(
      await rpc('owner', 'assign_task', { ...scope, p_id: due.id, p_version: due.version, p_assignee_member_id: config.users.editor.memberId }),
      'fixture assignment failed',
    );
    const mineAfter = success(await calendar('editor', { p_mine: true }), 'mine assignment filter failed');
    check(mineAfter.items.length === 1 && mineAfter.items[0].task_id === assigned.id, 'mine did not select only assigned work');
    const byAssignee = success(await calendar('owner', { p_assignee_member_ids: [config.users.editor.memberId] }), 'assignee filter failed');
    check(byAssignee.items.length === 1 && byAssignee.items[0].task_id === due.id, 'assignee filter does not match assignment');
    const ownerMine = success(
      await calendar('owner', { p_workspace_ids: [personalId, ws], p_project_ids: [personalProjectId, projectId], p_mine: true }),
      'multi-workspace personal mine failed',
    );
    check(ownerMine.items.length === 1 && ownerMine.items[0].task_id === personal.id, 'owner mine includes unassigned team work or excludes personal work');
    for (const extra of [{ p_project_ids: [] }, { p_assignee_member_ids: [] }, { p_statuses: [] }]) {
      check(success(await calendar('owner', extra), 'empty selection failed').items.length === 0, 'empty filter selection expanded to all tasks');
    }

    // Stable pagination includes the item kind in the key, and cursors bind to
    // the normalized query scope while authorization is rechecked every page.
    let cursor = null;
    const paginated = [];
    let firstCursor;
    do {
      const page = success(await calendar('editor', { p_cursor: cursor, p_limit: 1 }), 'calendar cursor page failed');
      check(page.items.length <= 1, 'calendar pagination exceeded its limit');
      paginated.push(...page.items.map(item => item.id));
      if (!firstCursor) firstCursor = page.next_cursor;
      cursor = page.next_cursor;
      check(paginated.length <= expectedItems.length, 'calendar pagination failed to terminate');
    } while (cursor);
    check(
      new Set(paginated).size === expectedItems.length && expectedItems.every(id => paginated.includes(id)),
      'calendar cursor dropped or duplicated a task kind',
    );
    check(typeof firstCursor === 'string', 'calendar did not issue a continuation cursor');
    for (const extra of [
      { p_time_zone: 'UTC' },
      { p_date_from: '2026-10-31' },
      { p_date_to: '2026-11-06' },
      { p_project_ids: [secretId] },
      { p_statuses: ['todo'] },
      { p_assignee_member_ids: [config.users.editor.memberId] },
      { p_mine: true },
      { p_include_archived: true },
      { p_workspace_ids: [personalId, ws] },
    ]) {
      denied(await calendar('owner', { ...extra, p_cursor: firstCursor }), 'calendar cursor was reused with a different filter scope', '22023');
    }
    const normalized = success(
      await calendar('editor', { p_workspace_ids: [ws, ws], p_project_ids: [projectId, projectId], p_cursor: firstCursor, p_limit: 1 }),
      'equivalent normalized cursor scope was rejected',
    );
    check(normalized.items.length === 1 && normalized.items[0].id !== paginated[0], 'normalized cursor repeated its previous row');
    const unPage = success(await listUnscheduled('editor', { p_limit: 1 }), 'unscheduled cursor first page failed');
    check(unPage.items.length === 1 && typeof unPage.next_cursor === 'string', 'unscheduled cursor was not bounded');
    const unNext = success(await listUnscheduled('editor', { p_limit: 1, p_cursor: unPage.next_cursor }), 'unscheduled cursor next page failed');
    check(
      unNext.items.length === 1 && unNext.items[0].id !== unPage.items[0].id && unNext.next_cursor === null,
      'unscheduled cursor did not terminate without duplicates',
    );
    denied(await listUnscheduled('editor', { p_cursor: firstCursor }), 'calendar cursor was accepted as unscheduled cursor', '22023');
    denied(await calendar('editor', { p_cursor: unPage.next_cursor }), 'unscheduled cursor was accepted as calendar cursor', '22023');
    const ownerCursor = success(await calendar('owner', { p_project_ids: [projectId, secretId], p_limit: 1 }), 'owner mixed page failed').next_cursor;
    const replay = success(
      await calendar('editor', { p_project_ids: [projectId, secretId], p_cursor: ownerCursor, p_limit: 250 }),
      'cross-actor cursor reauthorization failed',
    );
    check(
      replay.items.every(item => item.project_id === projectId),
      'owner cursor conferred private project authority',
    );
    for (const invalid of [
      '',
      '%%%invalid%%%',
      Buffer.from(JSON.stringify({ scope: {}, sort_at: 'infinity', task_id: due.id, kind: 'due' })).toString('base64'),
      'x'.repeat(32769),
    ]) {
      denied(await calendar('editor', { p_cursor: invalid }), 'malformed cursor accepted', '22023');
    }

    for (const extra of [
      { p_workspace_ids: [] },
      { p_workspace_ids: null },
      { p_workspace_ids: Array(51).fill(ws) },
      { p_workspace_ids: [ws, null] },
      { p_date_from: null },
      { p_date_to: '2026-11-01' },
      { p_date_to: '2026-10-31' },
      { p_date_from: '2026-01-01', p_date_to: '2026-04-05' },
      { p_time_zone: 'EST' },
      { p_time_zone: 'Not/A_Zone' },
      { p_statuses: ['unknown'] },
      { p_statuses: [null] },
      { p_mine: null },
      { p_include_archived: null },
      { p_limit: 0 },
      { p_limit: 251 },
      { p_limit: null },
      { p_project_ids: Array(251).fill(projectId) },
      { p_assignee_member_ids: [null] },
    ]) {
      denied(await calendar('owner', extra), 'invalid or unbounded calendar input accepted', '22023');
    }
    success(
      await calendar('owner', { p_date_from: '2026-01-01', p_date_to: '2026-04-04', p_limit: 250 }),
      'valid maximum 93-day/250-item request was rejected',
    );

    const untouchedVersion = dual.version;
    for (const values of [
      [null, '2026-11-01T07:00:00Z', 'America/New_York'],
      ['2026-11-01T06:00:00Z', null, 'America/New_York'],
      ['2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z', null],
      ['2026-11-01T06:00:00', '2026-11-01T07:00:00', 'America/New_York'],
      ['2026-11-01T24:00:00Z', '2026-11-02T01:00:00Z', 'America/New_York'],
      ['2026-02-30T06:00:00Z', '2026-03-01T07:00:00Z', 'America/New_York'],
      ['infinity', 'infinity', 'America/New_York'],
      ['2026-11-01T07:00:00Z', '2026-11-01T06:00:00Z', 'America/New_York'],
      ['2026-11-01T06:00:00Z', '2026-11-01T06:00:00Z', 'America/New_York'],
      ['2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z', 'EST'],
      ['2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z', 'posix/America/New_York'],
    ]) {
      denied(await schedule('editor', dual, ...values), 'invalid/ambiguous scheduled input accepted', '22023');
    }
    check((await readTask(dual)).version === untouchedVersion, 'rejected schedule changed durable version');
    denied(await schedule('assigner', dual, '2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z'), 'task.assign permitted scheduling content');
    const hiddenInvalid = await schedule('editor', { ...secret, version: 1 }, 'bad', 'bad', 'bad');
    const missingInvalid = await schedule('editor', { ...secret, id: randomUUID(), version: 1 }, 'bad', 'bad', 'bad');
    denied(hiddenInvalid, 'hidden task schedule validation leaked content');
    denied(missingInvalid, 'missing task schedule returned a different class');
    check(hiddenInvalid.body.message === missingInvalid.body.message, 'schedule operation exposes resource existence');

    const updated = success(
      await rpc('editor', 'update_task', { ...scope, p_id: dual.id, p_version: dual.version, p_patch: { title: 'HTTP legacy edit preserves block' } }),
      'legacy content update failed after scheduling',
    );
    check(
      instantEquals(updated.scheduled_start_at, dual.scheduled_start_at) &&
        instantEquals(updated.scheduled_end_at, dual.scheduled_end_at) &&
        updated.scheduled_time_zone === dual.scheduled_time_zone,
      'legacy content update erased or changed schedule',
    );
    dual = updated;
    denied(
      await rpc('editor', 'update_task', { ...scope, p_id: dual.id, p_version: dual.version, p_patch: { scheduled_start_at: '2026-11-01T06:00:00Z' } }),
      'legacy patch bypassed dedicated schedule API',
      '22023',
    );
    const concurrent = await Promise.all([
      schedule('editor', dual, '2026-11-01T05:31:30Z', '2026-11-01T06:31:45Z'),
      schedule('owner', dual, '2026-11-01T05:32:30Z', '2026-11-01T06:32:45Z'),
    ]);
    check(
      concurrent.filter(response => response.status === 200).length === 1 &&
        concurrent.filter(response => response.status === 409 && response.body?.code === 'PT409').length === 1,
      'concurrent scheduling did not produce one winner and one stale conflict',
    );
    dual = await readTask(dual);
    check(dual.version === updated.version + 1, 'concurrent schedule bumped version more than once');

    // Existing JWTs never cache role authority. Both project.read and task.read
    // are required; read ACL blocks edits despite role task.edit.
    for (const role of [roleIds.noProject, roleIds.noTask]) {
      await setRoles('editor', [role]);
      denied(await calendar('editor'), 'missing content dependency still listed calendar');
      denied(await listUnscheduled('editor'), 'missing content dependency still listed undated work');
      denied(await schedule('editor', dual, '2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z'), 'missing content dependency still changed schedule');
      const editorContext = success(await rpc('editor', 'get_context'), 'editor own context failed after role revocation');
      denied(
        await calendar('editor', { p_workspace_ids: [editorContext.personal_workspace_id, ws] }),
        'a multi-workspace calendar ignored a live role revocation in another selected space',
      );
    }
    await setRoles('editor', [roleIds.edit]);
    acls.editor = success(
      await rpc('owner', 'set_project_access', {
        ...scope,
        p_project_id: projectId,
        p_member_id: config.users.editor.memberId,
        p_version: acls.editor.version,
        p_access_level: 'read',
      }),
      'read-only ACL setup failed',
    );
    const readOnly = success(await calendar('editor'), 'read-only calendar listing failed');
    check(
      readOnly.items.length === expectedItems.length && readOnly.items.every(item => item.can_edit === false),
      'read ACL had incorrect effective edit capability',
    );
    denied(await schedule('editor', dual, '2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z'), 'read-only ACL permitted scheduling');
    acls.editor = success(
      await rpc('owner', 'set_project_access', {
        ...scope,
        p_project_id: projectId,
        p_member_id: config.users.editor.memberId,
        p_version: acls.editor.version,
        p_access_level: 'write',
      }),
      'write ACL restoration failed',
    );
    const beforeRevoke = success(await calendar('editor', { p_limit: 1 }), 'pre-revocation cursor failed');
    success(
      await rpc('owner', 'remove_project_access', {
        ...scope,
        p_project_id: projectId,
        p_member_id: config.users.editor.memberId,
        p_version: acls.editor.version,
      }),
      'ACL revocation failed',
    );
    const afterRevoke = success(await calendar('editor', { p_cursor: beforeRevoke.next_cursor }), 'calendar did not reauthorize revoked page');
    check(afterRevoke.items.length === 0 && afterRevoke.next_cursor === null, 'old cursor/JWT retained revoked calendar content');
    check(success(await listUnscheduled('editor'), 'revoked unscheduled selection failed').items.length === 0, 'old JWT retained revoked undated work');
    denied(await schedule('editor', dual, '2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z'), 'old JWT retained scheduling after ACL revocation');
    acls.editor = success(
      await rpc('owner', 'set_project_access', {
        ...scope,
        p_project_id: projectId,
        p_member_id: config.users.editor.memberId,
        p_version: 0,
        p_access_level: 'write',
      }),
      'ACL recreation failed',
    );

    dual = success(
      await rpc('owner', 'assign_task', { ...scope, p_id: dual.id, p_version: dual.version, p_assignee_member_id: config.users.editor.memberId }),
      'archived cleanup assignment setup failed',
    );
    const beforeArchive = { ...dual };
    project = success(
      await rpc('owner', 'update_project', { ...scope, p_id: project.id, p_version: project.version, p_patch: { archived_at: new Date().toISOString() } }),
      'archive fixture project failed',
    );
    check(success(await calendar('owner'), 'archived default selection failed').items.length === 0, 'archived tasks appeared by default');
    const archived = success(await calendar('editor', { p_include_archived: true }), 'archived read selection failed');
    check(
      archived.items.length === expectedItems.length && archived.items.every(item => item.can_edit === false && item.project_archived_at),
      'archive read or edit capability is incorrect',
    );
    denied(await schedule('owner', dual, '2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z'), 'archived task schedule was editable', 'PT409');
    await setRoles('editor', [roleIds.noTask]);
    dual = await readTask(dual);
    check(dual.assignee_member_id === null && dual.version === beforeArchive.version + 1, 'role revocation did not atomically clear archived assignment');
    check(
      instantEquals(dual.scheduled_start_at, beforeArchive.scheduled_start_at) &&
        instantEquals(dual.scheduled_end_at, beforeArchive.scheduled_end_at) &&
        dual.scheduled_time_zone === beforeArchive.scheduled_time_zone,
      'archived assignment cleanup changed scheduled fields',
    );
    for (const key of ['title', 'description', 'status', 'priority', 'start_date', 'due_date', 'position', 'task_number', 'created_at']) {
      check(dual[key] === beforeArchive[key], 'archived assignment cleanup altered historical task content');
    }
    await setRoles('editor', [roleIds.edit]);
    project = success(
      await rpc('owner', 'update_project', { ...scope, p_id: project.id, p_version: project.version, p_patch: { archived_at: null } }),
      'fixture project restoration failed',
    );
    const cleared = success(await schedule('editor', dual, null, null, null), 'clear complete schedule failed');
    check(
      cleared.scheduled_start_at === null && cleared.scheduled_end_at === null && cleared.scheduled_time_zone === null && cleared.due_date === dual.due_date,
      'clearing schedule erased independent due date or retained partial fields',
    );
    dual = success(
      await schedule('editor', cleared, beforeArchive.scheduled_start_at, beforeArchive.scheduled_end_at, beforeArchive.scheduled_time_zone),
      'restore QA schedule failed',
    );

    denied(
      await table('owner', 'tr8_workspace_tasks', { id: `eq.${dual.id}` }, 'PATCH', {
        scheduled_start_at: '2026-11-01T06:00:00Z',
        scheduled_end_at: '2026-11-01T07:00:00Z',
        scheduled_time_zone: 'UTC',
      }),
      'direct schedule PATCH bypassed RPC controls',
      '42501',
    );
    denied(
      await rpc('owner', 'create_invitation', { ...scope, p_id: randomUUID(), p_email: 'still-disabled@example.test' }),
      'external invitations were enabled',
      '42501',
    );
    denied(await rpc('owner', 'accept_invitation', { p_token: 'synthetic-stage3-disabled-token' }), 'external acceptance was enabled', '42501');
    check(
      success(await rpc('owner', 'get_context'), 'final context failed').external_invites_enabled === false,
      'external signup gate changed during scheduling',
    );
    if (beforePreferences.time_zone && beforePreferences.time_zone !== preferences.time_zone) {
      preferences = success(
        await rpc('owner', 'set_calendar_preferences', { p_version: preferences.version, p_time_zone: beforePreferences.time_zone }),
        'restore synthetic profile preference failed',
      );
    }
    return {
      result: 'passed',
      projectRef: TEST_HOST.split('.')[0],
      concurrency: { scheduleWinners: 1, staleConflicts: 1 },
      ids: {
        workspaceId: ws,
        personalWorkspaceId: personalId,
        projectId,
        secretId,
        personalProjectId,
        taskId: dual.id,
        unscheduledTaskId: unscheduled.id,
        roleIds,
      },
    };
  }
}

main().catch(error => {
  console.error(
    error instanceof SmokeError ? `Stage-3 HTTP checks failed: ${error.message}` : 'Stage-3 HTTP checks failed: local configuration or network error',
  );
  process.exitCode = 1;
});
