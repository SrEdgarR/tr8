import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ENVELOPE_BYTES, PASSWORD_PROFILE_ID, SUITE_ID, encodeBase64Url, serializeOpaquePut, type VaultEnvelope } from './protocol';
import { ExperimentalMemoryVaultServer, readPrototypeBody, type PrototypeHooks, type VerifiedPrototypeIdentity } from './server-prototype';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const bytes = (length: number, value: number) => encodeBase64Url(new Uint8Array(length).fill(value));

/** Structural opaque fixtures only: dummy ciphertext is not a cryptographic vector. */
function fixture(ownerId = 'owner-a', seed = 1): VaultEnvelope {
  return {
    formatVersion: 1,
    suiteId: SUITE_ID,
    vaultId: bytes(16, seed),
    ownerId,
    keyEpoch: '1',
    credentialEpoch: '1',
    revision: '1',
    operationId: bytes(16, seed + 1),
    payloadSchemaVersion: 1,
    passwordWrap: {
      wrapVersion: 1,
      slotEpoch: '1',
      kdfId: 'argon2id',
      argonVersion: 19,
      profileId: PASSWORD_PROFILE_ID,
      memoryKiB: 65536,
      passes: 3,
      parallelism: 1,
      outputBytes: 32,
      salt: bytes(16, 4),
      nonce: bytes(12, 5),
      wrappedKey: bytes(48, 6),
    },
    recoveryWrap: { wrapVersion: 1, slotEpoch: '1', schemeId: 'HKDF-SHA-256', salt: bytes(32, 7), nonce: bytes(12, 8), wrappedKey: bytes(48, 9) },
    payload: { keySalt: bytes(32, 10), nonce: bytes(12, 11), ciphertext: bytes(17, 12) },
  };
}

function nextEnvelope(previous: VaultEnvelope, seed = 30): VaultEnvelope {
  return {
    ...structuredClone(previous),
    revision: String(BigInt(previous.revision) + 1n),
    operationId: bytes(16, seed),
    payload: { keySalt: bytes(32, seed + 1), nonce: bytes(12, seed + 2), ciphertext: bytes(17, seed + 3) },
  };
}

