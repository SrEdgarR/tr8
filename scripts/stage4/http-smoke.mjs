/**
 * Stage-4A integration checks against the designated disposable project only.
 * Usage: node scripts/stage4/http-smoke.mjs <private-fixture-config.json>
 * Reuses synthetic example.test Auth fixtures. No privileged key, external
 * invitation, email, Google request or production fixture is accepted.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const TEST_HOST = 'kajcbwlnqcwcpbtqyieo.supabase.co';
const PRODUCTION_REF = 'ggbjezprlsnhidlbjivl';
const USERS = ['owner', 'otherOwner', 'outsider', 'editor'];
const STATES = ['pending', 'leased', 'retry', 'succeeded', 'cancelled', 'unknown', 'dead'];
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
function unavailable(response, label) {
  check(response.status >= 400 && response.status < 500, label);
}
function statusShape(status) {
  check(status?.channels?.email === false && status.channels.google === false, 'external provider gates changed');
  check(typeof status.scheduler?.enabled === 'boolean', 'scheduler state missing');
  check(status.scheduler.last_run_at === null || Number.isFinite(Date.parse(status.scheduler.last_run_at)), 'invalid worker heartbeat');
  check(status.budget?.daily_limit === 500 && status.budget.monthly_limit === 10000, 'internal free-tier budget changed');
  check(status.budget.batch_limit === 20 && status.budget.max_attempts === 8, 'unbounded worker batch or retry policy');
  for (const key of ['used_today', 'used_month']) check(Number.isSafeInteger(status.budget[key]) && status.budget[key] >= 0, 'invalid scoped budget counter');
  check(typeof status.budget.blocked === 'boolean', 'budget circuit state missing');
  check(status.retention_days === 30, 'operational retention contract changed');
  check(status.counts && Object.keys(status.counts).sort().join('|') === [...STATES].sort().join('|'), 'unknown process states returned');
  for (const state of STATES) check(Number.isSafeInteger(status.counts[state]) && status.counts[state] >= 0, 'invalid scoped process count');
  check(Array.isArray(status.jobs) && status.jobs.length <= 20, 'status list is unbounded');
  const keys = ['id', 'entity_kind', 'event_kind', 'state', 'attempts', 'created_at', 'available_at', 'finished_at', 'reason'].sort().join('|');
  for (const job of status.jobs) {
    check(Object.keys(job).sort().join('|') === keys, 'status exposes entity references, payloads, credentials or provider logs');
    check(STATES.includes(job.state) && Number.isInteger(job.attempts) && job.attempts >= 0 && job.attempts <= 8, 'invalid process lifecycle status');
  }
  return status;
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

  async function request(path, token, method = 'GET', body, extraHeaders = {}) {
    requests += 1;
    const response = await fetch(new URL(path, base), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        apikey: config.key,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
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
  const ws = config.teamId;
  const scope = { p_workspace_id: ws };
  const context = success(await rpc('owner', 'get_context'), 'owner context failed');
  check(context.external_invites_enabled === false, 'external onboarding must remain disabled');
  check(
    context.workspaces.some(workspace => workspace.id === ws),
    'synthetic collaboration team missing',
  );
  denied(await rpc('outsider', 'get_process_status'), 'unapproved account read process state', '42501');
  denied(await request('/rest/v1/rpc/tr8_v2_get_process_status', null, 'POST', {}), 'anonymous user read process state', '42501');
  const own = statusShape(success(await rpc('owner', 'get_process_status'), 'own personal process status failed'));
  const explicitOwn = statusShape(
    success(await rpc('owner', 'get_process_status', { p_workspace_id: context.personal_workspace_id }), 'explicit personal process status failed'),
  );
  check(JSON.stringify(own.counts) === JSON.stringify(explicitOwn.counts), 'default status scope does not match own personal workspace');
  statusShape(success(await rpc('owner', 'get_process_status', scope), 'team process status failed'));
  const hiddenWorkspace = await rpc('otherOwner', 'get_process_status', scope);
  const missingWorkspace = await rpc('otherOwner', 'get_process_status', { p_workspace_id: randomUUID() });
  denied(hiddenWorkspace, 'foreign owner read team process state');
  denied(missingWorkspace, 'missing workspace state returned a different class');
  check(hiddenWorkspace.body.message === missingWorkspace.body.message, 'process state leaks workspace existence');
  unavailable(await rpc('owner', 'get_process_status', { p_user_id: config.users.otherOwner.id }), 'arbitrary user status argument accepted');

  // No public RPC alias, exposed private schema, table or client-controlled token
  // can claim, renew, finish, retry or execute the server worker.
  for (const actor of [null, 'owner', 'editor']) {
    const token = actor ? tokens[actor] : null;
    for (const [name, args] of [
      ['v4_claim_jobs', { p_limit: 1 }],
      ['v4_finish_job', { p_id: randomUUID(), p_lease_token: randomUUID(), p_outcome: 'succeeded', p_retry_after_seconds: null }],
      ['v4_run_worker', {}],
      ['v4_maintain_processes', {}],
      ['v4_job_reason', { p_outbox_id: randomUUID() }],
      ['tr8_v2_claim_jobs', { p_limit: 1 }],
      ['tr8_v2_finish_job', { p_id: randomUUID(), p_lease_token: randomUUID(), p_outcome: 'succeeded', p_retry_after_seconds: null }],
      ['tr8_v2_run_worker', {}],
    ]) {
      unavailable(await request(`/rest/v1/rpc/${name}`, token, 'POST', args), 'public client reached a worker entry point');
    }
    unavailable(
      await request('/rest/v1/rpc/v4_run_worker', token, 'POST', {}, { 'Content-Profile': 'tr8_private' }),
      'client selected the private worker schema',
    );
    for (const table of ['process_outbox', 'process_jobs', 'process_runtime', 'process_attempts']) {
      unavailable(await request(`/rest/v1/${table}?select=*`, token), 'client read private process state directly');
      unavailable(await request(`/rest/v1/${table}`, token, 'POST', { id: randomUUID(), state: 'succeeded' }), 'client forged process state directly');
      unavailable(
        await request(`/rest/v1/${table}?select=*`, token, 'GET', undefined, { 'Accept-Profile': 'tr8_private' }),
        'client selected the private process schema',
      );
    }
  }

  const members = success(await rpc('owner', 'list_members_page', { ...scope, p_limit: 250 }), 'read synthetic member fixture failed');
  const editor = members.items.find(member => member.id === config.users.editor.memberId);
  check(editor?.status === 'active', 'synthetic editor unavailable');
  const oldRoles = editor.roles.map(role => role.id);
  async function setRoles(ids) {
    const current = success(await rpc('owner', 'list_members_page', { ...scope, p_limit: 250 }), 'refresh editor fixture failed').items.find(
      member => member.id === editor.id,
    );
    return success(
      await rpc('owner', 'set_member_roles', { ...scope, p_member_id: editor.id, p_version: current.version, p_role_ids: ids }),
      'set synthetic editor roles failed',
    );
  }
  let result;
  try {
    result = await exercise();
  } finally {
    await setRoles(oldRoles);
  }
  check(success(await rpc('owner', 'get_context'), 'final context failed').external_invites_enabled === false, 'external onboarding gate changed');
  result.assertions = assertions;
  result.requests = requests;
  await writeFile(join(dirname(configPath), 'http-stage4-result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));

  async function exercise() {
    const role = success(
      await rpc('owner', 'create_role', {
        ...scope,
        p_id: randomUUID(),
        p_name: 'HTTP stage 4 process editor',
        p_permissions: ['project.read', 'task.read', 'task.edit'],
      }),
      'create scoped editor role failed',
    );
    await setRoles([role.id]);
    const projectId = randomUUID();
    const project = success(
      await rpc('owner', 'create_project', {
        ...scope,
        p_id: projectId,
        p_name: 'HTTP stage 4 durable process',
        p_description: 'Synthetic process verification only',
        p_color: '#5A67D8',
        p_status: 'active',
      }),
      'create process fixture project failed',
    );
    check(project.id === projectId && project.version === 1, 'project producer changed domain identity or version');
    const acl = success(
      await rpc('owner', 'set_project_access', {
        ...scope,
        p_project_id: projectId,
        p_member_id: editor.id,
        p_version: 0,
        p_access_level: 'write',
      }),
      'create process fixture ACL failed',
    );
    const taskId = randomUUID();
    const taskArgs = {
      ...scope,
      p_id: taskId,
      p_project_id: projectId,
      p_title: 'Synthetic stage 4 durable task',
      p_description: 'PRIVATE CONTENT MUST NEVER APPEAR IN PROCESS STATUS',
      p_status: 'todo',
      p_priority: 'medium',
      p_start_date: null,
      p_due_date: '2026-11-02',
    };
    let task = success(await rpc('owner', 'create_task', taskArgs), 'create process fixture task failed');
    check(task.id === taskId && task.version === 1, 'task producer changed domain identity or version');
    const createRetry = success(await rpc('owner', 'create_task', taskArgs), 'idempotent task create retry failed');
    check(JSON.stringify(createRetry) === JSON.stringify(task), 'idempotent task retry changed durable domain state');
    const reusedId = randomUUID();
    const firstIncarnation = success(
      await rpc('owner', 'create_task', { ...taskArgs, p_id: reusedId, p_title: 'Synthetic stage 4 first incarnation' }),
      'create identifier reuse fixture failed',
    );
    success(await rpc('owner', 'delete_task', { ...scope, p_id: reusedId, p_version: firstIncarnation.version }), 'delete identifier reuse fixture failed');
    const secondIncarnation = success(
      await rpc('owner', 'create_task', { ...taskArgs, p_id: reusedId, p_title: 'Synthetic stage 4 second incarnation' }),
      'recreating a removed task with the historical API failed',
    );
    check(
      secondIncarnation.id === reusedId &&
        secondIncarnation.version === 1 &&
        secondIncarnation.created_at !== firstIncarnation.created_at &&
        secondIncarnation.task_number > firstIncarnation.task_number,
      'removed identifier reuse failed to establish a distinct incarnation',
    );
    const priorEditorStatus = statusShape(success(await rpc('editor', 'get_process_status', scope), 'initial editor process state failed'));
    const previousEditorIds = new Set(priorEditorStatus.jobs.map(job => job.id));
    task = success(
      await rpc('editor', 'update_task', { ...scope, p_id: taskId, p_version: task.version, p_patch: { title: 'Synthetic stage 4 editor revision' } }),
      'authorized process-producing content update failed',
    );
    const editorStatus = statusShape(success(await rpc('editor', 'get_process_status', scope), 'editor process state failed'));
    const fixtureJobIds = new Set(editorStatus.jobs.filter(job => !previousEditorIds.has(job.id)).map(job => job.id));
    check(fixtureJobIds.size > 0, 'committed editor mutation did not expose its scoped process receipt');
    const privateContent = JSON.stringify(editorStatus);
    check(!privateContent.includes(taskId) && !privateContent.includes(projectId), 'status leaks domain entity identifiers');
    check(!privateContent.includes(taskArgs.p_description) && !privateContent.includes(task.title), 'status leaks private domain content');
    check(!privateContent.includes(config.users.owner.id) && !privateContent.includes(config.users.owner.email), 'status leaks another account identity');
    const beforeRace = task.version;
    const race = await Promise.all([
      rpc('editor', 'update_task', { ...scope, p_id: taskId, p_version: beforeRace, p_patch: { due_date: '2026-11-03' } }),
      rpc('owner', 'update_task', { ...scope, p_id: taskId, p_version: beforeRace, p_patch: { due_date: '2026-11-04' } }),
    ]);
    check(
      race.filter(response => response.status === 200).length === 1 &&
        race.filter(response => response.status === 409 && response.body?.code === 'PT409').length === 1,
      'process producer changed optimistic concurrency behavior',
    );
    task = first(race.find(response => response.status === 200).body);
    check(task.version === beforeRace + 1, 'concurrent domain writes produced multiple revisions');
    task = success(
      await rpc('owner', 'schedule_task', {
        ...scope,
        p_id: taskId,
        p_version: task.version,
        p_scheduled_start_at: '2026-11-03T13:00:00Z',
        p_scheduled_end_at: '2026-11-03T14:00:00Z',
        p_scheduled_time_zone: 'America/La_Paz',
      }),
      'schedule process producer failed',
    );
    check(task.scheduled_time_zone === 'America/La_Paz' && task.due_date !== null, 'schedule producer changed independent dates');
    success(
      await rpc('owner', 'remove_project_access', { ...scope, p_project_id: projectId, p_member_id: editor.id, p_version: acl.version }),
      'live project access revocation failed',
    );
    const revoked = statusShape(success(await rpc('editor', 'get_process_status', scope), 'revoked actor own empty process status failed'));
    check(
      revoked.jobs.every(job => !fixtureJobIds.has(job.id)),
      'old JWT retained process entries after project access revocation',
    );
    denied(
      await rpc('editor', 'update_task', { ...scope, p_id: taskId, p_version: task.version, p_patch: { title: 'Unauthorized update' } }),
      'old JWT still produced task changes after project access revocation',
    );
    const latest = success(
      await request(`/rest/v1/tr8_workspace_tasks?select=*&id=eq.${taskId}&workspace_id=eq.${ws}`, tokens.owner),
      'owner could not read persisted task after process operations',
    );
    check(latest.id === taskId && latest.version === task.version && latest.title === task.title, 'rejected producer mutation changed durable content');
    denied(
      await rpc('owner', 'create_invitation', { ...scope, p_id: randomUUID(), p_email: 'still-disabled@example.test' }),
      'process deployment enabled external invitations',
      '42501',
    );
    return {
      result: 'passed',
      projectRef: TEST_HOST.split('.')[0],
      concurrency: { contentWinners: 1, staleConflicts: 1 },
      channels: { email: false, google: false },
      ids: { workspaceId: ws, projectId, taskId, taskVersion: task.version, reusedTaskId: reusedId, roleId: role.id },
      scope: 'synthetic Auth users and test-project fixtures only; private worker lifecycle requires separate SQL evidence',
    };
  }
}

main().catch(error => {
  console.error(
    error instanceof SmokeError ? `Stage-4A HTTP checks failed: ${error.message}` : 'Stage-4A HTTP checks failed: local configuration or network error',
  );
  process.exitCode = 1;
});
