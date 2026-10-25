import { useCallback, useEffect, useRef, useState } from 'react';
import { FinancialVaultSessionController } from '../session/financial-controller';
import { bindVaultBrowserLifecycle } from '../session/browser-lifecycle';
import { validateFinancialSnapshot } from '../domain/snapshot';
import { emptyFinancialSnapshot } from '../domain/workspace';
import { validatePlaintext } from '../crypto/plaintext';
import { encodeBase64Url, MAX_ENVELOPE_BYTES } from '../compatibility/protocol';
import type { FinancialSnapshot } from '../domain/workspace-types';
import type { VaultBackupPreview } from '../session/controller';
import type { PrivateCredential } from '../crypto/credentials';
import type { FinanceApi, FinanceHead } from './api';

export type FinanceStage = 'checking' | 'unavailable' | 'empty' | 'locked' | 'open' | 'custody' | 'preview' | 'pending';
interface View {
  stage: FinanceStage;
  snapshot: FinancialSnapshot | null;
  recovery: string | null;
  preview: VaultBackupPreview | null;
  restore: boolean;
  error: string;
  formEpoch: number;
}
const initial: View = { stage: 'checking', snapshot: null, recovery: null, preview: null, restore: false, error: '', formEpoch: 0 };
function message(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  switch (code) {
    case 'FINANCE_DISABLED':
      return 'La bóveda aún no está habilitada en este entorno.';
    case 'REAUTHENTICATION_REQUIRED':
      return 'Vuelve a confirmar tu contraseña de TR8 y abre de nuevo la bóveda.';
    case 'FINANCE_CONFLICT':
    case 'STALE_REVISION':
      return 'La bóveda cambió en otro dispositivo. Bloquéala y vuelve a abrir la versión actual.';
    case 'AUTH_REQUIRED':
    case 'FINANCE_ACCESS_DENIED':
      return 'Tu sesión ya no permite acceder a la bóveda. Vuelve a iniciar sesión.';
    case 'AUTH_FAILED':
    case 'INVALID_PASSWORD':
    case 'INVALID_RECOVERY':
      return 'No se pudo abrir con ese medio privado. Comprueba la contraseña o el código completo.';
    case 'INVALID_PLAINTEXT':
    case 'UNSUPPORTED_FORMAT':
    case 'INVALID_FORMAT':
      return 'El archivo o los datos financieros no son compatibles.';
    case 'CRYPTO_UNAVAILABLE':
      return 'Este navegador no dispone de las capacidades necesarias para abrir la bóveda.';
    case 'SIZE_LIMIT':
      return 'El respaldo supera el límite permitido de 2 MiB.';
    default:
      return 'No se pudo confirmar la operación. Revisa la conexión; si hay un guardado pendiente, reintenta el mismo guardado.';
  }
}

