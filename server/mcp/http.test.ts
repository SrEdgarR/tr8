import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleMcpRequest } from './http';
import { createMcpDispatch, McpBackendError } from './backend';

const token = 'tr8_mcp_' + 'a'.repeat(64);
const endpoint = 'https://tr8.example/api/mcp';
const context = { workspace: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'QA', kind: 'personal' }, access: 'read', time_zone: 'America/Santo_Domingo' };
const headers = { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
function request(body: unknown, extras: Record<string, string> = {}) {
  return new Request(endpoint, { method: 'POST', headers: { ...headers, ...extras }, body: JSON.stringify(body) });
}

describe('standard remote TR8 MCP transport', () => {
  it('works with the official MCP client and exposes a bounded business surface, resources and planning prompt', async () => {
    const dispatch = vi.fn(async (action: string) => (action === 'context' ? context : { items: [], next_cursor: null }));
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) =>
        handleMcpRequest(new Request(input, init), {
          dispatch: supplied => {
            expect(supplied).toBe(token);
            return dispatch;
          },
        }),
    });
    const client = new Client({ name: 'independent-qa-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe('tr8');
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(11);
      expect(tools.tools.every(tool => tool.name.startsWith('tr8_'))).toBe(true);
      expect(tools.tools.some(tool => /finance|sql|delete|member|credential/.test(tool.name))).toBe(false);
      expect(tools.tools.find(tool => tool.name === 'tr8_list_tasks')?.annotations?.readOnlyHint).toBe(true);
      expect(tools.tools.find(tool => tool.name === 'tr8_create_task')?.inputSchema.required).toContain('request_id');
      const result = await client.callTool({ name: 'tr8_list_tasks', arguments: { limit: 10 } });
      expect(result.isError).not.toBe(true);
      expect(dispatch).toHaveBeenCalledWith('list_tasks', { limit: 10 });
      const resource = await client.readResource({ uri: 'tr8://connection' });
      expect(resource.contents[0]).toMatchObject({ mimeType: 'application/json', text: JSON.stringify(context) });
      const prompt = await client.getPrompt({ name: 'plan_project', arguments: { objective: 'Preparar una presentación' } });
      expect(prompt.messages[0].content).toMatchObject({ type: 'text' });
    } finally {
      await client.close();
    }
  });

  it('rejects unknown arguments before dispatch and returns sanitized scope conflicts as tool errors', async () => {
    const dispatch = vi.fn(async (action: string) => {
      if (action === 'context') return context;
      throw new McpBackendError('PT403');
    });
    const client = new Client({ name: 'scope-test-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: async (input, init) => handleMcpRequest(new Request(input, init), { dispatch: () => dispatch }),
      }),
    );
    try {
      const invalid = await client.callTool({ name: 'tr8_get_context', arguments: { owner_id: 'spoof' } });
      expect(invalid.isError).toBe(true);
      expect(dispatch.mock.calls.every(([action]) => action === 'context')).toBe(true);
      const result = await client.callTool({ name: 'tr8_create_project', arguments: { request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'QA' } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('PT403');
      expect(JSON.stringify(result)).not.toContain(token);
    } finally {
      await client.close();
    }
  });

  it.each(['', 'Bearer wrong', 'Bearer tr8_mcp_' + 'g'.repeat(64)])(
    'rejects missing or malformed credentials without touching the database',
    async authorization => {
      const dispatch = vi.fn();
      const response = await handleMcpRequest(request({}, { authorization }), { dispatch });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Bearer');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it('checks current authorization again for every HTTP request and closes a revoked connection', async () => {
    const dispatch = vi.fn().mockResolvedValueOnce(context).mockRejectedValueOnce(new McpBackendError('PT401'));
    const options = { dispatch: () => dispatch };
    const first = await handleMcpRequest(
      request({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'qa', version: '1' } },
      }),
      options,
    );
    expect(first.status).toBe(200);
    const revoked = await handleMcpRequest(request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), options);
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain(token);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('rejects hostile browser origins, malformed JSON and oversized bodies', async () => {
    const dispatch = vi.fn(async () => context);
    expect((await handleMcpRequest(request({}, { origin: 'https://evil.example' }), { dispatch: () => dispatch })).status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
    expect((await handleMcpRequest(new Request(endpoint, { method: 'POST', headers, body: '{' }), { dispatch: () => dispatch })).status).toBe(400);
    expect(
      (await handleMcpRequest(new Request(endpoint, { method: 'POST', headers, body: ' '.repeat(256 * 1024 + 1) }), { dispatch: () => dispatch })).status,
    ).toBe(413);
  });

  it('never returns a raw backend exception', async () => {
    const response = await handleMcpRequest(request({}), {
      dispatch: () => async () => {
        throw Error('SQL and private token ' + token);
      },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(token);
  });

  it('bounds the time spent reading an authenticated slow request body and cancels the stream', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let source: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(new TextEncoder().encode('{'));
      },
      cancel,
    });
    let response: Response | undefined;
    const pending = handleMcpRequest(new Request(endpoint, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit), {
      dispatch: () => async () => context,
    }).then(result => {
      response = result;
    });
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(response?.status).toBe(408);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(await response?.text()).not.toContain(token);
    } finally {
      if (!cancel.mock.calls.length) source!.close();
      await pending;
      vi.useRealTimers();
    }
  });

  it('stops reading when the caller aborts and ignores a sensitive abort reason', async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    abort.abort(Error('private token ' + token));
    const response = await handleMcpRequest(
      new Request(endpoint, { method: 'POST', headers, body: source, signal: abort.signal, duplex: 'half' } as RequestInit),
      { dispatch: () => async () => context },
    );
    expect(response.status).toBe(408);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await response.text()).not.toContain(token);
  });

  it('cancels an in-progress read when the caller disconnects', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const pending = handleMcpRequest(new Request(endpoint, { method: 'POST', headers, body: source, signal: abort.signal, duplex: 'half' } as RequestInit), {
      dispatch: () => async () => context,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      abort.abort();
      expect((await pending).status).toBe(408);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(source.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an oversized stream without waiting for its hostile cancellation hook', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024 + 1));
      },
      cancel,
    });
    let response: Response | undefined;
    const pending = handleMcpRequest(new Request(endpoint, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit), {
      dispatch: () => async () => context,
    }).then(result => {
      response = result;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(response?.status).toBe(413);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(stream.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps committed SQL failure envelopes out of MCP results and preserves the public error code', async () => {
    const dispatch = createMcpDispatch(token, {
      url: 'https://example.supabase.co',
      key: 'public-key',
      fetch: async (_url, init) => {
        const action = JSON.parse(String(init?.body)).p_action;
        return Response.json(action === 'context' ? context : { _tr8_mcp_error: { code: 'PT409', message: 'private token ' + token } });
      },
    });
    const response = await handleMcpRequest(
      request({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'tr8_update_task',
          arguments: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 1, patch: { status: 'done' } },
        },
      }),
      { dispatch: () => dispatch },
    );
    const result = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(result).result.isError).toBe(true);
    expect(result).toContain('PT409');
    expect(result).not.toContain('_tr8_mcp_error');
    expect(result).not.toContain(token);
  });
});
