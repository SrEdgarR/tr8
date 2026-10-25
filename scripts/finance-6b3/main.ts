import vector from '../../src/app/finance/compatibility/fixtures/vault-vectors.json';
import {
  MAX_ENVELOPE_BYTES,
  assertOpaqueTransition,
  encodeBase64Url,
  encodeUtf8,
  parseOpaquePut,
  type OpaqueReceipt,
  type VaultEnvelope,
} from '../../src/app/finance/compatibility/protocol';
import { DefinitiveOpaqueSaveError, isDefinitiveOpaqueSaveCode, VaultSessionController } from '../../src/app/finance/session/controller';
import { FinancialVaultSessionController } from '../../src/app/finance/session/financial-controller';
import type { VaultSessionIdentity } from '../../src/app/finance/session/lifecycle';
import { parseEncryptedBackup, serializeEncryptedBackup } from '../../src/app/finance/import/format';
import { encodeRecoverySecret, formatRecoverySecret } from '../../src/app/finance/crypto/recovery';
import { validatePlaintext } from '../../src/app/finance/crypto/plaintext';
import { validateFinancialSnapshot } from '../../src/app/finance/domain/snapshot';
import { upgradeSnapshot } from '../../src/app/finance/domain/workspace';
import { calculateFinancialBalances } from '../../src/app/finance/domain/balances';
import { addPlan, projectSnapshot, resolvePlan } from '../../src/app/finance/domain/plans';
import type { FinancialSnapshot } from '../../src/app/finance/domain/workspace-types';

const button = document.querySelector<HTMLButtonElement>('#run')!;
const status = document.querySelector<HTMLElement>('#status')!;
const results = document.querySelector<HTMLOListElement>('#results')!;
const report = document.querySelector<HTMLElement>('#report')!;
const PASSWORD = 'SYNTHETIC ONLY TR8 imported private password 🔐';
const REKEY_PASSWORD = 'SYNTHETIC ONLY TR8 rekey private password 🔐';
const sourceBackup = serializeEncryptedBackup(vector.envelope as VaultEnvelope);
const oldCredential = { kind: 'password' as const, value: vector.password };
const sourceRecoveryCode = formatRecoverySecret(encodeRecoverySecret(Uint8Array.from(vector.recoveryHex.match(/../g)!, value => Number.parseInt(value, 16))));
const controllers: VaultSessionController[] = [];
let checks = 0;
class HarnessFailure extends Error {}
function check(condition: unknown, label: string): asserts condition {
  checks++;
  if (!condition) throw new HarnessFailure(label);
}
async function denied(job: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await job();
  } catch {
    checks++;
    return;
  }
  throw new HarnessFailure(label);
}
function noKey(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  check(!(value instanceof CryptoKey) && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value), 'Key material crossed the Worker boundary');
  Object.values(value).forEach(noKey);
}
const randomId = () => encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));