function request(envelope: VaultEnvelope, expectedRevision = '0'): Uint8Array {
  return new TextEncoder().encode(serializeOpaquePut({ expectedRevision, operationId: envelope.operationId, envelope }));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(hooks: PrototypeHooks = {}) {
  let now = NOW;
  const proof = (ownerId: string, sessionId: string): VerifiedPrototypeIdentity => ({
    ownerId,
    sessionId,
    authentication: { ownerId, sessionId, method: 'password', authenticatedAtMs: now },
  });
  const tokens = new Map<string, VerifiedPrototypeIdentity>([
    ['Bearer alice', proof('owner-a', 'session-a')],
    ['Bearer alice-other', proof('owner-a', 'session-b')],
    ['Bearer bob', proof('owner-b', 'session-c')],
  ]);
  const server = new ExperimentalMemoryVaultServer({
    verifyIdentity: vi.fn(async token => tokens.get(token) ?? null),
    clock: () => now,
    hooks,
    identities: [
      {
        ownerId: 'owner-a',
        sessions: [
          { id: 'session-a', expiresAtMs: NOW + 3_600_000 },
          { id: 'session-b', expiresAtMs: NOW + 3_600_000 },
        ],
      },
      { ownerId: 'owner-b', sessions: [{ id: 'session-c', expiresAtMs: NOW + 3_600_000 }] },
    ],
  });
  return { server, tokens, advance: (milliseconds: number) => (now += milliseconds) };
}

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe('prototipo experimental del servidor opaco de Pulso', () => {
  it('deriva la identidad del verificador, rechaza un contexto ajeno y aísla las bóvedas personales', async () => {
    const { server } = harness();
    const alice = fixture();
    const bob = fixture('owner-b', 50);
    await expect(server.put('Bearer desconocido', request(alice))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(server.put('Bearer bob', request(alice))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await server.put('Bearer alice', request(alice));
    await expect(server.put('Bearer bob', request({ ...alice, ownerId: 'owner-b' }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await server.put('Bearer bob', request(bob));
    expect((await server.read('Bearer alice')).envelope).toEqual(alice);
    expect((await server.read('Bearer bob')).envelope).toEqual(bob);
    // Returned envelopes/receipts are detached from the authority's state.
    const view = await server.read('Bearer bob');
    view.envelope!.ownerId = 'owner-a';
    expect((await server.read('Bearer bob')).envelope).toEqual(bob);
  });

  it.each([
    ['sin prueba', undefined],
    ['refresh aunque reciente', { ownerId: 'owner-a', sessionId: 'session-a', method: 'token_refresh', authenticatedAtMs: NOW }],
    ['recovery', { ownerId: 'owner-a', sessionId: 'session-a', method: 'recovery', authenticatedAtMs: NOW }],
    ['prueba de otra sesión', { ownerId: 'owner-a', sessionId: 'session-b', method: 'password', authenticatedAtMs: NOW }],
    ['prueba de otra identidad', { ownerId: 'owner-b', sessionId: 'session-a', method: 'password', authenticatedAtMs: NOW }],
    ['prueba a cinco minutos exactos', { ownerId: 'owner-a', sessionId: 'session-a', method: 'password', authenticatedAtMs: NOW - 300_000 }],
    ['prueba futura', { ownerId: 'owner-a', sessionId: 'session-a', method: 'password', authenticatedAtMs: NOW + 1 }],
  ])('no crea una bóveda con %s', async (_label, authentication) => {
    const { server, tokens } = harness();
    tokens.set('Bearer alice', { ownerId: 'owner-a', sessionId: 'session-a', authentication });
    await expect(server.put('Bearer alice', request(fixture()))).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    expect((await server.read('Bearer alice')).envelope).toBeNull();
  });

  it('el login reciente no se exige para escribir ordinariamente ni se deduce de la actividad', async () => {
    const { server, advance } = harness();
    const original = fixture();
    await server.put('Bearer alice', request(original));
    advance(300_000);
    const next = nextEnvelope(original);
    await expect(server.put('Bearer alice', request(next, '1'))).resolves.toEqual({ revision: '2', operationId: next.operationId });
    const rekey = nextEnvelope(next, 60);
    rekey.keyEpoch = '2';
    rekey.credentialEpoch = '2';
    rekey.passwordWrap = { ...rekey.passwordWrap, slotEpoch: '2', salt: bytes(16, 61), nonce: bytes(12, 62), wrappedKey: bytes(48, 63) };
    rekey.recoveryWrap = { ...rekey.recoveryWrap, slotEpoch: '2', salt: bytes(32, 64), nonce: bytes(12, 65), wrappedKey: bytes(48, 66) };
    await expect(server.put('Bearer alice', request(rekey, '2'))).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    expect((await server.read('Bearer alice')).envelope).toEqual(next);
  });

  it('retransmite los mismos bytes tras perder el ACK y devuelve el recibo sin confirmar dos revisiones', async () => {
    let loseAcknowledgement = true;
    const afterCommit = vi.fn(async () => {
      if (loseAcknowledgement) throw new Error('simulated lost response');
    });
    const { server } = harness({ afterCommit });
    const original = fixture();
    const body = request(original);
    await expect(server.put('Bearer alice', body)).rejects.toMatchObject({ code: 'COMMIT_UNCONFIRMED' });
    expect((await server.read('Bearer alice')).envelope).toEqual(original);
    loseAcknowledgement = false;
    const receipt = await server.put('Bearer alice', body);
    expect(receipt).toEqual({ revision: '1', operationId: original.operationId });
    receipt.revision = '999';
    expect(await server.put('Bearer alice', body)).toEqual({ revision: '1', operationId: original.operationId });
    expect(afterCommit).toHaveBeenCalledTimes(1);
  });

  it('el mismo operationId con bytes JSON distintos es conflicto aunque el objeto sea equivalente', async () => {
    const { server } = harness();
    const original = fixture();
    const body = request(original);
    await server.put('Bearer alice', body);
    const withWhitespace = new TextEncoder().encode(` ${new TextDecoder().decode(body)}\n`);
    await expect(server.put('Bearer alice', withWhitespace)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect((await server.read('Bearer alice')).envelope).toEqual(original);
  });

  it('dos sesiones compiten por CAS: solo una actualización queda confirmada', async () => {
    const { server } = harness();
    const original = fixture();
    await server.put('Bearer alice', request(original));
    const left = nextEnvelope(original, 30);
    const right = nextEnvelope(original, 40);
    const results = await Promise.allSettled([server.put('Bearer alice', request(left, '1')), server.put('Bearer alice-other', request(right, '1'))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'STALE_REVISION' }) }),
    ]);
    const current = (await server.read('Bearer alice')).envelope;
    expect([left.operationId, right.operationId]).toContain(current?.operationId);
    expect(current?.revision).toBe('2');
  });

  it('un fallo entre snapshot y recibo revierte ambos; el retry aún puede crear la revisión', async () => {
    let fail = true;
    const { server } = harness({
      beforeReceiptCommit: () => {
        if (fail) throw new Error('simulated receipt failure');
      },
    });
    const original = fixture();
    await expect(server.put('Bearer alice', request(original))).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect((await server.read('Bearer alice')).envelope).toBeNull();
    fail = false;
    await expect(server.put('Bearer alice', request(original))).resolves.toEqual({ revision: '1', operationId: original.operationId });
  });

  it('una revocación linealizada mientras el commit está preparado impide la escritura antigua y sus recibos', async () => {
    const entered = deferred();
    const resume = deferred();
    const { server } = harness({
      beforeCommit: async () => {
        entered.resolve();
        await resume.promise;
      },
    });
    const original = fixture();
    const write = server.put('Bearer alice', request(original));
    await entered.promise;
    await server.revokeSession('owner-a', 'session-a');
    resume.resolve();
    await expect(write).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    await expect(server.put('Bearer alice', request(original))).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    expect((await server.read('Bearer alice-other')).envelope).toBeNull();
  });

  it('suspensión y cambio de lifecycle invalidan escrituras preparadas de otra sesión', async () => {
    const entered = deferred();
    const resume = deferred();
    let pause = true;
    const { server } = harness({
      beforeCommit: async () => {
        if (pause) {
          entered.resolve();
          await resume.promise;
        }
      },
    });
    const write = server.put('Bearer alice', request(fixture()));
    await entered.promise;
    // Revoking a different session still advances the common identity fence.
    await server.revokeSession('owner-a', 'session-b');
    resume.resolve();
    await expect(write).rejects.toMatchObject({ code: 'LIFECYCLE_CHANGED' });
    expect((await server.read('Bearer alice')).envelope).toBeNull();
    pause = false;
    await server.disableIdentity('owner-a');
    await expect(server.put('Bearer alice', request(fixture()))).rejects.toMatchObject({ code: 'IDENTITY_DISABLED' });
    await expect(server.read('Bearer alice')).rejects.toMatchObject({ code: 'IDENTITY_DISABLED' });
  });

  it('volver a comprobar la sesión y la prueba en el commit impide usar una sesión o login que caducó durante la espera', async () => {
    const entered = deferred();
    const resume = deferred();
    const { server, advance } = harness({
      beforeCommit: async () => {
        entered.resolve();
        await resume.promise;
      },
    });
    const write = server.put('Bearer alice', request(fixture()));
    await entered.promise;
    advance(300_000);
    resume.resolve();
    await expect(write).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    expect((await server.read('Bearer alice')).envelope).toBeNull();
    advance(3_300_000);
    await expect(server.read('Bearer alice')).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
  });

  it('reset retira el contexto antes de consultar recibos y conserva intacta la bóveda del otro usuario', async () => {
    const { server } = harness();
    const original = fixture();
    const bob = fixture('owner-b', 50);
    const originalBytes = request(original);
    await server.put('Bearer alice', originalBytes);
    await server.put('Bearer bob', request(bob));
    const command = { operationId: bytes(16, 70), expectedLifecycleVersion: 1, expectedVaultId: original.vaultId };
    const receipt = await server.reset('Bearer alice', command);
    expect(receipt).toEqual({ operationId: command.operationId, lifecycleVersion: 2, retiredVaultId: original.vaultId });
    expect(await server.reset('Bearer alice', command)).toEqual(receipt);
    expect((await server.read('Bearer alice')).envelope).toBeNull();
    await expect(server.put('Bearer alice', originalBytes)).rejects.toMatchObject({ code: 'VAULT_RETIRED' });
    await expect(server.put('Bearer alice', request({ ...original, operationId: bytes(16, 71) }))).rejects.toMatchObject({ code: 'VAULT_RETIRED' });
    await expect(server.put('Bearer bob', request({ ...original, ownerId: 'owner-b', operationId: bytes(16, 72) }))).rejects.toMatchObject({
      code: 'VAULT_RETIRED',
    });
    await expect(server.read('Bearer alice-other')).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    expect((await server.read('Bearer bob')).envelope).toEqual(bob);
    const replacement = fixture('owner-a', 80);
    await server.put('Bearer alice', request(replacement));
    expect((await server.read('Bearer alice')).envelope).toEqual(replacement);
  });

  it('reset gana la carrera a un PUT ya preparado y el recibo viejo nunca reactiva el contexto', async () => {
    const entered = deferred();
    const resume = deferred();
    const { server } = harness({
      beforeCommit: async context => {
        if (context.revision === '2') {
          entered.resolve();
          await resume.promise;
        }
      },
    });
    const original = fixture();
    await server.put('Bearer alice', request(original));
    const write = server.put('Bearer alice', request(nextEnvelope(original), '1'));
    await entered.promise;
    await server.reset('Bearer alice', { operationId: bytes(16, 70), expectedLifecycleVersion: 1, expectedVaultId: original.vaultId });
    resume.resolve();
    await expect(write).rejects.toMatchObject({ code: 'LIFECYCLE_CHANGED' });
    expect((await server.read('Bearer alice')).envelope).toBeNull();
    await expect(server.put('Bearer alice', request(original))).rejects.toMatchObject({ code: 'VAULT_RETIRED' });
  });

  it('no permite reset con prueba ajena, versión antigua ni comando de contexto ajeno', async () => {
    const { server, tokens } = harness();
    const original = fixture();
    await server.put('Bearer alice', request(original));
    const command = { operationId: bytes(16, 70), expectedLifecycleVersion: 1, expectedVaultId: original.vaultId };
    tokens.set('Bearer alice-other', {
      ownerId: 'owner-a',
      sessionId: 'session-b',
      authentication: { ownerId: 'owner-a', sessionId: 'session-a', method: 'password', authenticatedAtMs: NOW },
    });
    await expect(server.reset('Bearer alice-other', command)).rejects.toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    await expect(server.reset('Bearer alice', { ...command, expectedLifecycleVersion: 2 })).rejects.toMatchObject({ code: 'LIFECYCLE_CHANGED' });
    await expect(server.reset('Bearer alice', { ...command, expectedVaultId: bytes(16, 99) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await server.read('Bearer alice')).envelope).toEqual(original);
  });

  it('no reutiliza recibos confirmados después de revocar la sesión ni abre un restore sin reconciliación', async () => {
    const { server } = harness();
    const body = request(fixture());
    await server.put('Bearer alice', body);
    await server.revokeSession('owner-a', 'session-a');
    await expect(server.put('Bearer alice', body)).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    server.quarantineRestore();
    await expect(server.read('Bearer alice-other')).rejects.toMatchObject({ code: 'RESTORE_QUARANTINED' });
    await expect(server.put('Bearer alice-other', body)).rejects.toMatchObject({ code: 'RESTORE_QUARANTINED' });
  });

  it('congela los bytes antes del primer await y no acepta UTF-8 inválido, BOM ni campos extra', async () => {
    const { server } = harness();
    const original = fixture();
    const mutable = request(original);
    const pending = server.put('Bearer alice', mutable);
    mutable.fill(0);
    await expect(pending).resolves.toEqual({ revision: '1', operationId: original.operationId });
    await expect(server.put('Bearer alice', new Uint8Array([0xff]))).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
    const valid = request(original);
    const bom = new Uint8Array(valid.length + 3);
    bom.set([0xef, 0xbb, 0xbf]);
    bom.set(valid, 3);
    await expect(server.put('Bearer alice', bom)).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
    const extra = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(valid)), ownerId: 'owner-b' }));
    await expect(server.put('Bearer alice', extra)).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
    await expect(server.put('Bearer alice', new Uint8Array(MAX_ENVELOPE_BYTES + 1))).rejects.toMatchObject({ code: 'ENVELOPE_TOO_LARGE' });
    expect((await server.read('Bearer alice')).envelope).toEqual(original);
  });
});

