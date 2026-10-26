import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server as HttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const adapter = fileURLToPath(new URL('../../scripts/mcp/stdio.mjs', import.meta.url));
const token = 'tr8_mcp_' + 'a'.repeat(64);
const servers: HttpServer[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(client => client.close()));
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function listen(server: HttpServer) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture address missing');
  return `http://127.0.0.1:${address.port}/api/mcp`;
}
function runAdapter(env: Record<string, string | undefined>) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [adapter], {
      env: { ...process.env, TR8_MCP_TOKEN: '', TR8_MCP_URL: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(Error('adapter did not stop'));
    }, 10000);
    child.stdout.on('data', data => {
      stdout += data;
    });
    child.stderr.on('data', data => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
}

it('connects a standard stdio MCP client to HTTP and preserves tools, results, prompts and resources', async () => {
  const seenHeaders: string[] = [];
  const endpoint = await listen(
    createServer(async (request, response) => {
      seenHeaders.push(String(request.headers.authorization));
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const server = new McpServer({ name: 'independent-http-fixture', version: '1.0.0' });
      server.registerTool(
        'tr8_get_context',
        { description: 'Read fixture context', inputSchema: { echo: z.string().optional() }, annotations: { readOnlyHint: true } },
        async args => ({
          content: [{ type: 'text', text: JSON.stringify({ workspace: 'fixture', echo: args.echo ?? null }) }],
          structuredContent: { workspace: 'fixture', echo: args.echo ?? null },
        }),
      );
      server.registerPrompt('plan_project', { argsSchema: { goal: z.string() } }, args => ({
        messages: [{ role: 'user', content: { type: 'text', text: `Plan: ${args.goal}` } }],
      }));
      server.registerResource('connection', 'tr8://connection', {}, async uri => ({
        contents: [{ uri: uri.href, mimeType: 'application/json', text: '{"access":"read"}' }],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.once('close', () => {
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(request, response);
      } catch {
        if (!response.headersSent) response.writeHead(500).end();
      }
    }),
  );
  const client = new Client({ name: 'independent-stdio-test-client', version: '1.0.0' });
  clients.push(client);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [adapter],
    env: { TR8_MCP_TOKEN: token, TR8_MCP_URL: endpoint },
    stderr: 'pipe',
  });
  let stderr = '';
  const protocolErrors: Error[] = [];
  transport.stderr?.on('data', data => {
    stderr += data;
  });
  client.onerror = error => protocolErrors.push(error);
  await client.connect(transport);
  const tools = await client.listTools();
  expect(tools.tools.map(tool => tool.name)).toEqual(['tr8_get_context']);
  expect(tools.tools[0].annotations?.readOnlyHint).toBe(true);
  expect(tools.tools[0].inputSchema.properties).toHaveProperty('echo');
  expect(await client.callTool({ name: 'tr8_get_context', arguments: { echo: 'from another agent' } })).toMatchObject({
    structuredContent: { workspace: 'fixture', echo: 'from another agent' },
  });
  expect((await client.listPrompts()).prompts.map(prompt => prompt.name)).toEqual(['plan_project']);
  expect(await client.getPrompt({ name: 'plan_project', arguments: { goal: 'A test project' } })).toMatchObject({
    messages: [{ content: { text: 'Plan: A test project' } }],
  });
  expect((await client.listResources()).resources.map(resource => resource.uri)).toEqual(['tr8://connection']);
  expect((await client.readResource({ uri: 'tr8://connection' })).contents[0]).toMatchObject({ text: '{"access":"read"}' });
  expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
  expect(protocolErrors).toEqual([]);
  expect(stderr).toBe('');
  expect(seenHeaders.length).toBeGreaterThan(5);
  expect(seenHeaders.every(value => value === `Bearer ${token}`)).toBe(true);
}, 15000);

it('fails with no stdout and no network call when the key is missing', async () => {
  const result = await runAdapter({});
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('configura TR8_MCP_TOKEN');
});

it.each(['http://example.com/api/mcp', 'https://example.com/api/mcp?secret=private-value', 'https://user:private-value@example.com/api/mcp'])(
  'rejects an unsafe URL without exposing its contents: %s',
  async endpoint => {
    const result = await runAdapter({ TR8_MCP_TOKEN: token, TR8_MCP_URL: endpoint });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('private-value');
    expect(result.stderr).not.toContain(token);
  },
);

it('sanitizes an authentication failure even if the remote error contains the supplied key', async () => {
  const endpoint = await listen(
    createServer((_request, response) => {
      response.writeHead(401, { 'Content-Type': 'text/plain' }).end(`rejected ${token}`);
    }),
  );
  const result = await runAdapter({ TR8_MCP_TOKEN: token, TR8_MCP_URL: endpoint });
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('no se pudo conectar');
  expect(result.stderr).not.toContain(token);
  expect(result.stderr).not.toContain(endpoint);
});

it('does not follow a redirect carrying the credential to a different endpoint', async () => {
  let destinationRequests = 0;
  const destination = await listen(
    createServer((_request, response) => {
      destinationRequests++;
      response.writeHead(500).end();
    }),
  );
  const endpoint = await listen(
    createServer((_request, response) => {
      response.writeHead(307, { Location: destination }).end();
    }),
  );
  const result = await runAdapter({ TR8_MCP_TOKEN: token, TR8_MCP_URL: endpoint });
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain(token);
  expect(destinationRequests).toBe(0);
});