export function useFinance(api: FinanceApi) {
  const [view, setView] = useState<View>(initial);
  const [busy, setBusy] = useState(false);
  const controller = useRef<FinancialVaultSessionController | null>(null);
  const head = useRef<FinanceHead | null>(null);
  const mounted = useRef(false);
  const operation = useRef(0);
  const running = useRef(false);
  const clear = useCallback(() => {
    if (mounted.current) setView(v => ({ ...initial, stage: 'locked', formEpoch: v.formEpoch + 1 }));
  }, []);
  const lock = useCallback(() => {
    operation.current++;
    running.current = false;
    controller.current?.lock('logout');
    if (mounted.current) setBusy(false);
  }, []);
  useEffect(() => {
    mounted.current = true;
    running.current = false;
    setBusy(false);
    setView(initial);
    if (!api.enabled) {
      setView({ ...initial, stage: 'unavailable' });
      return () => {
        mounted.current = false;
      };
    }
    const c = new FinancialVaultSessionController({
      ownerId: api.ownerId,
      verifyIdentity: api.identity,
      readOpaque: api.head,
      saveOpaque: api.save,
      onClear: clear,
    });
    controller.current = c;
    const unbind = bindVaultBrowserLifecycle(c);
    const unsubscribe = api.subscribe(lock);
    const token = ++operation.current;
    void api.head().then(
      value => {
        if (mounted.current && token === operation.current && !document.hidden) {
          head.current = value;
          setView(v => ({ ...v, stage: value.envelope ? 'locked' : 'empty' }));
        }
      },
      error => {
        if (mounted.current && token === operation.current) setView(v => ({ ...v, stage: 'unavailable', error: message(error) }));
      },
    );
    return () => {
      mounted.current = false;
      // This is an action counter, deliberately invalidated at cleanup time.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      operation.current++;
      unbind();
      unsubscribe();
      c.lock('navigation');
      controller.current = null;
      head.current = null;
    };
  }, [api, clear, lock]);

  async function run(work: (c: FinancialVaultSessionController, valid: () => void, begin: <T>(job: () => Promise<T>) => Promise<T>) => Promise<Partial<View>>) {
    const c = controller.current;
    if (!c || running.current) return;
    running.current = true;
    const token = ++operation.current;
    setBusy(true);
    setView(v => ({ ...v, error: '' }));
    let generation = c.state().generation;
    const current = () => mounted.current && controller.current === c && token === operation.current && !document.hidden && c.state().generation === generation;
    const valid = () => {
      if (!current()) throw new Error('STALE_VIEW');
    };
    const begin = <T>(job: () => Promise<T>) => {
      valid();
      const pending = job();
      generation = c.state().generation;
      return pending;
    };
    try {
      const update = await work(c, valid, begin);
      valid();
      setView(v => (current() && (!update.snapshot || c.state().canDisplay) ? { ...v, ...update } : v));
    } catch (error) {
      if (mounted.current && controller.current === c && token === operation.current && !document.hidden) {
        const state = c.state();
        setView(v => ({
          ...v,
          snapshot: null,
          recovery: null,
          preview: null,
          stage: state.phase === 'unconfirmed' ? 'pending' : 'locked',
          error: message(error),
        }));
      }
    } finally {
      if (token === operation.current && mounted.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function opened(c: FinancialVaultSessionController, valid: () => void): Promise<Partial<View>> {
    const snapshot = validateFinancialSnapshot(await c.read());
    valid();
    if (!c.state().canDisplay) throw new Error('STALE_VIEW');
    return { snapshot, stage: 'open', recovery: null, preview: null, error: '' };
  }
  return {
    view,
    busy,
    lock,
    controller,
    refresh: () =>
      run(async (_c, valid) => {
        const value = await api.head();
        valid();
        head.current = value;
        return { stage: value.envelope ? 'locked' : 'empty' };
      }),
    create: (password: string) =>
      run(async (c, valid, begin) => {
        const current = await api.head();
        valid();
        if (current.envelope) throw new Error('DESTINATION_OCCUPIED');
        const result = await begin(() =>
          c.beginCreate({
            vaultId: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
            password,
            plaintext: validatePlaintext(emptyFinancialSnapshot()),
          }),
        );
        valid();
        return { stage: 'custody', recovery: result.recoveryCode };
      }),
    unlock: (credential: PrivateCredential) =>
      run(async (c, valid, begin) => {
        const current = await api.head();
        valid();
        head.current = current;
        if (!current.envelope) return { stage: 'empty' };
        await begin(() => c.unlock(current.envelope!, credential));
        valid();
        return opened(c, valid);
      }),
    custody: (password: string, code: string) =>
      run(async (c, valid) => {
        await c.confirmCustody(password, code);
        valid();
        await c.commit();
        valid();
        return opened(c, valid);
      }),
    save: (snapshot: FinancialSnapshot) =>
      run(async (c, valid) => {
        await c.prepareWrite(validatePlaintext(snapshot));
        valid();
        await c.commit();
        valid();
        return opened(c, valid);
      }),
    retry: () =>
      run(async (c, valid) => {
        await c.commit();
        valid();
        return opened(c, valid);
      }),
    recover: (code: string, password: string) =>
      run(async (c, valid) => {
        const result = await c.beginRecovery(code, password);
        valid();
        return { stage: 'custody', recovery: result.recoveryCode };
      }),
    rotatePassword: (old: string, next: string, confirmation: string) =>
      run(async (c, valid) => {
        await c.prepareRotatePassword(old, next, confirmation);
        valid();
        await c.commit();
        valid();
        return opened(c, valid);
      }),
    rotateRecovery: (password: string) =>
      run(async (c, valid) => {
        const result = await c.beginRotateRecovery(password);
        valid();
        return { stage: 'custody', recovery: result.recoveryCode };
      }),
    rekey: (password: string) =>
      run(async (c, valid) => {
        const result = await c.beginRekey(password);
        valid();
        return { stage: 'custody', recovery: result.recoveryCode };
      }),
    previewFile: (file: File, credential: PrivateCredential, restore: boolean) =>
      run(async (c, valid, begin) => {
        if (file.size > MAX_ENVELOPE_BYTES) throw { code: 'SIZE_LIMIT' };
        const backup = await file.text();
        valid();
        const preview = await begin(() => (restore ? c.beginRestorePreview(backup, credential) : c.beginImportPreview(backup, credential)));
        valid();
        return { stage: 'preview', preview, restore };
      }),
    acceptPreview: (password: string) =>
      run(async (c, valid) => {
        if (!view.preview) throw new Error('NO_PREVIEW');
        if (view.restore) {
          await c.acceptRestore(view.preview.previewId);
          valid();
          await c.commit();
          valid();
          return opened(c, valid);
        }
        const result = await c.acceptImport(view.preview.previewId, password);
        valid();
        return { stage: 'custody', recovery: result.recoveryCode, preview: null };
      }),
    exportBackup: () =>
      run(async (c, valid) => {
        const body = await c.exportBackup();
        valid();
        const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'tr8-respaldo-cifrado.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return {};
      }),
    reauthenticate: (password: string) => {
      lock();
      const token = operation.current;
      return api.reauthenticate(password).catch(error => {
        if (mounted.current && token === operation.current) setView(v => ({ ...v, error: message(error) }));
      });
    },
  };
}
