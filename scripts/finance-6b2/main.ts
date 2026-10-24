import vector from '../../src/app/finance/compatibility/fixtures/vault-vectors.json';
import { assertOpaqueTransition, encodeBase64Url, parseOpaquePut, type OpaqueReceipt, type VaultEnvelope } from '../../src/app/finance/compatibility/protocol';
import { DefinitiveOpaqueSaveError, isDefinitiveOpaqueSaveCode, VaultSessionController } from '../../src/app/finance/session/controller';
import { bindVaultBrowserLifecycle } from '../../src/app/finance/session/browser-lifecycle';
import type { VaultSessionIdentity } from '../../src/app/finance/session/lifecycle';
import type { VaultPlaintext } from '../../src/app/finance/crypto/plaintext';

const button = document.querySelector<HTMLButtonElement>('#run')!;
const status = document.querySelector<HTMLElement>('#status')!;
const results = document.querySelector<HTMLOListElement>('#results')!;
const report = document.querySelector<HTMLElement>('#report')!;
const PASSWORD = 'SYNTHETIC ONLY private phrase 🔐 123';
const NEXT_PASSWORD = 'SYNTHETIC ONLY replacement phrase 🔐 456';
const RECOVERED_PASSWORD = 'SYNTHETIC ONLY recovered phrase 🔐 789';
const REKEY_PASSWORD = 'SYNTHETIC ONLY rekey phrase 🔐 987';
const snapshot: VaultPlaintext = { schemaVersion: 1, financialSpace: { synthetic: true, note: 'TR8 6B.2 browser fixture', amountMinor: 12345 } };
const fixture = vector.envelope as VaultEnvelope;
const controllers: VaultSessionController[] = [];
let checks = 0;

function check(condition: unknown, label: string): asserts condition {
  checks++;
  if (!condition) throw new Error(label);
}
async function denied(job: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await job();
  } catch {
    checks++;
    return;
  }
  throw new Error(label);
}
function noKey(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  check(!(value instanceof CryptoKey) && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value), 'Key material crossed the Worker boundary');
  Object.values(value).forEach(noKey);
}
function randomId(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

class MemoryBackend {
  envelope: VaultEnvelope | null = null;
  bodies: string[] = [];
  receipts = new Map<string, { body: string; receipt: OpaqueReceipt }>();
  loseNextAck = false;
  async save(body: string): Promise<OpaqueReceipt> {
    this.bodies.push(body);
    const put = parseOpaquePut(body);
    noKey(put);
    const old = this.receipts.get(put.envelope.operationId);
    if (old) {
      check(old.body === body, 'Retry changed the original opaque request');
      return old.receipt;
    }
    assertOpaqueTransition(this.envelope, put);
    this.envelope = structuredClone(put.envelope);
    const receipt = { operationId: put.envelope.operationId, revision: put.envelope.revision };
    this.receipts.set(receipt.operationId, { body, receipt });
    if (this.loseNextAck) {
      this.loseNextAck = false;
      throw new Error('Synthetic lost ACK');
    }
    return receipt;
  }
}

function session(
  ownerId: string,
  backend = new MemoryBackend(),
  options: {
    now?: () => number;
    identity?: () => Promise<VaultSessionIdentity>;
    onClear?: () => void;
    makeWorker?: () => Worker;
  } = {},
): VaultSessionController {
  const controller = new VaultSessionController({
    ownerId,
    verifyIdentity: options.identity ?? (async () => ({ ownerId, sessionId: 'synthetic-browser-session', epoch: '1', valid: true })),
    saveOpaque: body => backend.save(body),
    onClear: options.onClear ?? (() => {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.makeWorker ? { makeWorker: options.makeWorker } : {}),
  });
  controllers.push(controller);
  return controller;
}
async function read(controller: VaultSessionController): Promise<VaultPlaintext> {
  const value = await controller.read();
  noKey(value);
  return value;
}
async function open(envelope: VaultEnvelope, kind: 'password' | 'recovery', value: string): Promise<VaultSessionController> {
  const controller = session(envelope.ownerId);
  const result = await controller.unlock(envelope, { kind, value });
  noKey(result);
  return controller;
}
async function probe(command: 'vector' | 'deny-wasm'): Promise<unknown> {
  const worker = new Worker(new URL('./probe.worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic probe timed out')), 20_000);
      worker.onmessage = event => {
        clearTimeout(timer);
        noKey(event.data);
        if (event.data.command === command && event.data.passed === true) resolve(event.data.timing ?? true);
        else reject(new Error('Real WASM probe failed'));
      };
      worker.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Probe Worker failed'));
      };
      worker.postMessage(command);
    });
  } finally {
    worker.terminate();
  }
}

