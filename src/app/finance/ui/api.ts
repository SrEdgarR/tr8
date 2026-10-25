import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decodeBase64Url,
  decodeUtf8,
  parseStrictJson,
  requireClosedRecord,
  validateEnvelope,
  validateEpoch,
  type OpaqueReceipt,
  type VaultEnvelope,
} from '../compatibility/protocol';
import { DefinitiveOpaqueSaveError, isDefinitiveOpaqueSaveCode } from '../session/opaque-save';
import type { VaultSessionIdentity } from '../session/lifecycle';

export interface FinanceHead {
  envelope: VaultEnvelope | null;
  epoch: string;
}
export interface FinanceApi {
  ownerId: string;
  enabled: boolean;
  syntheticOnly: boolean;
  head: () => Promise<FinanceHead>;
  identity: () => Promise<VaultSessionIdentity>;
  save: (body: string, identity: VaultSessionIdentity) => Promise<OpaqueReceipt>;
  reauthenticate: (password: string) => Promise<void>;
  subscribe: (invalidate: () => void) => () => void;
}
export class FinanceApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const TEST_ORIGIN = 'https://kajcbwlnqcwcpbtqyieo.supabase.co';
const statuses = {
  AUTH_REQUIRED: 401,
  FINANCE_ACCESS_DENIED: 403,
  FINANCE_CONFLICT: 409,
  REAUTHENTICATION_REQUIRED: 403,
  CONTEXT_DENIED: 403,
  INVALID_INPUT: 400,
};

export function validateHead(value: unknown, ownerId: string): FinanceHead {
  const head = requireClosedRecord(value, ['envelope', 'epoch']);
  const envelope = head.envelope === null ? null : validateEnvelope(head.envelope);
  if (envelope && envelope.ownerId !== ownerId) throw new FinanceApiError('AUTH_REQUIRED');
  return { envelope, epoch: validateEpoch(head.epoch) };
}
function claims(token: string): Record<string, unknown> {
  return JSON.parse(decodeUtf8(decodeBase64Url(token.split('.')[1])));
}

/** Production is deliberately unavailable. A browser flag cannot open a real vault. */
export function createFinanceApi(client: SupabaseClient, ownerId: string, origin: string, publicKey: string): FinanceApi {
  const enabled = origin === TEST_ORIGIN;
  async function actor() {
    if (!enabled) throw new FinanceApiError('FINANCE_DISABLED');
    const { data, error } = await client.auth.getSession();
    const session = data.session;
    if (error || !session || session.user.id !== ownerId) throw new FinanceApiError('AUTH_REQUIRED');
    const verified = await client.auth.getUser(session.access_token);
    if (verified.error || verified.data.user?.id !== ownerId || verified.data.user.is_anonymous === true) throw new FinanceApiError('AUTH_REQUIRED');
    const c = claims(session.access_token);
    if (
      c.sub !== ownerId ||
      c.iss !== `${origin}/auth/v1` ||
      c.role !== 'authenticated' ||
      c.aud !== 'authenticated' ||
      typeof c.session_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.session_id) ||
      typeof c.exp !== 'number' ||
      c.exp * 1000 <= Date.now()
    )
      throw new FinanceApiError('AUTH_REQUIRED');
    return { token: session.access_token, sessionId: c.session_id, user: verified.data.user };
  }
  async function request(method: 'GET' | 'PUT', body?: string, identity?: VaultSessionIdentity): Promise<unknown> {
    const a = await actor().catch(error => {
      if (method === 'PUT' && error instanceof FinanceApiError && error.code === 'AUTH_REQUIRED') throw new DefinitiveOpaqueSaveError('AUTH_REQUIRED');
      throw error;
    });
    if (identity && (identity.ownerId !== ownerId || identity.sessionId !== a.sessionId || !identity.valid))
      throw new DefinitiveOpaqueSaveError('AUTH_REQUIRED');
    const response = await fetch(`${origin}/functions/v1/tr8-finance`, {
      method,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: {
        apikey: publicKey,
        Authorization: `Bearer ${a.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'x-tr8-finance-epoch': identity!.epoch }),
      },
      ...(body === undefined ? {} : { body }),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new FinanceApiError('DEPENDENCY_UNAVAILABLE');
    const bytes = new Uint8Array(2_200_000);
    let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (part.value.length > bytes.length - length) {
          await reader.cancel();
          throw new FinanceApiError('INVALID_RESPONSE');
        }
        bytes.set(part.value, length);
        length += part.value.length;
      }
    } finally {
      reader.releaseLock();
    }
    const value = parseStrictJson(decodeUtf8(bytes.subarray(0, length)), { maxBytes: bytes.length });
    if (!response.ok) {
      const record = requireClosedRecord(value, ['error']);
      const error = requireClosedRecord(record.error, ['code']);
      const code = error.code;
      if (method === 'PUT' && isDefinitiveOpaqueSaveCode(code) && response.status === statuses[code]) throw new DefinitiveOpaqueSaveError(code);
      throw new FinanceApiError(
        typeof code === 'string' &&
          ['FINANCE_DISABLED', 'REAUTHENTICATION_REQUIRED', 'AUTH_REQUIRED', 'FINANCE_ACCESS_DENIED', 'FINANCE_CONFLICT'].includes(code)
          ? code
          : 'DEPENDENCY_UNAVAILABLE',
      );
    }
    return value;
  }
  return {
    ownerId,
    enabled,
    syntheticOnly: true,
    head: async () => validateHead(await request('GET'), ownerId),
    identity: async () => {
      const a = await actor();
      const head = validateHead(await request('GET'), ownerId);
      const again = await actor();
      if (a.sessionId !== again.sessionId) throw new FinanceApiError('AUTH_REQUIRED');
      return { ownerId, sessionId: a.sessionId, epoch: head.epoch, valid: true };
    },
    save: async (body, identity) => {
      const r = requireClosedRecord(await request('PUT', body, identity), ['operationId', 'revision']);
      if (typeof r.operationId !== 'string') throw new FinanceApiError('INVALID_RESPONSE');
      decodeBase64Url(r.operationId, 16);
      return { operationId: r.operationId, revision: validateEpoch(r.revision) };
    },
    reauthenticate: async password => {
      const a = await actor();
      if (!a.user.email) throw new FinanceApiError('AUTH_REQUIRED');
      const result = await client.auth.signInWithPassword({ email: a.user.email, password });
      if (result.error || result.data.user?.id !== ownerId) throw new FinanceApiError('AUTH_REQUIRED');
    },
    subscribe: invalidate => {
      let previous: string | null = null;
      const {
        data: { subscription },
      } = client.auth.onAuthStateChange((_event, session) => {
        let next: string | null = null;
        try {
          if (session?.user.id === ownerId) {
            const hint = claims(session.access_token).session_id;
            if (typeof hint === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hint)) next = hint;
          }
        } catch {
          /* Invalidate malformed session hints. */
        }
        if (!next || (previous !== null && next !== previous)) invalidate();
        previous = next;
      });
      return () => subscription.unsubscribe();
    },
  };
}
