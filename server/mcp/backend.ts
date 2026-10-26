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
    if (!response.ok) {
      const code = data && typeof data === 'object' && 'code' in data ? String(data.code) : '';
      if (['PT401', 'PT403', 'PT404', 'PT409', 'PT429'].includes(code)) throw new McpBackendError(code);
      if (code === '42501') throw new McpBackendError('PT403');
      if (code.startsWith('22') || code === '23514') throw new McpBackendError('INVALID_INPUT');
      throw new McpBackendError('UNAVAILABLE');
    }
    return data;
  };
}
