/** Separate synthetic UI acceptance entry. Never imported into the application. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import FinancePage from '../../src/app/finance/ui/FinancePage';
import { FinanceApiError, validateHead, type FinanceApi } from '../../src/app/finance/ui/api';
import { DefinitiveOpaqueSaveError, isDefinitiveOpaqueSaveCode } from '../../src/app/finance/session/opaque-save';
import type { VaultSessionIdentity } from '../../src/app/finance/session/lifecycle';
import { requireClosedRecord, validateEpoch, decodeBase64Url } from '../../src/app/finance/compatibility/protocol';
import '../../src/styles/index.css';
import '../../src/app/app.css';
import '../../src/app/workspace/workspace.css';

const owner = '37848d70-989a-4f69-b124-0c959d8b49a6';
async function request(path: string, method = 'GET', body?: string): Promise<unknown> {
  const response = await fetch(`/test-api/${path}`, {
    method,
    headers: { 'x-tr8-fixture-request': '6b2', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    cache: 'no-store',
    ...(body ? { body } : {}),
  });
  const value = await response.json();
  if (!response.ok) {
    const code = value?.error?.code;
    if (
      isDefinitiveOpaqueSaveCode(code) &&
      response.status ===
        { AUTH_REQUIRED: 401, FINANCE_ACCESS_DENIED: 403, FINANCE_CONFLICT: 409, REAUTHENTICATION_REQUIRED: 403, CONTEXT_DENIED: 403, INVALID_INPUT: 400 }[code]
    )
      throw new DefinitiveOpaqueSaveError(code);
    throw new FinanceApiError('DEPENDENCY_UNAVAILABLE');
  }
  return value;
}
export function Harness() {
  const [api, setApi] = useState<FinanceApi | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true);
    try {
      let actor: VaultSessionIdentity;
      try {
        actor = (await request('identity')) as VaultSessionIdentity;
      } catch {
        actor = (await request('start', 'POST')) as VaultSessionIdentity;
      }
      if (actor.ownerId !== owner || actor.valid !== true) throw Error();
      setApi({
        ownerId: owner,
        enabled: true,
        syntheticOnly: true,
        head: async () => validateHead(await request('state'), owner),
        identity: async () => {
          const i = (await request('identity')) as VaultSessionIdentity;
          if (i.ownerId !== owner || !i.valid) throw Error();
          return i;
        },
        save: async body => {
          const r = requireClosedRecord(await request('save', 'PUT', body), ['operationId', 'revision']);
          decodeBase64Url(r.operationId as string, 16);
          return { operationId: r.operationId as string, revision: validateEpoch(r.revision) };
        },
        subscribe: () => () => {},
        reauthenticate: async () => {
          throw new FinanceApiError('REAUTHENTICATION_REQUIRED');
        },
      });
      setStatus('');
    } catch {
      setStatus('No se pudo iniciar la prueba sintética. Comprueba el servidor de pruebas.');
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    setApi(null);
    setBusy(true);
    try {
      const result = await request('close', 'POST');
      setStatus(JSON.stringify(result, null, 2));
    } catch {
      setStatus('No se pudo cerrar la sesión de prueba.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <div className="tf-page tf-toolbar">
        <strong>TR8 · Prueba sintética 6B.4</strong>
        {api ? (
          <button className="btn btn-secondary" disabled={busy} onClick={() => void close()}>
            Cerrar prueba y sesión
          </button>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={() => void start()}>
            Iniciar prueba de interfaz
          </button>
        )}
      </div>
      {status && <pre aria-label="Informe de pruebas">{status}</pre>}
      {api && <FinancePage api={api} />}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
