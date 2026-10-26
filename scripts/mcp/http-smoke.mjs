// Hosted end-to-end rehearsal. Refuses production and uses only new QA objects.
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { handleMcpRequest } from '../../test-results/mcp-runtime/server/mcp/http.js';
import { createMcpDispatch } from '../../test-results/mcp-runtime/server/mcp/backend.js';

let checks = 0;
function check(condition, name) {
  if (!condition) throw Error(name);
  checks++;
}
const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
check(new URL(config.url).hostname === 'kajcbwlnqcwcpbtqyieo.supabase.co', 'TEST_ONLY');
const owner = config.users.owner;
const login = await fetch(config.url + '/auth/v1/token?grant_type=password', {
  method: 'POST',
  headers: { apikey: config.key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: owner.email, password: owner.password }),
});
check(login.ok, 'LOGIN_FAILED');
const session = await login.json();
check(session.user.id === owner.id, 'IDENTITY_CHANGED');
async function rpc(name, input) {
  const response = await fetch(config.url + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: config.key, Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw Error('RPC_FAILED_' + name + '_' + response.status);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
const context = await rpc('tr8_v2_get_context', {});
const workspace = context.workspaces.find(item => item.kind === 'personal');
check(!!workspace, 'NO_PERSONAL_TEST_WORKSPACE');
const connections = [],
  clients = [];
const projectId = randomUUID(),
  taskId = randomUUID(),
  projectName = 'QA MCP HTTP ' + projectId;
let projectCreated = false;
let finalProjectVersion = 1;
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const response = await handleMcpRequest(
      new Request('http://127.0.0.1/api/mcp', {
        method: incoming.method,
        headers: incoming.headers,
        ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      }),
      { dispatch: token => createMcpDispatch(token, { url: config.url, key: config.key }) },
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500);
    outgoing.end('QA transport error');
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = `http://127.0.0.1:${server.address().port}/api/mcp`;
async function connect(token) {
  const client = new Client({ name: 'tr8-hosted-qa', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
async function call(client, name, args) {
  const result = await client.callTool({ name: 'tr8_' + name, arguments: args });
  check(result.isError !== true, 'TOOL_FAILED_' + name);
  return JSON.parse(result.content[0].text);
}
try {
  for (const access of ['read', 'write']) {
    const credential = await rpc('tr8_mcp_credentials', {
      p_action: 'create',
      p_input: { name: 'QA MCP hosted ' + access + ' ' + projectId, workspace_id: workspace.id, access, expires_in_days: 1 },
    });
    connections.push(credential);
  }
  const writer = await connect(connections[1].token);
  check((await writer.listTools()).tools.length === 11, 'TOOLS_NOT_DISCOVERED');
  const draft = { request_id: projectId, name: projectName };
  const project = await call(writer, 'create_project', draft);
  projectCreated = true;
  finalProjectVersion = project.version;
  check(project.id === projectId, 'PROJECT_ID_CHANGED');
  check((await call(writer, 'create_project', draft)).id === projectId, 'PROJECT_RETRY_DUPLICATED');
  const taskDraft = { request_id: taskId, project_id: projectId, title: 'QA MCP task' };
  const task = await call(writer, 'create_task', taskDraft);
  check((await call(writer, 'create_task', taskDraft)).id === taskId, 'TASK_RETRY_DUPLICATED');
  check((await call(writer, 'list_tasks', { project_id: projectId })).items.length === 1, 'DUPLICATE_TASKS');
  const updated = await call(writer, 'update_task', { id: taskId, version: task.version, patch: { status: 'done' } });
  check(updated.status === 'done', 'TASK_NOT_UPDATED');
  const conflict = await writer.callTool({ name: 'tr8_update_task', arguments: { id: taskId, version: task.version, patch: { title: 'Do not overwrite' } } });
  check(conflict.isError === true && JSON.parse(conflict.content[0].text).code === 'PT409', 'STALE_VERSION_ACCEPTED');
  const scheduled = await call(writer, 'schedule_task', {
    id: taskId,
    version: updated.version,
    scheduled_start_at: '2026-11-01T12:00:00Z',
    scheduled_end_at: '2026-11-01T13:00:00Z',
    scheduled_time_zone: 'UTC',
  });
  check(!!scheduled.scheduled_start_at, 'SCHEDULE_MISSING');
  const calendar = await call(writer, 'list_calendar', { date_from: '2026-11-01', date_to: '2026-11-03', time_zone: 'UTC', project_ids: [projectId] });
  check(
    calendar.items.some(item => item.task_id === taskId),
    'CALENDAR_MISSING_TASK',
  );
  const reader = await connect(connections[0].token);
  const denied = await reader.callTool({ name: 'tr8_create_project', arguments: { request_id: randomUUID(), name: 'Must not create' } });
  check(denied.isError === true && JSON.parse(denied.content[0].text).code === 'PT403', 'READ_ONLY_BYPASSED');
  await rpc('tr8_mcp_credentials', { p_action: 'revoke', p_input: { id: connections[0].id } });
  const revoked = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${connections[0].token}`, 'Content-Type': 'application/json', Accept: 'application/json,text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  check(revoked.status === 401, 'REVOKED_TOKEN_ACCEPTED');
  const stdio = new Client({ name: 'independent-stdio-qa', version: '1.0.0' });
  clients.push(stdio);
  await stdio.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['scripts/mcp/stdio.mjs'],
      env: {
        PATH: process.env.PATH,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        TR8_MCP_TOKEN: connections[1].token,
        TR8_MCP_URL: endpoint,
      },
      stderr: 'pipe',
    }),
  );
  check((await stdio.listTools()).tools.length === 11, 'STDIO_TOOLS_MISSING');
  check((await call(stdio, 'get_project', { id: projectId })).id === projectId, 'STDIO_READ_FAILED');
  // Isolate this key from HTTP preflights so its private counters must equal
  // exactly three. Management intentionally exposes no quota counters: the ID
  // below lets the operator verify them with a read-only SQL query after cleanup.
  const quotaCredential = await rpc('tr8_mcp_credentials', {
    p_action: 'create',
    p_input: { name: 'QA MCP quota ' + projectId, workspace_id: workspace.id, access: 'read', expires_in_days: 1 },
  });
  connections.push(quotaCredential);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(config.url + '/rest/v1/rpc/tr8_mcp_dispatch', {
      method: 'POST',
      headers: { apikey: config.key, 'Content-Type': 'application/json', ...(attempt < 2 ? { Prefer: 'tx=rollback' } : {}) },
      body: JSON.stringify({
        p_token: quotaCredential.token,
        p_action: 'update_task',
        p_input: { id: taskId, version: scheduled.version, patch: { title: 'QA quota probe must remain denied' } },
      }),
    });
    check(response.ok, 'QUOTA_FAILURE_MUST_COMMIT_ENVELOPE');
    const preferences = response.headers.get('preference-applied') ?? '';
    check(!preferences.split(',').some(preference => /^\s*tx\s*=\s*rollback\s*$/i.test(preference)), 'ROLLBACK_OVERRIDE_BYPASSES_QUOTA');
    const result = await response.json();
    check(
      Object.keys(result).length === 1 && Object.keys(result._tr8_mcp_error ?? {}).length === 1 && result._tr8_mcp_error?.code === 'PT403',
      'DIRECT_READ_ONLY_BYPASSED',
    );
  }
  const listedQuotaCredential = (await rpc('tr8_mcp_credentials', { p_action: 'list', p_input: {} })).find(item => item.id === quotaCredential.id);
  check(!!listedQuotaCredential, 'QUOTA_CREDENTIAL_NOT_LISTED');
  check(!('minute_count' in listedQuotaCredential) && !('day_count' in listedQuotaCredential), 'PRIVATE_COUNTERS_EXPOSED');
  console.log(
    JSON.stringify({
      environment: 'tr8-test',
      checks,
      http: true,
      stdio: true,
      retryWithoutDuplicates: true,
      conflictsRejected: true,
      readOnlyEnforced: true,
      revocationEnforced: true,
      calendar: true,
      quotaProbe: {
        credentialId: quotaCredential.id,
        failedDirectCalls: 3,
        rollbackPreferenceIgnored: true,
        expectedMinuteCount: 3,
        expectedDayCount: 3,
        privateCountersRequireSqlVerification: true,
      },
    }),
  );
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
  const failures = [];
  try {
    if (projectCreated)
      await rpc('tr8_v2_delete_project', { p_project_id: projectId, p_expected_version: finalProjectVersion, p_confirmation_name: projectName });
  } catch {
    failures.push('project');
  }
  for (const connection of connections) {
    try {
      await rpc('tr8_mcp_credentials', { p_action: 'revoke', p_input: { id: connection.id } });
    } catch {
      failures.push('credential');
    }
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (failures.length) throw Error('QA_CLEANUP_FAILED_' + failures.join('_'));
  console.log(JSON.stringify({ cleanup: 'new QA project removed; QA credentials revoked', projectId }));
}
