import { VaultSessionController, type VaultControllerOptions } from './controller';

export interface FinancialVaultControllerOptions extends VaultControllerOptions {
  readOpaque: NonNullable<VaultControllerOptions['readOpaque']>;
}

/** Financial runtime always installs domain validation inside its dedicated Worker. */
export class FinancialVaultSessionController extends VaultSessionController {
  constructor(options: FinancialVaultControllerOptions) {
    super({
      ...options,
      // An override is a trusted test seam, never a user-selectable profile.
      makeWorker: options.makeWorker ?? (() => new Worker(new URL('../worker/financial.worker.ts', import.meta.url), { type: 'module' })),
    });
  }
}