button.addEventListener('click', async () => {
  button.disabled = true;
  results.replaceChildren();
  report.textContent = 'En ejecución';
  checks = 0;
  const evidence: Record<string, unknown> = { syntheticOnly: true, actualWorker: true, actualWasm: true, productionFinanceEnabled: false };
  const completed: string[] = [];
  const started = performance.now();
  let currentLabel = '';
  async function test(label: string, job: () => Promise<void>): Promise<void> {
    currentLabel = label;
    status.textContent = label;
    await job();
    const row = document.createElement('li');
    row.dataset.pass = 'true';
    row.textContent = `✓ ${label}`;
    results.append(row);
    completed.push(label);
  }
  try {
    await test('Argon2id WASM: vector independiente de Pulso', async () => {
      evidence.kdfTiming = await probe('vector');
    });
    await test('Sin WASM disponible: acceso denegado, sin alternativa silenciosa', async () => {
      await probe('deny-wasm');
    });
    await test('Vector completo: contraseña y recuperación abren el mismo contenido', async () => {
      const passwordSession = await open(fixture, 'password', vector.password);
      check(JSON.stringify(await read(passwordSession)) === JSON.stringify(vector.plaintext), 'Password fixture plaintext mismatch');
      passwordSession.lock('navigation');
      const { encodeRecoverySecret, formatRecoverySecret } = await import('../../src/app/finance/crypto/recovery');
      const code = formatRecoverySecret(encodeRecoverySecret(Uint8Array.from(vector.recoveryHex.match(/../g)!, value => parseInt(value, 16))));
      const recoverySession = await open(fixture, 'recovery', code);
      check(JSON.stringify(await read(recoverySession)) === JSON.stringify(vector.plaintext), 'Recovery fixture plaintext mismatch');
      await denied(() => recoverySession.prepareWrite(snapshot), 'Recovery allowed ordinary writes');
      recoverySession.lock('navigation');
    });
    const backend = new MemoryBackend();
    const owner = 'synthetic-browser-owner-' + randomId();
    let controller = session(owner, backend);
    let recoveryCode = '';
    let heartbeats = 0;
    await test('Creación y custodia completa: ningún guardado anticipado y claves dentro del Worker', async () => {
      const timer = setInterval(() => {
        heartbeats++;
      }, 10);
      let draft;
      try {
        draft = await controller.beginCreate({ vaultId: randomId(), password: PASSWORD, plaintext: snapshot });
      } finally {
        clearInterval(timer);
      }
      noKey(draft);
      recoveryCode = draft.recoveryCode;
      check(backend.bodies.length === 0, 'Create wrote before custody');
      const prepared = await controller.confirmCustody(PASSWORD, recoveryCode);
      noKey(prepared);
      check(backend.bodies.length === 0, 'Custody wrote without commit');
      await controller.commit();
      check(JSON.stringify(await read(controller)) === JSON.stringify(snapshot), 'Fresh vault roundtrip failed');
      check(heartbeats > 0, 'Main event loop stalled through KDF');
      evidence.mainThreadHeartbeats = heartbeats;
    });
    await test('Contraseña errónea, código erróneo y cambio de propietario se rechazan', async () => {
      const envelope = structuredClone(backend.envelope!);
      await denied(() => open(envelope, 'password', PASSWORD + '!'), 'Wrong password opened');
      await denied(() => open(envelope, 'recovery', 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA'), 'Wrong recovery opened');
      const other = session('synthetic-other-owner');
      await denied(() => other.unlock(envelope, { kind: 'password', value: PASSWORD }), 'Foreign owner opened');
      const tampered = structuredClone(envelope);
      tampered.payload.nonce = randomId().slice(0, 16);
      await denied(() => open(tampered, 'password', PASSWORD), 'Tampered payload opened');
    });
    await test('ACK perdido: contenido oculto y retransmisión de los mismos bytes', async () => {
      await controller.prepareWrite({ ...snapshot, financialSpace: { ...snapshot.financialSpace, revisionNote: 'second synthetic revision' } });
      backend.loseNextAck = true;
      await denied(() => controller.commit(), 'Lost ACK was treated as success');
      const first = backend.bodies.at(-1);
      await controller.commit();
      check(first === backend.bodies.at(-1), 'Lost ACK retry regenerated ciphertext');
      check((await read(controller)).financialSpace.revisionNote === 'second synthetic revision', 'Retry failed to activate committed snapshot');
    });
    await test('Cambio de contraseña y renovación de código con custodia y ACK', async () => {
      await controller.prepareRotatePassword(PASSWORD, NEXT_PASSWORD, NEXT_PASSWORD);
      await controller.commit();
      await denied(() => open(backend.envelope!, 'password', PASSWORD), 'Old password opened new envelope');
      const unchangedRecovery = await open(backend.envelope!, 'recovery', recoveryCode);
      unchangedRecovery.lock('navigation');
      const changed = await controller.beginRotateRecovery(NEXT_PASSWORD);
      noKey(changed);
      const previousCode = recoveryCode;
      recoveryCode = changed.recoveryCode;
      await controller.confirmCustody(NEXT_PASSWORD, recoveryCode);
      await controller.commit();
      check(previousCode !== recoveryCode, 'Recovery code reused');
      await denied(() => open(backend.envelope!, 'recovery', previousCode), 'Old recovery opened rotated envelope');
    });
    await test('Recuperación: lectura inicial, ambos medios renovados antes de escribir', async () => {
      controller.lock('navigation');
      controller = session(owner, backend);
      await controller.unlock(backend.envelope!, { kind: 'recovery', value: recoveryCode });
      const previous = structuredClone(backend.envelope!);
      const previousCode = recoveryCode;
      const recovered = await controller.beginRecovery(recoveryCode, RECOVERED_PASSWORD);
      noKey(recovered);
      recoveryCode = recovered.recoveryCode;
      await controller.confirmCustody(RECOVERED_PASSWORD, recoveryCode);
      await controller.commit();
      const next = backend.envelope!;
      check(
        next.passwordWrap.wrappedKey !== previous.passwordWrap.wrappedKey && next.recoveryWrap.wrappedKey !== previous.recoveryWrap.wrappedKey,
        'Recovery failed to rotate both wraps',
      );
      check(BigInt(next.credentialEpoch) === BigInt(previous.credentialEpoch) + 1n, 'Recovery epoch failed');
      await denied(() => open(next, 'password', NEXT_PASSWORD), 'Old password survived recovery');
      await denied(() => open(next, 'recovery', previousCode), 'Old recovery survived recovery');
      const recoveredOpen = await open(next, 'recovery', recoveryCode);
      check((await read(recoveredOpen)).financialSpace.revisionNote === 'second synthetic revision', 'Recovered content changed');
      recoveredOpen.lock('navigation');
    });
    await test('Rescate desde el dispositivo abierto: nueva clave y nuevos medios', async () => {
      const previous = structuredClone(backend.envelope!);
      const changed = await controller.beginRekey(REKEY_PASSWORD);
      recoveryCode = changed.recoveryCode;
      await controller.confirmCustody(REKEY_PASSWORD, recoveryCode);
      await controller.commit();
      check(BigInt(backend.envelope!.keyEpoch) === BigInt(previous.keyEpoch) + 1n, 'Full rekey did not change key epoch');
      const reopened = await open(backend.envelope!, 'password', REKEY_PASSWORD);
      check((await read(reopened)).financialSpace.revisionNote === 'second synthetic revision', 'Full rekey changed content');
      reopened.lock('navigation');
      controller.lock('navigation');
    });
    await test('Unicode: NFC y NFD equivalentes, sin recortar espacios', async () => {
      const unicodeBackend = new MemoryBackend();
      const unicode = session('synthetic-unicode-owner', unicodeBackend);
      const nfd = 'e\u0301'.repeat(400);
      const nfc = nfd.normalize('NFC');
      const draft = await unicode.beginCreate({ vaultId: randomId(), password: nfd, plaintext: snapshot });
      await unicode.confirmCustody(nfc, draft.recoveryCode);
      await unicode.commit();
      unicode.lock('navigation');
      const reopened = await open(unicodeBackend.envelope!, 'password', nfc);
      reopened.lock('navigation');
      await denied(() => open(unicodeBackend.envelope!, 'password', ' ' + nfc), 'Password whitespace was silently trimmed');
    });
    await test('Bloqueo: cambio de sesión, inactividad, pestaña oculta y resultados tardíos', async () => {
      let now = Date.now();
      let clears = 0;
      let identity: VaultSessionIdentity = { ownerId: owner, sessionId: 'synthetic-lifecycle-session', epoch: '1', valid: true };
      const options = {
        now: () => now,
        identity: async () => identity,
        onClear: () => {
          clears++;
        },
      };
      const idle = session(owner, backend, options);
      await idle.unlock(backend.envelope!, { kind: 'password', value: REKEY_PASSWORD });
      await read(idle);
      now += 300_001;
      idle.tick();
      await denied(() => idle.read(), 'Idle vault disclosed plaintext');
      const hidden = session(owner, backend, options);
      await hidden.unlock(backend.envelope!, { kind: 'password', value: REKEY_PASSWORD });
      const before = clears;
      hidden.setHidden(true);
      check(clears > before, 'Hidden vault did not clear the UI immediately');
      now += 60_001;
      hidden.tick();
      hidden.setHidden(false);
      await denied(() => hidden.read(), 'Hidden timeout kept vault unlocked');
      const changed = session(owner, backend, options);
      await changed.unlock(backend.envelope!, { kind: 'password', value: REKEY_PASSWORD });
      identity = { ...identity, sessionId: 'changed-session' };
      await denied(() => changed.read(), 'Session change disclosed old plaintext');
      const lateBackend = new MemoryBackend();
      let created!: () => void;
      const sent = new Promise<void>(resolve => {
        created = resolve;
      });
      const late = session(owner, lateBackend, {
        makeWorker: () => {
          const worker = new Worker(new URL('../../src/app/finance/worker/vault.worker.ts', import.meta.url), { type: 'module' });
          const post = worker.postMessage.bind(worker);
          worker.postMessage = ((value: unknown) => {
            post(value);
            if (value && typeof value === 'object' && 'method' in value && value.method === 'create') created();
          }) as Worker['postMessage'];
          return worker;
        },
      });
      const pending = late.beginCreate({ vaultId: randomId(), password: PASSWORD, plaintext: snapshot });
      await sent;
      await new Promise(resolve => setTimeout(resolve, 25));
      late.lock('logout');
      await denied(() => pending, 'Late Worker result reactivated a logged-out vault');
      check(lateBackend.bodies.length === 0, 'Late create wrote data');
    });
    await test('Eventos de página: BFCache simulado y desmontaje invalidan el Worker', async () => {
      const page = session(owner, backend);
      await page.unlock(backend.envelope!, { kind: 'password', value: REKEY_PASSWORD });
      const unbind = bindVaultBrowserLifecycle(page);
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      await denied(() => page.read(), 'BFCache event reactivated plaintext');
      unbind();
      const unmounted = session(owner, backend);
      await unmounted.unlock(backend.envelope!, { kind: 'password', value: REKEY_PASSWORD });
      const dispose = bindVaultBrowserLifecycle(unmounted);
      dispose();
      await denied(() => unmounted.read(), 'Unmount kept Worker open');
    });
    await test('Rechazo confirmado: permisos, conflicto y reautenticación bloquean de inmediato', async () => {
      for (const code of ['FINANCE_ACCESS_DENIED', 'FINANCE_CONFLICT', 'REAUTHENTICATION_REQUIRED'] as const) {
        const rejectedBackend = new MemoryBackend();
        rejectedBackend.save = async () => {
          throw new DefinitiveOpaqueSaveError(code);
        };
        const rejected = session(owner, rejectedBackend);
        await rejected.unlock(backend.envelope!, { kind: 'password', value: REKEY_PASSWORD });
        await rejected.prepareWrite(snapshot);
        await denied(() => rejected.commit(), 'Definitive denial became success');
        check(rejected.state().phase === 'locked' && !rejected.state().canDisplay, 'Definitive denial retained the active Worker');
        await denied(() => rejected.read(), 'Definitively denied vault disclosed plaintext');
      }
      const uncertainBackend = new MemoryBackend();
      uncertainBackend.envelope = structuredClone(backend.envelope);
      uncertainBackend.loseNextAck = true;
      const uncertain = session(owner, uncertainBackend);
      await uncertain.unlock(backend.envelope!, { kind: 'password', value: REKEY_PASSWORD });
      await uncertain.prepareWrite(snapshot);
      await denied(() => uncertain.commit(), 'Lost ACK became success');
      check(uncertain.state().phase === 'unconfirmed', 'Ambiguous network response lost the exact retry');
      uncertainBackend.save = async () => {
        throw new DefinitiveOpaqueSaveError('FINANCE_ACCESS_DENIED');
      };
      await denied(() => uncertain.commit(), 'Denied retry became success');
      check(uncertain.state().phase === 'locked', 'Denied retry retained the pending Worker');
    });
    const bridge = async (path: string, method = 'GET', body?: string): Promise<unknown> => {
      const response = await fetch('/test-api/' + path, {
        method,
        cache: 'no-store',
        redirect: 'error',
        headers: { 'x-tr8-fixture-request': '6b2', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body }),
      });
      const value = await response.json();
      if (!response.ok) {
        const code = value?.error?.code;
        const statuses = {
          AUTH_REQUIRED: 401,
          FINANCE_ACCESS_DENIED: 403,
          FINANCE_CONFLICT: 409,
          REAUTHENTICATION_REQUIRED: 403,
          CONTEXT_DENIED: 403,
          INVALID_INPUT: 400,
        };
        if (
          path === 'save' &&
          value &&
          Object.keys(value).length === 1 &&
          value.error &&
          Object.keys(value.error).length === 1 &&
          isDefinitiveOpaqueSaveCode(code) &&
          statuses[code] === response.status
        )
          throw new DefinitiveOpaqueSaveError(code);
        throw new Error('Synthetic hosted bridge unavailable');
      }
      return value;
    };
    const available = (await bridge('available')) as { hosted: boolean };
    if (available.hosted) {
      await test('Worker → HTTP → Supabase TEST: creación, lectura nueva, recuperación y rekey', async () => {
        const actor = (await bridge('start', 'POST')) as VaultSessionIdentity;
        const makeHosted = () => {
          const client = new VaultSessionController({
            ownerId: actor.ownerId,
            verifyIdentity: async () => (await bridge('identity')) as VaultSessionIdentity,
            saveOpaque: async body => {
              check(
                !body.includes('TR8 6B.2 browser fixture') && !body.includes(PASSWORD) && !body.includes(RECOVERED_PASSWORD),
                'Private means or plaintext in HTTP payload',
              );
              return (await bridge('save', 'PUT', body)) as OpaqueReceipt;
            },
            onClear: () => {},
          });
          controllers.push(client);
          return client;
        };
        try {
          const hosted = makeHosted();
          const draft = await hosted.beginCreate({ vaultId: randomId(), password: PASSWORD, plaintext: snapshot });
          await hosted.confirmCustody(PASSWORD, draft.recoveryCode);
          await hosted.commit();
          const first = (await bridge('state')) as { envelope: VaultEnvelope; epoch: string };
          check(first.envelope.ownerId === actor.ownerId && first.envelope.revision === '1', 'Hosted create not persisted');
          hosted.lock('navigation');
          const reopened = makeHosted();
          await reopened.unlock(first.envelope, { kind: 'password', value: PASSWORD });
          check(JSON.stringify(await read(reopened)) === JSON.stringify(snapshot), 'Hosted fresh browser Worker could not decrypt');
          await reopened.prepareWrite({ ...snapshot, financialSpace: { ...snapshot.financialSpace, persisted: true } });
          await reopened.commit();
          reopened.lock('navigation');
          const second = (await bridge('state')) as { envelope: VaultEnvelope; epoch: string };
          const recovery = makeHosted();
          await recovery.unlock(second.envelope, { kind: 'recovery', value: draft.recoveryCode });
          const rotated = await recovery.beginRecovery(draft.recoveryCode, RECOVERED_PASSWORD);
          await recovery.confirmCustody(RECOVERED_PASSWORD, rotated.recoveryCode);
          await recovery.commit();
          const third = (await bridge('state')) as { envelope: VaultEnvelope; epoch: string };
          check(third.envelope.credentialEpoch === '2' && third.envelope.revision === '3', 'Hosted recovery epochs invalid');
          const rekey = await recovery.beginRekey(REKEY_PASSWORD);
          await recovery.confirmCustody(REKEY_PASSWORD, rekey.recoveryCode);
          await recovery.commit();
          recovery.lock('navigation');
          const final = (await bridge('state')) as { envelope: VaultEnvelope; epoch: string };
          check(final.envelope.keyEpoch === '2' && final.envelope.revision === '4', 'Hosted rekey not persisted');
          const finalOpen = makeHosted();
          await finalOpen.unlock(final.envelope, { kind: 'password', value: REKEY_PASSWORD });
          check((await read(finalOpen)).financialSpace.persisted === true, 'Hosted final data changed');
          finalOpen.lock('navigation');
          evidence.hosted = {
            freshContext: true,
            keyEpoch: final.envelope.keyEpoch,
            credentialEpoch: final.envelope.credentialEpoch,
            revision: final.envelope.revision,
            actualAuth: true,
            opaqueOnly: true,
            bridge: 'same-origin local server to TEST Edge; CORS boundary belongs to 6B.1',
          };
        } finally {
          evidence.hostedTransport = await bridge('close', 'POST');
        }
      });
    } else evidence.hosted = 'Not configured; local Worker acceptance only';
    await test('Persistencia del navegador: ninguna contraseña, clave o copia local', async () => {
      check(localStorage.length === 0 && sessionStorage.length === 0, 'Vault persisted browser storage');
      check((await indexedDB.databases()).length === 0, 'Vault created IndexedDB');
      check((await caches.keys()).length === 0, 'Vault created CacheStorage');
      evidence.browserStorage = { localStorage: 0, sessionStorage: 0, indexedDB: 0, caches: 0 };
    });
    evidence.checks = checks;
    evidence.passed = completed.length;
    evidence.durationMs = Math.round(performance.now() - started);
    evidence.status = 'passed';
    evidence.completed = completed;
    status.textContent = `${completed.length} escenarios aprobados · ${checks} comprobaciones`;
  } catch {
    const row = document.createElement('li');
    row.dataset.pass = 'false';
    row.textContent = `✗ ${currentLabel}`;
    results.append(row);
    evidence.status = 'failed';
    evidence.failed = currentLabel;
    evidence.passed = completed.length;
    evidence.checks = checks;
    status.textContent = 'Una comprobación falló. No se modificaron datos reales.';
  } finally {
    controllers.splice(0).forEach(controller => controller.lock('navigation'));
    report.textContent = JSON.stringify(evidence, null, 2);
    button.disabled = false;
  }
});
