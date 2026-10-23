/**
 * Stage-2 integration checks against the designated disposable Supabase project.
 * Usage: node scripts/stage2/http-smoke.mjs <private-config.json>
 * The config/SQL fixtures live outside Git. Only publishable/anon keys and
 * synthetic example.test users are accepted. Production and privileged keys
 * are rejected before any request. Tokens stay in memory and are never logged.
 * Apply the private synthetic fixtures before each fresh run. The checks leave
 * synthetic projects and roles for browser QA; they never invite external users.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const TEST_HOST = 'kajcbwlnqcwcpbtqyieo.supabase.co';
const PRODUCTION_REF = 'ggbjezprlsnhidlbjivl';
const USERS = ['owner', 'otherOwner', 'outsider', 'editor', 'admin', 'manager', 'reader', 'assigner'];
let assertions = 0;
let requests = 0;

class SmokeError extends Error {}
function check(condition, label) {
  if (!condition) throw new SmokeError(label);
  assertions += 1;
}
function row(value) {
  return Array.isArray(value) ? value[0] : value;
}
function success(response, label) {
  check(response.status >= 200 && response.status < 300, label);
  return row(response.body);
}
function denied(response, label, code = 'PT404') {
  check(response.status >= 400 && response.status < 500 && response.body?.code === code, label);
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
  const memberIds = Object.fromEntries(['editor', 'admin', 'manager', 'reader', 'assigner'].map(name => [name, config.users[name].memberId]));
  const ownerContext = success(await rpc('owner', 'get_context'), 'owner: context failed');
  const otherContext = success(await rpc('otherOwner', 'get_context'), 'other owner: context failed');
  check(ownerContext.external_invites_enabled === false && otherContext.external_invites_enabled === false, 'external onboarding must remain disabled');
  denied(await rpc('outsider', 'get_context'), 'non-enabled outsider gained application access', '42501');
  check(
    ownerContext.workspaces.some(w => w.id === ws),
    'private fixtures did not provision test team',
  );
  const membersPage = success(await rpc('owner', 'list_members_page', { ...scope, p_limit: 100 }), 'members page failed');
  const members = new Map(membersPage.items.map(m => [m.id, m]));
  for (const name of Object.keys(memberIds)) check(members.has(memberIds[name]), `${name}: synthetic member missing`);
  const ownerMember = membersPage.items.find(m => m.user_id === config.users.owner.id);
  check(ownerMember, 'protected owner membership missing');

  async function currentMember(name) {
    const page = success(await rpc('owner', 'list_members_page', { ...scope, p_limit: 250 }), 'refresh member versions failed');
    const found = page.items.find(m => m.id === memberIds[name]);
    check(found, `${name}: membership disappeared`);
    return found;
  }
  async function setRoles(name, roles, actor = 'owner') {
    const before = await currentMember(name);
    return success(
      await rpc(actor, 'set_member_roles', { ...scope, p_member_id: memberIds[name], p_version: before.version, p_role_ids: roles }),
      `${name}: role assignment failed`,
    );
  }
  async function createRole(name, permissions) {
    const id = randomUUID();
    const args = { ...scope, p_id: id, p_name: name, p_permissions: permissions };
    const created = success(await rpc('owner', 'create_role', args), `create role ${name} failed`);
    check(created.id === id && created.version === 1, `role ${name}: identity/version invalid`);
    const retry = success(await rpc('owner', 'create_role', { ...args, p_permissions: [...permissions].reverse() }), `retry role ${name} failed`);
    check(JSON.stringify(retry) === JSON.stringify(created), `role ${name}: retry changed durable state`);
    return created;
  }
  const rolePage = success(await rpc('owner', 'list_roles', scope), 'role listing failed');
  const readRole = rolePage.items.find(r => r.template_key === 'read');
  const adminRole = rolePage.items.find(r => r.template_key === 'admin');
  check(readRole && adminRole && adminRole.permissions.length === 18, 'initial role templates changed unexpectedly');
  const editRole = await createRole('HTTP task edit', ['project.read', 'task.read', 'task.edit']);
  const assignRole = await createRole('HTTP task assign', ['project.read', 'task.read', 'task.assign']);
  const managerRole = await createRole('HTTP limited manager', [
    'member.read',
    'member.remove',
    'role.read',
    'role.manage',
    'role.assign',
    'project.read',
    'project.access.manage',
    'task.read',
    'audit.read',
  ]);
  const mutableRole = await createRole('HTTP mutable reader', ['project.read', 'task.read']);
  await setRoles('editor', [readRole.id, editRole.id]);
  await setRoles('reader', [readRole.id]);
  await setRoles('admin', [adminRole.id]);
  await setRoles('manager', [managerRole.id]);
  await setRoles('assigner', [assignRole.id]);

  const projectId = randomUUID();
  const secretId = randomUUID();
  const taskId = randomUUID();
  const secretTaskId = randomUUID();
  const projectInput = (id, name) => ({
    ...scope,
    p_id: id,
    p_name: name,
    p_description: 'Synthetic stage-2 HTTP verification',
    p_color: '#5A67D8',
    p_status: 'active',
  });
  const taskInput = (id, project, title) => ({
    ...scope,
    p_id: id,
    p_project_id: project,
    p_title: title,
    p_description: 'Synthetic stage-2 HTTP verification',
    p_status: 'todo',
    p_priority: 'high',
    p_start_date: null,
    p_due_date: null,
  });
  let project = success(await rpc('owner', 'create_project', projectInput(projectId, 'HTTP stage 2 shared project')), 'shared project creation failed');
  success(await rpc('owner', 'create_project', projectInput(secretId, 'PRIVATE HTTP PROJECT MUST NOT LEAK')), 'private project creation failed');
  let task = success(await rpc('owner', 'create_task', taskInput(taskId, projectId, 'HTTP stage 2 shared task')), 'shared task creation failed');
  success(await rpc('owner', 'create_task', taskInput(secretTaskId, secretId, 'PRIVATE HTTP TASK MUST NOT LEAK')), 'private task creation failed');
  const acl = {};
  for (const [name, access] of [
    ['editor', 'write'],
    ['reader', 'read'],
    ['manager', 'write'],
    ['assigner', 'write'],
  ]) {
    acl[name] = success(
      await rpc('owner', 'set_project_access', { ...scope, p_project_id: projectId, p_member_id: memberIds[name], p_version: 0, p_access_level: access }),
      `${name}: project access failed`,
    );
  }
  const readTask = async () => {
    const result = success(await table('owner', 'tr8_workspace_tasks', { id: `eq.${taskId}`, workspace_id: `eq.${ws}` }), 'read current task failed');
    check(result?.id === taskId, 'current task missing');
    return result;
  };
  const update = (actor, before, patch) => rpc(actor, 'update_task', { ...scope, p_id: taskId, p_version: before.version, p_patch: patch });
  const assign = (actor, before, memberId) => rpc(actor, 'assign_task', { ...scope, p_id: taskId, p_version: before.version, p_assignee_member_id: memberId });

  const caps = success(await rpc('editor', 'get_project_capabilities', { ...scope, p_project_id: projectId }), 'editor capabilities failed');
  check(
    caps.access_level === 'write' && caps.permissions.includes('task.edit') && caps.permissions.includes('task.read'),
    'multiple roles did not grant effective permissions',
  );
  const visibleProjects = await table('editor', 'tr8_workspace_projects', { workspace_id: `eq.${ws}` });
  check(
    visibleProjects.status === 200 && visibleProjects.body.length === 1 && visibleProjects.body[0].id === projectId,
    'editor can enumerate a private project',
  );
  denied(await rpc('editor', 'get_project_capabilities', { ...scope, p_project_id: secretId }), 'private capabilities leaked');
  denied(
    await rpc('editor', 'set_project_access', { ...scope, p_project_id: secretId, p_member_id: memberIds.editor, p_version: 0, p_access_level: 'write' }),
    'editor self-granted hidden project',
  );
  denied(await update('reader', task, { title: 'Read ACL bypass' }), 'read ACL permitted a task edit');
  const readerDirectory = success(await rpc('reader', 'list_members_page', scope), 'minimal reader directory failed');
  check(
    readerDirectory.items.every(
      member => Array.isArray(member.roles) && member.roles.length === 0 && Array.isArray(member.permissions) && member.permissions.length === 0,
    ) && readerDirectory.items.some(member => member.id === memberIds.admin && typeof member.display_name === 'string'),
    'member.read exposed role metadata or lost minimal names',
  );
  denied(await rpc('reader', 'list_roles', scope), 'member.read bypassed role.read');
  const managerDirectory = success(await rpc('manager', 'list_members_page', scope), 'role-authorized directory failed');
  check(
    managerDirectory.items.some(member => member.id === memberIds.admin && member.permissions?.length === 18 && Array.isArray(member.roles)),
    'role.read did not expose authorized role metadata',
  );
  const adminProjects = await table('admin', 'tr8_workspace_projects', { workspace_id: `eq.${ws}` });
  check(adminProjects.status === 200 && adminProjects.body.length === 0, 'administrator without ACL gained implicit content access');
  denied(
    await rpc('admin', 'set_project_access', { ...scope, p_project_id: secretId, p_member_id: memberIds.admin, p_version: 0, p_access_level: 'write' }),
    'administrator self-granted hidden project',
  );
  denied(await rpc('admin', 'list_project_access', { ...scope, p_project_id: secretId }), 'administrator listed hidden ACL');
  acl.admin = success(
    await rpc('owner', 'set_project_access', { ...scope, p_project_id: projectId, p_member_id: memberIds.admin, p_version: 0, p_access_level: 'read' }),
    'owner could not give administrator read access',
  );
  denied(
    await rpc('admin', 'set_project_access', {
      ...scope,
      p_project_id: projectId,
      p_member_id: memberIds.admin,
      p_version: acl.admin.version,
      p_access_level: 'write',
    }),
    'administrator raised its own read ACL',
  );
  denied(
    await rpc('manager', 'update_role', {
      ...scope,
      p_id: adminRole.id,
      p_version: adminRole.version,
      p_name: 'Downgraded superior',
      p_permissions: ['project.read', 'task.read'],
    }),
    'delegate degraded a superior role',
  );
  denied(
    await rpc('manager', 'update_role', {
      ...scope,
      p_id: managerRole.id,
      p_version: managerRole.version,
      p_name: 'Self escalation',
      p_permissions: [...managerRole.permissions, 'task.edit'],
    }),
    'delegate expanded its own assigned role',
  );
  const manager = await currentMember('manager');
  denied(
    await rpc('manager', 'set_member_roles', { ...scope, p_member_id: memberIds.manager, p_version: manager.version, p_role_ids: [adminRole.id] }),
    'delegate assigned superior role to itself',
  );
  const admin = await currentMember('admin');
  denied(await rpc('manager', 'remove_member', { ...scope, p_member_id: memberIds.admin, p_version: admin.version }), 'delegate removed superior member');
  denied(await rpc('manager', 'remove_member', { ...scope, p_member_id: ownerMember.id, p_version: ownerMember.version }), 'delegate removed protected owner');

  const assignable = success(await rpc('assigner', 'list_assignable_members', { ...scope, p_project_id: projectId }), 'assignable directory failed');
  check(
    assignable.items.some(m => m.id === memberIds.reader),
    'read-only member was not eligible as assignee',
  );
  task = success(await assign('assigner', task, memberIds.reader), 'assignment-only role could not assign a reader');
  check(task.assignee_member_id === memberIds.reader, 'assignee was not durably saved');
  denied(await update('assigner', task, { title: 'Assignment is not editing' }), 'task.assign granted general editing');
  denied(
    await update('assigner', task, { title: 'Mixed patch', assignee_member_id: memberIds.editor }),
    'mixed assignment patch bypassed field authority',
    '22023',
  );
  denied(
    await rpc('assigner', 'assign_task', { ...scope, p_id: secretTaskId, p_version: 1, p_assignee_member_id: memberIds.reader }),
    'assigner touched private task',
  );
  denied(
    await rpc('owner', 'set_project_access', { ...scope, p_project_id: projectId, p_member_id: randomUUID(), p_version: 0, p_access_level: 'read' }),
    'unknown member received project ACL',
  );

  // Real independent HTTP requests contend on the same expected version.
  const beforeConcurrent = task;
  const concurrent = await Promise.all(
    [{ title: 'HTTP concurrent A' }, { title: 'HTTP concurrent B' }].map(patch => update('editor', beforeConcurrent, patch)),
  );
  const winners = concurrent.filter(r => r.status >= 200 && r.status < 300);
  const conflicts = concurrent.filter(r => r.status === 409 && r.body?.code === 'PT409');
  check(winners.length === 1 && conflicts.length === 1, 'same-version updates did not yield one success and one PT409');
  task = await readTask();
  check(task.version === beforeConcurrent.version + 1 && task.title === row(winners[0].body).title, 'concurrent response differs from durable task');

  // Old access tokens are deliberately reused after every committed revocation.
  // Either racing write ordering is legitimate; an additional request after the
  // revocation response must always be denied. No timing/sleep assumption.
  const raceResults = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await setRoles('editor', [readRole.id, editRole.id]);
    const before = await readTask();
    const memberBefore = await currentMember('editor');
    const proposedTitle = `HTTP revocation race ${attempt}`;
    const [revocation, mutation] = await Promise.all([
      rpc('owner', 'set_member_roles', { ...scope, p_member_id: memberIds.editor, p_version: memberBefore.version, p_role_ids: [readRole.id] }),
      update('editor', before, { title: proposedTitle }),
    ]);
    success(revocation, 'concurrent role revocation failed');
    const after = await readTask();
    if (mutation.status >= 200 && mutation.status < 300) {
      check(after.version === before.version + 1 && after.title === proposedTitle, 'pre-revocation winner was not committed exactly once');
      raceResults.push('write-before-revocation');
    } else {
      denied(mutation, 'role/write race failed outside the authorization boundary');
      check(after.version === before.version && after.title === before.title, 'denied racing write changed durable task');
      raceResults.push('revocation-before-write');
    }
    denied(await update('editor', after, { title: 'Forbidden after committed revocation' }), 'old JWT wrote after role revocation committed');
    const stillVisible = await table('editor', 'tr8_workspace_tasks', { id: `eq.${taskId}` });
    check(stillVisible.status === 200 && stillVisible.body.length === 1, 'removing edit permission unexpectedly removed retained reading');
    task = after;
  }
  await setRoles('editor', [readRole.id, editRole.id]);

  // ACL revocation atomically clears an assignee and hides content from old JWT.
  success(
    await rpc('owner', 'remove_project_access', { ...scope, p_project_id: projectId, p_member_id: memberIds.reader, p_version: acl.reader.version }),
    'reader ACL removal failed',
  );
  const afterAcl = await readTask();
  check(
    afterAcl.assignee_member_id === null && afterAcl.version === task.version + 1 && Date.parse(afterAcl.updated_at) >= Date.parse(task.updated_at),
    'ACL revocation did not disassign/version atomically',
  );
  const lostRows = await table('reader', 'tr8_workspace_tasks', { id: `eq.${taskId}` });
  check(lostRows.status === 200 && lostRows.body.length === 0, 'old JWT retained task read after ACL revocation');
  task = afterAcl;
  await setRoles('reader', [mutableRole.id]);
  acl.reader = success(
    await rpc('owner', 'set_project_access', { ...scope, p_project_id: projectId, p_member_id: memberIds.reader, p_version: 0, p_access_level: 'read' }),
    'reader ACL restoration failed',
  );
  task = success(await assign('owner', task, memberIds.reader), 'reader reassignment failed');
  project = success(
    await rpc('owner', 'update_project', { ...scope, p_id: projectId, p_version: project.version, p_patch: { archived_at: new Date().toISOString() } }),
    'archive for role revocation failed',
  );
  const editedRole = success(
    await rpc('owner', 'update_role', {
      ...scope,
      p_id: mutableRole.id,
      p_version: mutableRole.version,
      p_name: 'HTTP project only',
      p_permissions: ['project.read'],
    }),
    'role permission revocation failed',
  );
  const afterRole = await readTask();
  check(afterRole.assignee_member_id === null && afterRole.version === task.version + 1, 'permission change did not clear archived task assignment');
  task = afterRole;
  const noTaskRead = await table('reader', 'tr8_workspace_tasks', { id: `eq.${taskId}` });
  check(noTaskRead.status === 200 && noTaskRead.body.length === 0, 'old JWT retained revoked task.read');
  project = success(
    await rpc('owner', 'update_project', { ...scope, p_id: projectId, p_version: project.version, p_patch: { archived_at: null } }),
    'restore archived project failed',
  );
  const restoredRole = success(
    await rpc('owner', 'update_role', {
      ...scope,
      p_id: mutableRole.id,
      p_version: editedRole.version,
      p_name: 'HTTP reader restored',
      p_permissions: ['project.read', 'task.read'],
    }),
    'restore role permissions failed',
  );
  task = success(await assign('owner', task, memberIds.reader), 'restored reader assignment failed');
  success(await rpc('owner', 'delete_role', { ...scope, p_id: mutableRole.id, p_version: restoredRole.version }), 'deleting assigned role failed');
  const afterDeleteRole = await readTask();
  check(afterDeleteRole.assignee_member_id === null && afterDeleteRole.version === task.version + 1, 'deleting assigned role did not disassign exactly once');
  task = afterDeleteRole;
  await setRoles('reader', [readRole.id]);
  task = success(await assign('owner', task, memberIds.reader), 'reader assignment before member removal failed');
  const readerBefore = await currentMember('reader');
  success(await rpc('owner', 'remove_member', { ...scope, p_member_id: memberIds.reader, p_version: readerBefore.version }), 'member removal failed');
  const afterRemoval = await readTask();
  check(afterRemoval.assignee_member_id === null && afterRemoval.version === task.version + 1, 'member removal did not disassign/version atomically');
  const removedReads = await table('reader', 'tr8_workspace_projects', { workspace_id: `eq.${ws}` });
  check(removedReads.status === 200 && removedReads.body.length === 0, 'removed member retained content via old JWT');
  denied(await update('reader', afterRemoval, { title: 'Removed user late write' }), 'removed user wrote using old JWT');
  denied(await rpc('reader', 'list_members_page', scope), 'removed user enumerated team directory');
  task = afterRemoval;

  // Audit pages contain only accessible project events and no private metadata.
  const audit = success(await rpc('admin', 'list_activity', { ...scope, p_project_id: null, p_before_id: null, p_limit: 250 }), 'administrator audit failed');
  check(
    audit.items.every(item => item.project_id === null || item.project_id === projectId),
    'audit included an inaccessible project event',
  );
  check(!JSON.stringify(audit).includes('PRIVATE HTTP') && !('total' in audit), 'audit leaked private title or aggregate count');
  check(
    audit.items.every(item => !('affected_user_id' in item) && !('email' in item) && !('payload' in item)),
    'audit exposed private target or payload fields',
  );
  denied(await rpc('admin', 'list_activity', { ...scope, p_project_id: secretId, p_before_id: null, p_limit: 50 }), 'explicit private project audit succeeded');
  const projectAudit = success(
    await rpc('owner', 'list_activity', { ...scope, p_project_id: projectId, p_before_id: null, p_limit: 250 }),
    'owner project audit failed',
  );
  check(
    projectAudit.items.some(item => item.action === 'task.unassigned' && item.resource_id === taskId),
    'automatic disassignments emitted no activity',
  );
  const roleFirstPage = success(await rpc('owner', 'list_roles', { ...scope, p_limit: 1 }), 'role pagination failed');
  check(roleFirstPage.items.length === 1 && typeof roleFirstPage.next_cursor === 'string', 'role pagination lacks bounded continuation');
  const roleNextPage = success(await rpc('owner', 'list_roles', { ...scope, p_cursor: roleFirstPage.next_cursor, p_limit: 1 }), 'role next page failed');
  check(roleNextPage.items.length === 1 && roleFirstPage.items[0].id !== roleNextPage.items[0].id, 'role pagination repeated a row');
  const capabilityPage = success(await rpc('editor', 'list_project_capabilities', { ...scope, p_limit: 100 }), 'bulk capability listing failed');
  check(capabilityPage.items.length === 1 && capabilityPage.items[0].project_id === projectId, 'bulk capabilities enumerated a private project');

  // Controlled mutations remain the only client write path.
  denied(
    await table('owner', 'tr8_workspace_tasks', { id: `eq.${taskId}` }, 'PATCH', { title: 'Direct bypass' }),
    'direct task PATCH bypassed authority',
    '42501',
  );
  denied(await table('owner', 'tr8_workspace_projects', { id: `eq.${projectId}` }, 'DELETE'), 'direct project DELETE bypassed authority', '42501');
  const anonymous = await request('/rest/v1/tr8_workspace_projects?select=id', null);
  check(anonymous.status === 401 || anonymous.status === 403, 'anonymous content read succeeded');
  check((await table('owner', 'tr8_projects')).status === 404 && (await table('owner', 'tr8_tasks')).status === 404, 'legacy content endpoints reappeared');
  denied(
    await rpc('owner', 'create_invitation', { ...scope, p_id: randomUUID(), p_email: 'still-disabled@example.test' }),
    'external invitations were enabled',
    '42501',
  );
  denied(await rpc('owner', 'accept_invitation', { p_token: 'synthetic-disabled-token' }), 'external acceptance was enabled', '42501');
  const finalContext = success(await rpc('owner', 'get_context'), 'final owner context failed');
  check(finalContext.external_invites_enabled === false, 'external gate changed during tests');
  const finalTask = await readTask();
  check(finalTask.id === taskId && finalTask.title === task.title && finalTask.version === task.version, 'denied writes changed durable task');
  const foreignRows = await table('otherOwner', 'tr8_workspace_projects', { workspace_id: `eq.${ws}` });
  check(foreignRows.status === 200 && foreignRows.body.length === 0, 'another team owner gained cross-workspace access');
  const result = {
    result: 'passed',
    projectRef: TEST_HOST.split('.')[0],
    assertions,
    requests,
    concurrency: { versionWinners: 1, staleConflicts: 1, roleRevocationRaces: raceResults },
    ids: {
      workspaceId: ws,
      projectId,
      taskId,
      secretId,
      memberIds,
      roleIds: { read: readRole.id, edit: editRole.id, admin: adminRole.id, manager: managerRole.id, assigner: assignRole.id },
    },
  };
  await writeFile(join(dirname(configPath), 'http-smoke-result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(
    error instanceof SmokeError ? `Stage-2 HTTP checks failed: ${error.message}` : 'Stage-2 HTTP checks failed: local configuration or network error',
  );
  process.exitCode = 1;
});
