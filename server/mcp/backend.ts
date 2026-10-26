export type McpDispatch = (action: string, input: Record<string, unknown>) => Promise<unknown>;

const messages: Record<string, string> = {
  PT401: 'Conexión MCP inválida, caducada o revocada. Crea una conexión nueva desde TR8.',
  PT403: 'Esta conexión no tiene permiso para esa acción.',
  PT404: 'El recurso no está disponible para esta conexión.',
  PT409: 'El recurso cambió. Consulta su versión actual antes de volver a modificarlo.',
  PT429: 'Se alcanzó el límite de esta conexión. Espera antes de reintentar.',
  INVALID_INPUT: 'Revisa los parámetros de la herramienta.',
  UNAVAILABLE: 'TR8 no pudo confirmar la operación. Para crear, conserva el mismo request_id al reintentar.',
};
export class McpBackendError extends Error {
  constructor(public readonly code: string) {
    super(messages[code] ?? messages.UNAVAILABLE);
  }
}

function backendError(code: unknown) {
  if (typeof code === 'string') {
    if (['PT401', 'PT403', 'PT404', 'PT409', 'PT429', 'INVALID_INPUT', 'UNAVAILABLE'].includes(code)) return new McpBackendError(code);
    if (code === '42501') return new McpBackendError('PT403');
    if (/^22[A-Z0-9]{3}$/.test(code) || code === '23514') return new McpBackendError('INVALID_INPUT');
  }
  return new McpBackendError('UNAVAILABLE');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Public Supabase key only. Delegation is checked again inside every RPC. */
export function createMcpDispatch(token: string, options: { url: string; key: string; fetch?: typeof fetch }): McpDispatch {
  const base = new URL(options.url);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new McpBackendError('UNAVAILABLE');
  const request = options.fetch ?? fetch;
  return async (action, input) => {
    let response: Response;
    try {
      response = await request(new URL('/rest/v1/rpc/tr8_mcp_dispatch', base), {
        method: 'POST',
        headers: { apikey: options.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_token: token, p_action: action, p_input: input }),
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
        cache: 'no-store',
      });
    } catch {
      throw new McpBackendError('UNAVAILABLE');
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new McpBackendError('UNAVAILABLE');
    }
    if (!response.ok) throw backendError(isRecord(data) ? data.code : undefined);
    // The RPC returns failures as data so the attempted-call quota can commit
    // while its inner transaction rolls back any business changes. Never expose
    // database diagnostics, or accidentally treat that envelope as business data.
    if (isRecord(data) && Object.hasOwn(data, '_tr8_mcp_error')) {
      const error = data._tr8_mcp_error;
      if (
        Object.keys(data).length !== 1 ||
        !isRecord(error) ||
        typeof error.code !== 'string' ||
        Object.keys(error).some(key => key !== 'code' && key !== 'message') ||
        (Object.hasOwn(error, 'message') && typeof error.message !== 'string')
      )
        throw new McpBackendError('UNAVAILABLE');
      throw backendError(error.code);
    }
    return data;
  };
}