describe('admisión del stream opaco sin HTTP de producción', () => {
  function streamed(chunks: Uint8Array[], declared?: string, extraHeaders: Record<string, string> = {}) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    return new Request('https://example.invalid/fixture-only', {
      method: 'PUT',
      body,
      headers: { 'content-type': 'application/json', ...(declared === undefined ? {} : { 'content-length': declared }), ...extraHeaders },
      duplex: 'half',
    } as RequestInit);
  }

  it('acepta los bytes reales hasta el límite y corta el exceso aunque Content-Length mienta o falte', async () => {
    const half = new Uint8Array(MAX_ENVELOPE_BYTES / 2).fill(42);
    const accepted = await readPrototypeBody(streamed([half, half]));
    expect(accepted.byteLength).toBe(MAX_ENVELOPE_BYTES);
    expect(accepted[0]).toBe(42);
    await expect(readPrototypeBody(streamed([half, half, new Uint8Array([1])], '1'))).rejects.toMatchObject({ code: 'ENVELOPE_TOO_LARGE' });
    await expect(readPrototypeBody(streamed([new Uint8Array(MAX_ENVELOPE_BYTES + 1)]))).rejects.toMatchObject({ code: 'ENVELOPE_TOO_LARGE' });
  });

  it('rechaza longitudes inválidas, compresión y un tipo de contenido diferente', async () => {
    await expect(readPrototypeBody(streamed([], '-1'))).rejects.toMatchObject({ code: 'ENVELOPE_TOO_LARGE' });
    await expect(readPrototypeBody(streamed([], String(MAX_ENVELOPE_BYTES + 1)))).rejects.toMatchObject({ code: 'ENVELOPE_TOO_LARGE' });
    await expect(readPrototypeBody(streamed([], undefined, { 'content-encoding': 'gzip' }))).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
    await expect(readPrototypeBody(streamed([], undefined, { 'content-type': 'text/plain' }))).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
  });

  it('conserva los bytes con muchos chunks vacíos o de un byte sin acumular una lista por fragmento', async () => {
    const chunks = Array.from({ length: 4_000 }, (_, index) => (index % 2 ? new Uint8Array([index % 256]) : new Uint8Array()));
    const accepted = await readPrototypeBody(streamed(chunks));
    expect(accepted).toEqual(Uint8Array.from({ length: 2_000 }, (_, index) => (index * 2 + 1) % 256));
    expect(await readPrototypeBody(streamed(chunks.filter(chunk => chunk.byteLength === 0)))).toHaveLength(0);
  });
});