class MemoryBackend {
  envelope: VaultEnvelope | null = null;
  bodies: string[] = [];
  receipts = new Map<string, { body: string; receipt: OpaqueReceipt }>();
  loseNextAck = false;
  async read() {
    return { envelope: structuredClone(this.envelope), epoch: '1' };
  }
  async save(body: string): Promise<OpaqueReceipt> {
    this.bodies.push(body);
    const put = parseOpaquePut(body);
    noKey(put);
    const old = this.receipts.get(put.operationId);
    if (old) {
      check(old.body === body, 'Retry changed the original opaque bytes');
      return old.receipt;
    }
    assertOpaqueTransition(this.envelope, put);
    this.envelope = structuredClone(put.envelope);
    const receipt = { operationId: put.operationId, revision: put.envelope.revision };
    this.receipts.set(put.operationId, { body, receipt });
    if (this.loseNextAck) {
      this.loseNextAck = false;
      throw new Error('Synthetic lost ACK');
    }
    return receipt;
  }
}
function session(ownerId: string, backend = new MemoryBackend(), makeWorker?: () => Worker): FinancialVaultSessionController {
  const client = new FinancialVaultSessionController({
    ownerId,
    verifyIdentity: async () => ({ ownerId, sessionId: 'synthetic-financial-browser-session', epoch: '1', valid: true }),
    readOpaque: () => backend.read(),
    saveOpaque: body => backend.save(body),
    onClear: () => {},
    ...(makeWorker ? { makeWorker } : {}),
  });
  controllers.push(client);
  return client;
}
async function read(client: VaultSessionController): Promise<FinancialSnapshot> {
  const snapshot = await client.read();
  noKey(snapshot);
  return validateFinancialSnapshot(snapshot);
}
function planned(snapshot: FinancialSnapshot): FinancialSnapshot {
  return addPlan(snapshot, {
    id: 'synthetic-browser-plan',
    operation: {
      id: 'synthetic-browser-planned-operation',
      kind: 'expense',
      accountId: 'synthetic-debit',
      currency: 'DOP',
      amountMinor: 37,
      date: '2026-11-01',
      description: 'TR8 SYNTHETIC planned entry 6B3',
      note: '',
      category: 'other',
    },
  });
}
async function probe(command: 'vector' | 'deny-wasm'): Promise<unknown> {
  const worker = new Worker(new URL('../finance-6b2/probe.worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new HarnessFailure('Real WASM probe timed out')), 20_000);
      worker.onmessage = event => {
        clearTimeout(timer);
        noKey(event.data);
        if (event.data.command === command && event.data.passed === true) resolve(event.data.timing ?? true);
        else reject(new HarnessFailure('Real WASM probe failed'));
      };
      worker.onerror = () => {
        clearTimeout(timer);
        reject(new HarnessFailure('Probe Worker failed'));
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
  const evidence: Record<string, unknown> = {
    syntheticOnly: true,
    actualWorker: true,
    actualWasm: true,
    financialProfile: true,
    productionFinanceEnabled: false,
  };
  const completed: string[] = [];
  const started = performance.now();
  let currentLabel = '';
  async function test(label: string, job: () => Promise<void>) {
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
    await test('Argon2id WASM real y denegación si WASM deja de estar disponible', async () => {
      evidence.kdfTiming = await probe('vector');
      await probe('deny-wasm');
    });
    const owner = 'synthetic-financial-owner-' + randomId();
    const backend = new MemoryBackend();
    let client = session(owner, backend);
    let importedRecovery = '';
    let checkpoint = '';
    let badBackup = '';
    await test('Importación explícita: legado → dominio actual, custodia completa y ACK', async () => {
      const preview = await client.beginImportPreview(sourceBackup, oldCredential);
      noKey(preview);
      check(
        preview.summary.sourceDomainSchemaVersion === 1 && preview.summary.targetDomainSchemaVersion === 4 && preview.summary.requiresUpgrade,
        'Legacy upgrade was not explicit',
      );
      check(!JSON.stringify(preview).includes(vector.plaintext.financialSpace.accounts[0].name), 'Private account name crossed preview boundary');
      check(backend.bodies.length === 0, 'Preview wrote a vault');
      await denied(() => client.read(), 'Preview disclosed financial plaintext');
      await denied(() => client.exportBackup(), 'Preview exported an uncommitted vault');
      const custody = await client.acceptImport(preview.previewId, PASSWORD);
      noKey(custody);
      importedRecovery = custody.recoveryCode;
      const prepared = await client.confirmCustody(PASSWORD, importedRecovery);
      noKey(prepared);
      check(
        prepared.expectedRevision === '0' && prepared.envelope.ownerId === owner && prepared.envelope.vaultId !== vector.envelope.vaultId,
        'Import reused source context',
      );
      check(prepared.envelope.keyEpoch === '1' && prepared.envelope.credentialEpoch === '1', 'Import copied source epochs');
      await denied(() => client.exportBackup(), 'Prepared import exported before ACK');
      check(backend.envelope === null, 'Custody wrote before explicit commit');
      await client.commit();
      check(JSON.stringify(await read(client)) === JSON.stringify(upgradeSnapshot(vector.plaintext)), 'Imported ledger changed internal IDs or amounts');
      checkpoint = await client.exportBackup();
      check(parseEncryptedBackup(checkpoint).envelope.revision === '1', 'ACK export selected wrong revision');
      check(!checkpoint.includes(PASSWORD) && !checkpoint.includes(vector.plaintext.financialSpace.accounts[0].name), 'Backup exposed private material');
    });
    await test('Worker nuevo: contraseña y recuperación abren el mismo ledger validado', async () => {
      const envelope = structuredClone(backend.envelope!);
      client.lock('navigation');
      client = session(owner, backend);
      await client.unlock(envelope, { kind: 'password', value: PASSWORD });
      const passwordSnapshot = await read(client);
      const recovered = session(owner, backend);
      await recovered.unlock(envelope, { kind: 'recovery', value: importedRecovery });
      check(JSON.stringify(await read(recovered)) === JSON.stringify(passwordSnapshot), 'Recovery reopened another ledger');
      await denied(() => recovered.prepareWrite(validatePlaintext(passwordSnapshot)), 'Recovery allowed ordinary writes');
      recovered.lock('navigation');
      const oldMeans = session(owner, backend);
      await denied(() => oldMeans.unlock(envelope, oldCredential), 'Old source password opened new vault');
      const oldRecovery = session(owner, backend);
      await denied(() => oldRecovery.unlock(envelope, { kind: 'recovery', value: sourceRecoveryCode }), 'Old source recovery opened new vault');
    });
    await test('Perfil financiero: rechaza contenido cifrado válido que no pertenece al dominio', async () => {
      const invalidBackend = new MemoryBackend();
      const generic = new VaultSessionController({
        ownerId: owner,
        verifyIdentity: async () => ({ ownerId: owner, sessionId: 'synthetic-generic-session', epoch: '1', valid: true }),
        saveOpaque: body => invalidBackend.save(body),
        onClear: () => {},
      });
      controllers.push(generic);
      const draft = await generic.beginCreate({
        vaultId: randomId(),
        password: PASSWORD,
        plaintext: { schemaVersion: 1, financialSpace: { synthetic: true } },
      });
      await generic.confirmCustody(PASSWORD, draft.recoveryCode);
      await generic.commit();
      generic.lock('navigation');
      badBackup = serializeEncryptedBackup(invalidBackend.envelope!);
      const financial = session(owner, invalidBackend);
      await denied(() => financial.unlock(invalidBackend.envelope!, { kind: 'password', value: PASSWORD }), 'Financial Worker opened invalid domain');
      const legacy = session(vector.envelope.ownerId);
      await denied(() => legacy.unlock(vector.envelope as VaultEnvelope, oldCredential), 'Runtime opened legacy data without explicit upgrade');
    });
    await test('Backup manipulado, credenciales erróneas, dominio inválido y propietario renombrado se rechazan', async () => {
      const corrupt = structuredClone(vector.envelope) as VaultEnvelope;
      corrupt.payload.ciphertext = (corrupt.payload.ciphertext[0] === 'A' ? 'B' : 'A') + corrupt.payload.ciphertext.slice(1);
      for (const [backup, credential] of [
        [sourceBackup, { kind: 'password' as const, value: vector.password + 'wrong' }],
        [serializeEncryptedBackup(corrupt), oldCredential],
        [serializeEncryptedBackup({ ...vector.envelope, ownerId: 'same-email-is-not-authority' } as VaultEnvelope), oldCredential],
        [badBackup, { kind: 'password' as const, value: PASSWORD }],
      ] as const) {
        const candidateBackend = new MemoryBackend();
        const candidate = session(owner, candidateBackend);
        await denied(() => candidate.beginImportPreview(backup, credential), 'Invalid backup produced a preview');
        check(candidateBackend.bodies.length === 0, 'Invalid backup wrote data');
      }
    });
    await test('Previsualización ligada a sesión: logout y un ID anterior nunca aceptan otra importación', async () => {
      const stagedBackend = new MemoryBackend();
      const staged = session(owner, stagedBackend);
      const old = await staged.beginImportPreview(sourceBackup, oldCredential);
      staged.lock('logout');
      await denied(() => staged.acceptImport(old.previewId, PASSWORD), 'Logged-out preview remained valid');
      const next = await staged.beginImportPreview(sourceBackup, oldCredential);
      check(next.previewId !== old.previewId, 'Preview ID was reused');
      await denied(() => staged.acceptImport(old.previewId, PASSWORD), 'Old preview accepted a new candidate');
      check(stagedBackend.bodies.length === 0 && !staged.state().canDisplay, 'Stale preview activated data');
    });
    await test('Destino ocupado después de previsualizar: se rechaza sin sobrescribir', async () => {
      const occupied = new MemoryBackend();
      const staged = session(owner, occupied);
      const preview = await staged.beginImportPreview(sourceBackup, oldCredential);
      occupied.envelope = structuredClone(backend.envelope);
      const before = JSON.stringify(occupied.envelope);
      await denied(() => staged.acceptImport(preview.previewId, PASSWORD), 'Import overwrote an occupied destination');
      check(occupied.bodies.length === 0 && JSON.stringify(occupied.envelope) === before, 'Occupied destination changed');
    });
    await test('Archivo de 2 MiB: canonización opaca antes del mensaje al Worker', async () => {
      const pretty = JSON.stringify(JSON.parse(sourceBackup), null, 2);
      const padded = ' '.repeat(MAX_ENVELOPE_BYTES - encodeUtf8(pretty).byteLength) + pretty;
      check(encodeUtf8(padded).byteLength === MAX_ENVELOPE_BYTES, 'Fixture file did not reach the exact bound');
      const large = session(owner);
      const preview = await large.beginImportPreview(padded, { kind: 'recovery', value: sourceRecoveryCode });
      noKey(preview);
      large.lock('navigation');
      await denied(() => session(owner).beginImportPreview(' ' + padded, oldCredential), 'Oversized file was accepted');
    });
    await test('Planes separados del saldo real y guardado con reintento exacto tras ACK perdido', async () => {
      const initial = await read(client);
      const next = planned(initial);
      const space = next.financialSpace;
      const actual = calculateFinancialBalances(space.accounts, space.operations, '2026-10-25', space.currencyDefinitions);
      const projection = projectSnapshot(next, '2026-10-25', '2026-11-01');
      check(
        actual.accounts[0].balanceMinor === 767026 && projection.projected.accounts[0].balanceMinor === 766989,
        'Plan modified actual balance or projection lost integer precision',
      );
      const confirmed = resolvePlan(next, { type: 'confirm', planId: 'synthetic-browser-plan', date: '2026-10-25' });
      check(
        confirmed.financialSpace.operations.length === space.operations.length + 1 &&
          resolvePlan(confirmed, { type: 'confirm', planId: 'synthetic-browser-plan', date: '2026-10-25' }) === confirmed,
        'Plan confirmation duplicated a movement',
      );
      await client.prepareWrite(validatePlaintext(next));
      backend.loseNextAck = true;
      await denied(() => client.commit(), 'Lost ACK became successful');
      const originalBody = backend.bodies.at(-1);
      await denied(() => client.exportBackup(), 'Unconfirmed write exported a backup');
      await client.commit();
      check(originalBody === backend.bodies.at(-1), 'Retry regenerated request bytes');
      check((await read(client)).financialSpace.plans?.length === 1, 'Pending plan was lost');
      evidence.domainCalculationPassed = true;
    });
    await test('Rekey y restauración: datos previos con clave, wraps y epochs actuales', async () => {
      const custody = await client.beginRekey(REKEY_PASSWORD);
      await client.confirmCustody(REKEY_PASSWORD, custody.recoveryCode);
      await client.commit();
      const current = structuredClone(backend.envelope!);
      const preview = await client.beginRestorePreview(checkpoint, { kind: 'password', value: PASSWORD });
      noKey(preview);
      const prepared = await client.acceptRestore(preview.previewId);
      noKey(prepared);
      check(
        prepared.expectedRevision === current.revision &&
          JSON.stringify(prepared.envelope.passwordWrap) === JSON.stringify(current.passwordWrap) &&
          JSON.stringify(prepared.envelope.recoveryWrap) === JSON.stringify(current.recoveryWrap),
        'Restore reinstalled old private wraps',
      );
      check(
        prepared.envelope.keyEpoch === current.keyEpoch && prepared.envelope.credentialEpoch === current.credentialEpoch,
        'Restore changed live key epochs',
      );
      await denied(() => client.exportBackup(), 'Restore exported before ACK');
      await client.commit();
      check(backend.envelope!.revision === '4' && (await read(client)).financialSpace.plans?.length === 0, 'Restore failed to restore prior data');
      client.lock('navigation');
      client = session(owner, backend);
      await client.unlock(backend.envelope!, { kind: 'password', value: REKEY_PASSWORD });
      check(JSON.stringify(await read(client)) === JSON.stringify(upgradeSnapshot(vector.plaintext)), 'Fresh Worker could not reopen restored data');
    });
    await test('Restauración de otro contexto se rechaza sin escribir', async () => {
      const writes = backend.bodies.length;
      const before = JSON.stringify(backend.envelope);
      await denied(() => client.beginRestorePreview(sourceBackup, oldCredential), 'Restore accepted another owner or vault');
      check(backend.bodies.length === writes && JSON.stringify(backend.envelope) === before, 'Foreign restore changed persisted data');
    });
    await test('Worker en vuelo: logout descarta la apertura y no revela una previsualización tardía', async () => {
      const lateBackend = new MemoryBackend();
      let sent!: () => void;
      const requestSent = new Promise<void>(resolve => {
        sent = resolve;
      });
      const late = session(owner, lateBackend, () => {
        const worker = new Worker(new URL('../../src/app/finance/worker/financial.worker.ts', import.meta.url), { type: 'module' });
        const post = worker.postMessage.bind(worker);
        worker.postMessage = ((value: unknown) => {
          post(value);
          if (value && typeof value === 'object' && 'method' in value && value.method === 'import-preview') sent();
        }) as Worker['postMessage'];
        return worker;
      });
      const pending = late.beginImportPreview(sourceBackup, oldCredential);
      await requestSent;
      await new Promise(resolve => setTimeout(resolve, 25));
      late.lock('logout');
      await denied(() => pending, 'Late Worker preview reactivated after logout');
      check(late.state().phase === 'locked' && lateBackend.bodies.length === 0, 'Late Worker changed state');
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
        throw new HarnessFailure('Synthetic hosted bridge unavailable');
      }
      return value;
    };
    if (((await bridge('available')) as { hosted: boolean }).hosted)
      await test('Worker → HTTP → Supabase TEST: importar, escribir, rekey y restaurar con cuatro recibos', async () => {
        const actor = (await bridge('start', 'POST')) as VaultSessionIdentity;
        const makeHosted = () => {
          const hosted = new FinancialVaultSessionController({
            ownerId: actor.ownerId,
            verifyIdentity: async () => (await bridge('identity')) as VaultSessionIdentity,
            readOpaque: async () => (await bridge('state')) as { envelope: VaultEnvelope | null; epoch: string },
            saveOpaque: async body => {
              check(
                !body.includes(vector.plaintext.financialSpace.accounts[0].name) &&
                  !body.includes(PASSWORD) &&
                  !body.includes(REKEY_PASSWORD) &&
                  !body.includes('TR8 SYNTHETIC planned entry 6B3'),
                'Plaintext or private means in HTTP body',
              );
              return (await bridge('save', 'PUT', body)) as OpaqueReceipt;
            },
            onClear: () => {},
          });
          controllers.push(hosted);
          return hosted;
        };
        try {
          const hosted = makeHosted();
          const preview = await hosted.beginImportPreview(sourceBackup, oldCredential);
          const custody = await hosted.acceptImport(preview.previewId, PASSWORD);
          await hosted.confirmCustody(PASSWORD, custody.recoveryCode);
          await hosted.commit();
          const exported = await hosted.exportBackup();
          const first = (await bridge('state')) as { envelope: VaultEnvelope; epoch: string };
          check(
            first.envelope.ownerId === actor.ownerId && first.envelope.vaultId !== vector.envelope.vaultId && first.envelope.revision === '1',
            'Hosted import reused source context',
          );
          hosted.lock('navigation');
          const reopened = makeHosted();
          await reopened.unlock(first.envelope, { kind: 'password', value: PASSWORD });
          const initial = await read(reopened);
          check(JSON.stringify(initial) === JSON.stringify(upgradeSnapshot(vector.plaintext)), 'Hosted import changed ledger data');
          await reopened.prepareWrite(validatePlaintext(planned(initial)));
          await reopened.commit();
          const rekey = await reopened.beginRekey(REKEY_PASSWORD);
          await reopened.confirmCustody(REKEY_PASSWORD, rekey.recoveryCode);
          await reopened.commit();
          const beforeRestore = (await bridge('state')) as { envelope: VaultEnvelope; epoch: string };
          const restore = await reopened.beginRestorePreview(exported, { kind: 'password', value: PASSWORD });
          await reopened.acceptRestore(restore.previewId);
          await reopened.commit();
          reopened.lock('navigation');
          const final = (await bridge('state')) as { envelope: VaultEnvelope; epoch: string };
          check(
            final.envelope.revision === '4' &&
              final.envelope.keyEpoch === '2' &&
              final.envelope.credentialEpoch === '2' &&
              JSON.stringify(final.envelope.passwordWrap) === JSON.stringify(beforeRestore.envelope.passwordWrap),
            'Hosted restore replaced live credentials',
          );
          const finalOpen = makeHosted();
          await finalOpen.unlock(final.envelope, { kind: 'password', value: REKEY_PASSWORD });
          check(JSON.stringify(await read(finalOpen)) === JSON.stringify(initial), 'Hosted restored ledger differs');
          finalOpen.lock('navigation');
          const recovered = makeHosted();
          await recovered.unlock(final.envelope, { kind: 'recovery', value: rekey.recoveryCode });
          check(JSON.stringify(await read(recovered)) === JSON.stringify(initial), 'Hosted recovery differs after restore');
          recovered.lock('navigation');
          evidence.hosted = {
            actualAuth: true,
            opaqueOnly: true,
            importedNewContext: true,
            preservedInternalIds: true,
            restoredPriorData: true,
            revision: final.envelope.revision,
            keyEpoch: final.envelope.keyEpoch,
            credentialEpoch: final.envelope.credentialEpoch,
            sourceUnchanged: serializeEncryptedBackup(vector.envelope as VaultEnvelope) === sourceBackup,
          };
        } finally {
          evidence.hostedTransport = await bridge('close', 'POST');
        }
      });
    else evidence.hosted = 'Not configured; local financial Worker acceptance only';
    await test('Sin persistencia local de contenido financiero ni medios privados', async () => {
      check(localStorage.length === 0 && sessionStorage.length === 0, 'Financial data persisted browser storage');
      check((await indexedDB.databases()).length === 0 && (await caches.keys()).length === 0, 'Financial data persisted in browser databases or caches');
      evidence.browserStorage = { localStorage: 0, sessionStorage: 0, indexedDB: 0, caches: 0 };
    });
    evidence.checks = checks;
    evidence.passed = completed.length;
    evidence.completed = completed;
    evidence.durationMs = Math.round(performance.now() - started);
    evidence.status = 'passed';
    status.textContent = `${completed.length} escenarios aprobados · ${checks} comprobaciones`;
  } catch (cause) {
    const row = document.createElement('li');
    row.dataset.pass = 'false';
    row.textContent = `✗ ${currentLabel}`;
    results.append(row);
    evidence.status = 'failed';
    evidence.failed = currentLabel;
    evidence.passed = completed.length;
    evidence.checks = checks;
    evidence.failure =
      cause instanceof HarnessFailure
        ? cause.message
        : cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && /^[A-Z_]{1,64}$/.test(cause.code)
          ? cause.code
          : 'CHECK_FAILED';
    status.textContent = 'Una comprobación falló. No se modificaron datos reales.';
  } finally {
    controllers.splice(0).forEach(item => item.lock('navigation'));
    report.textContent = JSON.stringify(evidence, null, 2);
    button.disabled = false;
  }
});
