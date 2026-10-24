import { VaultWorkerEngine } from './engine';

const scope = globalThis as unknown as { onmessage: (event: MessageEvent<unknown>) => void; postMessage: (value: unknown) => void; close: () => void };
const engine = new VaultWorkerEngine();
scope.onmessage = event => {
  void engine.handle(event.data).then(
    reply => scope.postMessage(reply),
    () => {
      engine.close();
      // A malformed inbound protocol must also clear the parent's rendered view
      // immediately; its strict channel treats this as a fatal protocol error.
      scope.postMessage(null);
      scope.close();
    },
  );
};
