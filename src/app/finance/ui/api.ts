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
  closeSession?: () => Promise<void>;
  resetVault?: (accountPassword: string, confirmation: string) => Promise<void>;
}
export class FinanceApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export async function changeFinanceAccountPassword(client: SupabaseClient, origin: string, publicKey: string, password: string): Promise<void> {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) throw new FinanceApiError('AUTH_REQUIRED');
  if (!createFinanceApi(client, data.session.user.id, origin, publicKey, 'live').enabled) {
    const verified = await client.auth.getUser(data.session.access_token);
    if (verified.error || verified.data.user?.id !== data.session.user.id) throw new FinanceApiError('AUTH_REQUIRED');
    const update = await client.auth.updateUser({ password });
    if (update.error) throw update.error;
    if (!update.data.user) throw new FinanceApiError('AUTH_REQUIRED');
    return;
  }
  const response = await fetch(`${origin}/functions/v1/tr8-vault/account-password`, {
    method: 'POST',
    headers: { apikey: publicKey, Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('No se pudo confirmar el cambio. Solicita un nuevo enlace de recuperación e inténtalo otra vez.');
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

/** Synthetic transport stays closed by default. Live admission also requires
 * the separately provisioned server, two current authorities and live Auth. */
export function createFinanceApi(
  client: SupabaseClient,
  ownerId: string,
  origin: string,
  publicKey: string,
  mode: 'synthetic' | 'live' = 'synthetic',
): FinanceApi {
  const live = mode === 'live';
  const enabled = live
    ? (origin === 'https://ggbjezprlsnhidlbjivl.supabase.co' && ownerId === '74368b81-39f8-4bc3-bbbf-f541b64df4cf') ||
      (origin === TEST_ORIGIN && ownerId === '37848d70-989a-4f69-b124-0c959d8b49a6')
    : origin === TEST_ORIGIN;
  let observedHead: { epoch: string; operationId: unknown } | null = null;
  const ownOperations = new Set<string>();
  let observedVaultId: string | null | undefined;
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
  async function request(method: 'GET' | 'PUT' | 'POST', body?: string, identity?: VaultSessionIdentity, path = ''): Promise<unknown> {
    const a = await actor().catch(error => {
      if (method === 'PUT' && error instanceof FinanceApiError && error.code === 'AUTH_REQUIRED') throw new DefinitiveOpaqueSaveError('AUTH_REQUIRED');
      throw error;
    });
    if (identity && (identity.ownerId !== ownerId || identity.sessionId !== a.sessionId || !identity.valid))
      throw new DefinitiveOpaqueSaveError('AUTH_REQUIRED');
    const response = await fetch(`${origin}/functions/v1/${live ? 'tr8-vault' : 'tr8-finance'}${path || (method === 'POST' ? '/logout' : '')}`, {
      method,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: {
        apikey: publicKey,
        Authorization: `Bearer ${a.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', ...(!live && identity ? { 'x-tr8-finance-epoch': identity.epoch } : {}) }),
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
          [
            'FINANCE_DISABLED',
            'REAUTHENTICATION_REQUIRED',
            'AUTH_REQUIRED',
            'FINANCE_ACCESS_DENIED',
            'FINANCE_CONFLICT',
            'AUTHORITY_DIVERGED',
            'RESTORE_QUARANTINED',
            'WITNESS_UNAVAILABLE',
          ].includes(code)
          ? code
          : 'DEPENDENCY_UNAVAILABLE',
      );
    }
    return value;
  }
  async function readHead() {
    const value = await request('GET');
    if (!live) return { head: validateHead(value, ownerId), state: null };
    const r = requireClosedRecord(value, ['state', 'envelope']);
    const fields = requireClosedRecord(r.state, [
      'ownerId',
      'sequence',
      'head',
      'status',
      'sessionEpoch',
      'sessionCutoffMs',
      'sessions',
      'revokedSessions',
      'retiredVaults',
    ]);
    const rawHead =
      fields.head === null
        ? null
        : requireClosedRecord(fields.head, ['vaultId', 'revision', 'keyEpoch', 'credentialEpoch', 'operationId', 'digest', 'requestDigest']);
    const state = {
      ownerId: fields.ownerId,
      status: fields.status,
      sessionEpoch: validateEpoch(fields.sessionEpoch),
      head: rawHead === null ? null : { revision: validateEpoch(rawHead.revision), operationId: rawHead.operationId },
    };
    if (state.ownerId !== ownerId || state.status !== 'active') throw new FinanceApiError('AUTH_REQUIRED');
    const envelope = r.envelope === null ? null : validateEnvelope(r.envelope);
    if (envelope && (envelope.ownerId !== ownerId || envelope.operationId !== state.head?.operationId || envelope.revision !== state.head.revision))
      throw new FinanceApiError('INVALID_RESPONSE');
    if ((envelope === null) !== (state.head === null)) throw new FinanceApiError('INVALID_RESPONSE');
    observedHead = { epoch: state.sessionEpoch, operationId: state.head?.operationId ?? null };
    observedVaultId = envelope?.vaultId ?? null;
    return { head: { envelope, epoch: state.sessionEpoch }, state };
  }
  let reading: ReturnType<typeof readHead> | null = null;
  function currentHead() {
    if (!reading) {
      reading = readHead().finally(() => {
        reading = null;
      });
    }
    return reading;
  }
  return {
    ownerId,
    enabled,
    syntheticOnly: !live,
    head: async () => (await currentHead()).head,
    identity: async () => {
      const a = await actor();
      const metadata = live ? requireClosedRecord(await request('GET', undefined, undefined, '/session'), ['state']) : null;
      const s = metadata
        ? requireClosedRecord(metadata.state, [
            'ownerId',
            'sequence',
            'head',
            'status',
            'sessionEpoch',
            'sessionCutoffMs',
            'sessions',
            'revokedSessions',
            'retiredVaults',
          ])
        : null;
      const sh =
        s?.head === null
          ? null
          : s
            ? requireClosedRecord(s.head, ['vaultId', 'revision', 'keyEpoch', 'credentialEpoch', 'operationId', 'digest', 'requestDigest'])
            : null;
      if (s && (s.ownerId !== ownerId || s.status !== 'active')) throw new FinanceApiError('AUTH_REQUIRED');
      const { head, state } = live
        ? {
            head: { epoch: validateEpoch(s!.sessionEpoch) },
            state: { head: sh ? { revision: validateEpoch(sh.revision), operationId: sh.operationId } : null },
          }
        : await currentHead();
      const again = await actor();
      if (a.sessionId !== again.sessionId) throw new FinanceApiError('AUTH_REQUIRED');
      return {
        ownerId,
        sessionId: a.sessionId,
        epoch: head.epoch,
        valid: true,
        ...(live
          ? { headRevision: state?.head?.revision ?? '0', headOperationId: typeof state?.head?.operationId === 'string' ? state.head.operationId : null }
          : {}),
      };
    },
    save: async (body, identity) => {
      if (live) {
        const put = requireClosedRecord(parseStrictJson(body), ['envelope', 'expectedRevision', 'operationId']);
        if (typeof put.operationId !== 'string') throw new FinanceApiError('INVALID_RESPONSE');
        ownOperations.add(put.operationId);
        if (ownOperations.size > 8) ownOperations.delete(ownOperations.values().next().value!);
      }
      const r = requireClosedRecord(await request('PUT', body, identity), live ? ['operationId', 'sequence'] : ['operationId', 'revision']);
      if (typeof r.operationId !== 'string') throw new FinanceApiError('INVALID_RESPONSE');
      decodeBase64Url(r.operationId, 16);
      if (live) {
        validateEpoch(r.sequence);
        const sent = requireClosedRecord(parseStrictJson(body), ['envelope', 'expectedRevision', 'operationId']);
        const envelope = validateEnvelope(sent.envelope);
        if (r.operationId !== envelope.operationId) throw new FinanceApiError('INVALID_RESPONSE');
        observedVaultId = envelope.vaultId;
        return { operationId: r.operationId, revision: envelope.revision };
      }
      return { operationId: r.operationId, revision: validateEpoch(r.revision) };
    },
    reauthenticate: async password => {
      const a = await actor();
      if (!a.user.email) throw new FinanceApiError('AUTH_REQUIRED');
      const result = await client.auth.signInWithPassword({ email: a.user.email, password });
      if (result.error || result.data.user?.id !== ownerId) throw new FinanceApiError('AUTH_REQUIRED');
    },
    ...(live && enabled
      ? {
          closeSession: async () => {
            await request('POST', '{}');
          },
          resetVault: async (accountPassword: string, confirmation: string) => {
            if (confirmation !== 'ELIMINAR BÓVEDA') throw new FinanceApiError('INVALID_INPUT');
            const vaultId = observedVaultId;
            if (vaultId === undefined) throw new FinanceApiError('DEPENDENCY_UNAVAILABLE');
            const a = await actor();
            if (!a.user.email) throw new FinanceApiError('AUTH_REQUIRED');
            const login = await client.auth.signInWithPassword({ email: a.user.email, password: accountPassword });
            if (login.error || login.data.user?.id !== ownerId) throw new FinanceApiError('AUTH_REQUIRED');
            const result = requireClosedRecord(await request('POST', JSON.stringify({ confirmation, vaultId }), undefined, '/reset'), ['reset']);
            if (result.reset !== true) throw new FinanceApiError('INVALID_RESPONSE');
            const exit = await client.auth.signOut({ scope: 'local' });
            if (exit.error) throw exit.error;
          },
        }
      : {}),
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
      const channel = live
        ? client
            .channel('private-finance-head-' + ownerId)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'tr8_finance_heads', filter: 'owner_id=eq.' + ownerId }, payload => {
              const row = payload.new as Record<string, unknown>;
              if (row.owner_id !== ownerId) return;
              if (
                row.status !== 'active' ||
                (row.revoked_session_id && (!previous || row.revoked_session_id === previous)) ||
                (observedHead && row.session_epoch !== observedHead.epoch) ||
                (!ownOperations.has(String(row.operation_id)) && observedHead && row.operation_id !== observedHead.operationId)
              )
                invalidate();
            })
            .subscribe(status => {
              if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) invalidate();
            })
        : null;
      return () => {
        subscription.unsubscribe();
        if (channel) void client.removeChannel(channel);
      };
    },
  };
}
