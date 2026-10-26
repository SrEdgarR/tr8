import type { SupabaseClient } from '@supabase/supabase-js';
import { DataError } from './errors';

export type McpAccess = 'read' | 'write';
export interface McpCredential {
  id: string;
  name: string;
  workspace_id: string;
  access: McpAccess;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}
export interface McpCredentialDraft {
  name: string;
  workspace_id: string;
  access: McpAccess;
  expires_in_days: number;
}
export interface CreatedMcpCredential extends McpCredential {
  token: string;
}
export interface McpCredentialsApi {
  ownerId: string;
  list(): Promise<McpCredential[]>;
  create(draft: McpCredentialDraft): Promise<CreatedMcpCredential>;
  revoke(id: string): Promise<McpCredential>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = ['id', 'name', 'workspace_id', 'access', 'created_at', 'expires_at', 'revoked_at', 'last_used_at'];
const invalidResponse = () => new DataError('No pudimos comprobar la conexión MCP. Actualiza la lista antes de continuar.');
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
function credential(value: unknown, created = false): McpCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  const row = value as Record<string, unknown>;
  const expected = [...fields, ...(created ? ['token'] : [])];
  if (Object.keys(row).length !== expected.length || Object.keys(row).some(key => !expected.includes(key))) throw invalidResponse();
  if (
    typeof row.id !== 'string' ||
    !uuid.test(row.id) ||
    typeof row.workspace_id !== 'string' ||
    !uuid.test(row.workspace_id) ||
    typeof row.name !== 'string' ||
    !row.name.trim() ||
    row.name.length > 80 ||
    !['read', 'write'].includes(String(row.access)) ||
    !timestamp(row.created_at) ||
    !timestamp(row.expires_at) ||
    Date.parse(row.expires_at as string) <= Date.parse(row.created_at as string) ||
    (row.revoked_at !== null && !timestamp(row.revoked_at)) ||
    (row.last_used_at !== null && !timestamp(row.last_used_at)) ||
    (created && (typeof row.token !== 'string' || !/^tr8_mcp_[a-f0-9]{64}$/.test(row.token)))
  )
    throw invalidResponse();
  return row as unknown as McpCredential;
}
function requestError(code: unknown) {
  if (['42501', 'PT401', 'PGRST301', 'PGRST303'].includes(String(code))) return new DataError('Confirma tu sesión de TR8 para administrar tus conexiones MCP.');
  if (['PT403', 'PT404'].includes(String(code))) return new DataError('Esta conexión o espacio ya no está disponible para tu cuenta.');
  if (code === 'PT429') return new DataError('Has alcanzado el límite de conexiones. Revoca una clave que ya no uses o vuelve a intentarlo más tarde.');
  return new DataError('No se pudo confirmar la operación MCP. Actualiza la lista antes de volver a intentarlo.');
}

export function createMcpRepository(client: SupabaseClient, ownerId: string): McpCredentialsApi {
  async function identity() {
    try {
      const { data, error } = await client.auth.getUser();
      if (!error && data.user?.id === ownerId) return;
    } catch {
      // Auth transport diagnostics are not part of the UI contract.
    }
    throw new DataError('Tu sesión cambió. Vuelve a abrir Configuración.');
  }
  async function request(action: 'list' | 'create' | 'revoke', input: Record<string, unknown>) {
    await identity();
    try {
      const { data, error } = await client.rpc('tr8_mcp_credentials', { p_action: action, p_input: input });
      if (error) throw requestError(error.code);
      await identity();
      return data as unknown;
    } catch (cause) {
      if (cause instanceof DataError) throw cause;
      throw requestError(undefined);
    }
  }
  return {
    ownerId,
    async list() {
      const result = await request('list', {});
      if (!Array.isArray(result)) throw invalidResponse();
      const rows = result.map(row => credential(row));
      if (new Set(rows.map(row => row.id)).size !== rows.length) throw invalidResponse();
      return rows;
    },
    async create(draft) {
      const name = draft.name.trim();
      if (
        !name ||
        name.length > 80 ||
        !uuid.test(draft.workspace_id) ||
        !['read', 'write'].includes(draft.access) ||
        !Number.isInteger(draft.expires_in_days) ||
        draft.expires_in_days < 1 ||
        draft.expires_in_days > 90
      )
        throw new DataError('Revisa el nombre, los permisos y la duración de la conexión.');
      const result = credential(await request('create', { ...draft, name }), true) as CreatedMcpCredential;
      if (result.workspace_id !== draft.workspace_id || result.access !== draft.access || result.name !== name || result.revoked_at !== null)
        throw invalidResponse();
      return result;
    },
    async revoke(id) {
      if (!uuid.test(id)) throw new DataError('Selecciona una conexión válida.');
      const result = credential(await request('revoke', { id }));
      if (result.id !== id || !result.revoked_at) throw invalidResponse();
      return result;
    },
  };
}
