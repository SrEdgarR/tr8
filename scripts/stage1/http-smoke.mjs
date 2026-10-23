/**
 * Stage-1 HTTP integration checks for a disposable Supabase project only.
 *
 * Usage: node scripts/stage1/http-smoke.mjs <private-config.json> [all|setup|verify]
 * Config: { url, key, users: { owner: { email, password }, otherOwner: {...},
 * outsider: {...} } }. Keep this file outside the repository.
 * Uses password-authenticated clients and the publishable/anon key only.
 * Leaves synthetic application records for browser QA; no production requests.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const TEST_HOST = 'kajcbwlnqcwcpbtqyieo.supabase.co';
const PRODUCTION_REF = 'ggbjezprlsnhidlbjivl';
const mode = process.argv[3] || 'all';
const configPath = process.argv[2] && resolve(process.argv[2]);
let assertionCount = 0;
let requestCount = 0;

class SmokeError extends Error {}

function check(condition, label) {
  if (!condition) throw new SmokeError(label);
  assertionCount += 1;
}

function row(value) {
  return Array.isArray(value) ? value[0] : value;
}

function expectSuccess(response, label) {
  check(response.status >= 200 && response.status < 300, label);
  return row(response.body);
}

function expectDenied(response, label, code) {
  check(response.status >= 400 && response.status < 500 && (!code || response.body?.code === code), label);
}

async function main() {
  if (!configPath || !['all', 'setup', 'verify'].includes(mode)) {
    throw new SmokeError('Usage: http-smoke.mjs <private-config.json> [all|setup|verify]');
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const base = new URL(config.url);
  if (
    base.protocol !== 'https:' ||
    base.hostname !== TEST_HOST ||
    base.port ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/' ||
    config.url.includes(PRODUCTION_REF)
  ) {
    throw new SmokeError('Refusing network access: only the designated disposable test project is allowed');
  }
  if (typeof config.key !== 'string' || !config.key || config.key.startsWith('sb_secret_')) {
    throw new SmokeError('A test-project publishable or anon key is required');
  }
  if (!config.key.startsWith('sb_publishable_')) {
    let claims;
    try {
      claims = JSON.parse(Buffer.from(config.key.split('.')[1] || '', 'base64url').toString('utf8'));
    } catch {
      throw new SmokeError('The configured key is not a publishable or anon key');
    }
    if (claims.role !== 'anon') throw new SmokeError('Privileged API keys are prohibited');
  }
  for (const name of ['owner', 'otherOwner', 'outsider']) {
    const user = config.users?.[name];
    if (!user || !/^[^@\s]+@example\.test$/i.test(user.email) || typeof user.password !== 'string' || user.password.length < 20) {
      throw new SmokeError('Only synthetic example.test users with strong private test passwords are permitted');
    }
  }

  async function request(path, token, method = 'GET', body) {
    requestCount += 1;
    const response = await fetch(new URL(path, base), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: {
        apikey: config.key,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new SmokeError('The test API returned a non-JSON response');
      }
    }
    return { status: response.status, body: parsed };
  }

  const tokens = {};
  const contexts = {};
  for (const name of ['owner', 'otherOwner', 'outsider']) {
    const result = await request('/auth/v1/token?grant_type=password', null, 'POST', {
      email: config.users[name].email,
      password: config.users[name].password,
    });
    const login = expectSuccess(result, `${name}: synthetic password login failed`);
    check(typeof login.access_token === 'string' && login.access_token.length > 20, `${name}: login did not issue an access token`);
    tokens[name] = login.access_token;
  }
  const rpc = (user, name, params = {}) => request(`/rest/v1/rpc/${name}`, tokens[user], 'POST', params);
  const table = (user, name, filters = {}, method = 'GET', body) => {
    const query = new URLSearchParams({ select: '*', ...filters });
    return request(`/rest/v1/${name}?${query}`, tokens[user], method, body);
  };
  for (const name of ['owner', 'otherOwner']) {
    contexts[name] = expectSuccess(await rpc(name, 'tr8_v2_get_context'), `${name}: enabled context failed`);
    check(contexts[name].contract_version === 2 && contexts[name].personal_workspace_id, `${name}: context contract or personal workspace missing`);
    check(contexts[name].external_invites_enabled === false, `${name}: external onboarding must remain disabled`);
  }
  expectDenied(await rpc('outsider', 'tr8_v2_get_context'), 'confirmed outsider gained application access', '42501');
  check(contexts.owner.personal_workspace_id !== contexts.otherOwner.personal_workspace_id, 'personal workspaces are not isolated');
  const statePath = join(dirname(configPath), 'http-smoke-state.json');
  let state;

  function projectInput(workspaceId, id, name) {
    return { p_workspace_id: workspaceId, p_id: id, p_name: name, p_description: 'Synthetic HTTP verification', p_color: '#5A67D8', p_status: 'active' };
  }
  function taskInput(workspaceId, id, projectId, title) {
    return {
      p_workspace_id: workspaceId,
      p_id: id,
      p_project_id: projectId,
      p_title: title,
      p_description: 'Synthetic HTTP verification',
      p_status: 'todo',
      p_priority: 'high',
      p_start_date: '2026-10-23',
      p_due_date: '2026-10-24',
    };
  }

  if (mode !== 'verify') {
    state = { projectRef: TEST_HOST.split('.')[0], runId: randomUUID(), users: {} };
    for (const user of ['owner', 'otherOwner']) {
      const ids = {
        personalWorkspaceId: contexts[user].personal_workspace_id,
        teamId: randomUUID(),
        personalProjectId: randomUUID(),
        personalTaskId: randomUUID(),
        teamProjectId: randomUUID(),
        teamTaskId: randomUUID(),
      };
      state.users[user] = ids;
      const team = expectSuccess(await rpc(user, 'tr8_v2_create_team', { p_id: ids.teamId, p_name: `HTTP QA ${user}` }), `${user}: team creation failed`);
      check(team.id === ids.teamId && team.kind === 'team', `${user}: team identity mismatch`);
      const teamRetry = expectSuccess(await rpc(user, 'tr8_v2_create_team', { p_id: ids.teamId, p_name: `HTTP QA ${user}` }), `${user}: team retry failed`);
      check(teamRetry.id === team.id && teamRetry.version === team.version, `${user}: team retry duplicated or changed state`);
      for (const scope of ['personal', 'team']) {
        const workspaceId = scope === 'personal' ? ids.personalWorkspaceId : ids.teamId;
        const project = projectInput(workspaceId, ids[`${scope}ProjectId`], `HTTP QA ${scope} ${user}`);
        const created = expectSuccess(await rpc(user, 'tr8_v2_create_project', project), `${user}/${scope}: project creation failed`);
        check(created.id === project.p_id && created.workspace_id === workspaceId && created.version === 1, `${user}/${scope}: created project fields invalid`);
        const retry = expectSuccess(await rpc(user, 'tr8_v2_create_project', project), `${user}/${scope}: project retry failed`);
        check(JSON.stringify(retry) === JSON.stringify(created), `${user}/${scope}: project retry changed durable state`);
        const task = taskInput(workspaceId, ids[`${scope}TaskId`], project.p_id, `HTTP QA task ${scope} ${user}`);
        const createdTask = expectSuccess(await rpc(user, 'tr8_v2_create_task', task), `${user}/${scope}: task creation failed`);
        const retryTask = expectSuccess(await rpc(user, 'tr8_v2_create_task', task), `${user}/${scope}: task retry failed`);
        check(createdTask.id === task.p_id && createdTask.task_number > 0 && createdTask.version === 1, `${user}/${scope}: task identity invalid`);
        check(JSON.stringify(retryTask) === JSON.stringify(createdTask), `${user}/${scope}: task retry changed durable state`);
      }
    }
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } else {
    state = JSON.parse(await readFile(statePath, 'utf8'));
    if (state.projectRef !== TEST_HOST.split('.')[0]) throw new SmokeError('Saved state does not belong to the disposable test project');
    for (const name of ['owner', 'otherOwner']) {
      check(state.users[name].personalWorkspaceId === contexts[name].personal_workspace_id, `${name}: saved state belongs to a different account`);
    }
  }

  if (mode !== 'setup') {
    const a = state.users.owner;
    const b = state.users.otherOwner;
    for (const [actor, foreign] of [
      ['owner', b],
      ['otherOwner', a],
      ['outsider', a],
    ]) {
      for (const scope of ['personal', 'team']) {
        const workspaceId = scope === 'personal' ? foreign.personalWorkspaceId : foreign.teamId;
        for (const name of ['tr8_workspace_projects', 'tr8_workspace_tasks']) {
          const response = await table(actor, name, { workspace_id: `eq.${workspaceId}` });
          check(response.status === 200 && Array.isArray(response.body) && response.body.length === 0, `${actor}: foreign ${scope} ${name} leaked`);
        }
      }
    }
    const ownProjects = await table('owner', 'tr8_workspace_projects', { workspace_id: `eq.${a.teamId}` });
    check(ownProjects.status === 200 && ownProjects.body.some(project => project.id === a.teamProjectId), 'team owner cannot read own private project');
    expectDenied(
      await rpc('owner', 'tr8_v2_update_project', {
        p_workspace_id: b.teamId,
        p_id: b.teamProjectId,
        p_version: 1,
        p_patch: { name: 'Forbidden foreign edit' },
      }),
      'foreign project update succeeded',
      'PT404',
    );
    expectDenied(
      await rpc('owner', 'tr8_v2_update_project', { p_workspace_id: a.teamId, p_id: a.personalProjectId, p_version: 1, p_patch: { name: 'Wrong scope' } }),
      'project ID accepted in wrong workspace',
      'PT404',
    );
    expectDenied(
      await rpc('owner', 'tr8_v2_create_task', taskInput(a.teamId, randomUUID(), b.teamProjectId, 'Forbidden parent')),
      'task accepted a foreign project parent',
      'PT404',
    );
    expectDenied(
      await table('owner', 'tr8_workspace_projects', { id: `eq.${a.personalProjectId}` }, 'PATCH', { name: 'Direct bypass' }),
      'direct project PATCH bypassed controlled RPC',
      '42501',
    );
    expectDenied(
      await table('owner', 'tr8_workspace_tasks', {}, 'POST', { workspace_id: a.teamId, project_id: a.teamProjectId, title: 'Direct bypass' }),
      'direct task INSERT bypassed controlled RPC',
      '42501',
    );
    expectDenied(await table('owner', 'tr8_workspace_tasks', { id: `eq.${a.teamTaskId}` }, 'DELETE'), 'direct task DELETE bypassed controlled RPC', '42501');
    const oldProjects = await table('owner', 'tr8_projects');
    check(oldProjects.status === 404, 'legacy project table endpoint still exists');
    const oldTasks = await table('owner', 'tr8_tasks');
    check(oldTasks.status === 404, 'legacy task table endpoint still exists');
    const oldRpc = await rpc('owner', 'tr8_check_access');
    check(oldRpc.status === 404, 'legacy RPC endpoint still exists');
    const anonymous = await request('/rest/v1/tr8_workspace_projects?select=id', null);
    check(anonymous.status === 401 || anonymous.status === 403, 'anonymous HTTP read succeeded');
    expectDenied(
      await rpc('owner', 'tr8_v2_create_invitation', { p_workspace_id: a.teamId, p_id: randomUUID(), p_email: 'http-disabled@example.test' }),
      'external invitation gate opened during HTTP checks',
      '42501',
    );

    const beforeResponse = await table('owner', 'tr8_workspace_tasks', { id: `eq.${a.personalTaskId}` });
    const before = expectSuccess(beforeResponse, 'concurrency task read failed');
    check(before?.id === a.personalTaskId, 'concurrency task missing');
    const competingPatches = [{ title: 'HTTP concurrent edit A' }, { title: 'HTTP concurrent edit B' }];
    const concurrent = await Promise.all(
      competingPatches.map(patch =>
        rpc('owner', 'tr8_v2_update_task', { p_workspace_id: a.personalWorkspaceId, p_id: a.personalTaskId, p_version: before.version, p_patch: patch }),
      ),
    );
    const successful = concurrent.filter(response => response.status >= 200 && response.status < 300);
    const conflicts = concurrent.filter(response => response.status === 409 && response.body?.code === 'PT409');
    check(successful.length === 1 && conflicts.length === 1, 'same-version concurrent HTTP updates did not yield exactly one success and one PT409');
    const winner = row(successful[0].body);
    check(winner.version === before.version + 1, 'concurrent winner did not increment version once');
    const persisted = expectSuccess(await table('owner', 'tr8_workspace_tasks', { id: `eq.${a.personalTaskId}` }), 'concurrent persisted read failed');
    check(persisted.version === winner.version && persisted.title === winner.title, 'durable task differs from the successful concurrent response');

    const project = expectSuccess(await table('owner', 'tr8_workspace_projects', { id: `eq.${a.personalProjectId}` }), 'archive project read failed');
    const archived = expectSuccess(
      await rpc('owner', 'tr8_v2_update_project', {
        p_workspace_id: a.personalWorkspaceId,
        p_id: a.personalProjectId,
        p_version: project.version,
        p_patch: { archived_at: new Date().toISOString() },
      }),
      'archive failed',
    );
    check(archived.version === project.version + 1 && archived.archived_at, 'archive state invalid');
    expectDenied(
      await rpc('owner', 'tr8_v2_update_task', {
        p_workspace_id: a.personalWorkspaceId,
        p_id: a.personalTaskId,
        p_version: winner.version,
        p_patch: { status: 'done' },
      }),
      'archived project allowed task editing',
      'PT409',
    );
    expectDenied(
      await rpc('owner', 'tr8_v2_create_task', taskInput(a.personalWorkspaceId, randomUUID(), a.personalProjectId, 'Archived create')),
      'archived project allowed task creation',
      'PT409',
    );
    const restored = expectSuccess(
      await rpc('owner', 'tr8_v2_update_project', {
        p_workspace_id: a.personalWorkspaceId,
        p_id: a.personalProjectId,
        p_version: archived.version,
        p_patch: { archived_at: null },
      }),
      'project restoration failed',
    );
    check(restored.version === archived.version + 1 && restored.archived_at === null, 'restored project state invalid');
    const retained = expectSuccess(await table('owner', 'tr8_workspace_tasks', { id: `eq.${a.personalTaskId}` }), 'retained task read failed');
    check(retained.version === winner.version && retained.title === winner.title, 'archive and restore altered the preserved task');

    const deletionTaskId = randomUUID();
    expectSuccess(
      await rpc('owner', 'tr8_v2_create_task', taskInput(a.personalWorkspaceId, deletionTaskId, a.personalProjectId, 'Temporary delete check')),
      'temporary deletion task creation failed',
    );
    const edited = expectSuccess(
      await rpc('owner', 'tr8_v2_update_task', { p_workspace_id: a.personalWorkspaceId, p_id: deletionTaskId, p_version: 1, p_patch: { status: 'done' } }),
      'temporary deletion task update failed',
    );
    expectDenied(
      await rpc('owner', 'tr8_v2_delete_task', { p_workspace_id: a.personalWorkspaceId, p_id: deletionTaskId, p_version: 1 }),
      'stale delete succeeded',
      'PT409',
    );
    expectSuccess(
      await rpc('owner', 'tr8_v2_delete_task', { p_workspace_id: a.personalWorkspaceId, p_id: deletionTaskId, p_version: edited.version }),
      'valid delete failed',
    );
    const absent = await table('owner', 'tr8_workspace_tasks', { id: `eq.${deletionTaskId}` });
    check(absent.status === 200 && absent.body.length === 0, 'deleted task remains readable');
  }

  const result = {
    result: 'passed',
    mode,
    projectRef: TEST_HOST.split('.')[0],
    assertions: assertionCount,
    requests: requestCount,
    concurrency: mode === 'setup' ? 'not run' : { successful: 1, staleConflicts: 1 },
    ids: state.users,
  };
  await writeFile(join(dirname(configPath), 'http-smoke-result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  // No request/response bodies, credentials or tokens are logged.
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(
    error instanceof SmokeError ? `Stage-1 HTTP checks failed: ${error.message}` : 'Stage-1 HTTP checks failed: local configuration or network error',
  );
  process.exitCode = 1;
});
