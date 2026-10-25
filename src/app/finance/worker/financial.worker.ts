import { VaultWorkerEngine } from './engine';
import { financialVaultPolicy } from './financial-policy';

const scope = globalThis as unknown as { onmessage: (event: MessageEvent<unknown>) => void; postMessage: (value: unknown) => void; close: () => void };
const engine = new VaultWorkerEngine(undefined, financialVaultPolicy);
scope.onmessage = event => {
  void engine.handle(event.data).then(
    reply => scope.postMessage(reply),
    () => {
      engine.close();
      scope.postMessage(null);
      scope.close();
    },
  );
};
