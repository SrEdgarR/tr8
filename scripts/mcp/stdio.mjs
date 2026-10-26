#!/usr/bin/env node
import process from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// This adapter only translates transports. The remote TR8 server remains the
// authority for tool schemas, identity, permissions, versions and writes.
const configurationError = 'TR8 MCP: configura TR8_MCP_TOKEN y una URL HTTPS válida. No incluyas la clave en la URL.';
const connectionError = 'TR8 MCP: no se pudo conectar. Revisa la URL, la conexión y la vigencia de la clave en TR8.';
const toolError = 'TR8 MCP: no se pudo completar la solicitud remota. Comprueba tu conexión y los permisos de la clave.';
const token = process.env.TR8_MCP_TOKEN;
let endpoint;
try {
  endpoint = new URL(process.env.TR8_MCP_URL || 'https://tr8.vercel.app/api/mcp');
  const explicitLoopback = !!process.env.TR8_MCP_URL && endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (
    !/^tr8_mcp_[a-f0-9]{64}$/.test(token ?? '') ||
    (endpoint.protocol !== 'https:' && !explicitLoopback) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw Error('INVALID_CONFIGURATION');
} catch {
  process.stderr.write(configurationError + '\n');
  process.exitCode = 1;
}

if (!process.exitCode) {
  const remote = new Client({ name: 'tr8-stdio-adapter', version: '1.0.0' });
  let local;
  let stopped = false;
  const stop = async (exitCode = 0) => {
    if (stopped) return;
    stopped = true;
    process.exitCode = exitCode;
    await Promise.allSettled([local?.close(), remote.close()]);
    process.stdin.pause();
  };
  const forward = handler => async (request, extra) => {
    try {
      return await handler(request.params, { signal: extra.signal });
    } catch {
      // Remote/network diagnostics can contain URLs, headers or credentials.
      // Return only a fixed diagnostic through either transport.
      throw new McpError(ErrorCode.InternalError, toolError);
    }
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  process.stdin.once('end', () => void stop());
  try {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
      fetch: (input, init) => {
        const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (target.href !== endpoint.href) throw Error('UNEXPECTED_DESTINATION');
        return fetch(input, { ...init, redirect: 'error' });
      },
      reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    await remote.connect(transport);
    const capabilities = remote.getServerCapabilities() ?? {};
    local = new Server(
      { name: 'tr8', version: '1.0.0' },
      {
        instructions: remote.getInstructions(),
        capabilities: {
          ...(capabilities.tools ? { tools: {} } : {}),
          ...(capabilities.prompts ? { prompts: {} } : {}),
          ...(capabilities.resources ? { resources: {} } : {}),
        },
      },
    );
    if (capabilities.tools) {
      local.setRequestHandler(
        ListToolsRequestSchema,
        forward((params, options) => remote.listTools(params, options)),
      );
      local.setRequestHandler(
        CallToolRequestSchema,
        forward((params, options) => remote.callTool(params, CallToolResultSchema, options)),
      );
    }
    if (capabilities.prompts) {
      local.setRequestHandler(
        ListPromptsRequestSchema,
        forward((params, options) => remote.listPrompts(params, options)),
      );
      local.setRequestHandler(
        GetPromptRequestSchema,
        forward((params, options) => remote.getPrompt(params, options)),
      );
    }
    if (capabilities.resources) {
      local.setRequestHandler(
        ListResourcesRequestSchema,
        forward((params, options) => remote.listResources(params, options)),
      );
      local.setRequestHandler(
        ListResourceTemplatesRequestSchema,
        forward((params, options) => remote.listResourceTemplates(params, options)),
      );
      local.setRequestHandler(
        ReadResourceRequestSchema,
        forward((params, options) => remote.readResource(params, options)),
      );
    }
    local.onerror = () => process.stderr.write(toolError + '\n');
    remote.onerror = () => process.stderr.write(toolError + '\n');
    local.onclose = () => void stop();
    remote.onclose = () => void stop();
    await local.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }));
  } catch {
    process.stderr.write(connectionError + '\n');
    await stop(1);
  }
}
