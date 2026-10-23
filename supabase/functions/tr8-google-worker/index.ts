import { createGoogleRuntime, errorReply } from '../_shared/google-runtime.ts';
import { createGoogleWorkerHandler } from '../_shared/google-worker.ts';

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };

Deno.serve(async request => {
  try {
    return await createGoogleWorkerHandler(createGoogleRuntime(name => Deno.env.get(name)))(request);
  } catch (cause) {
    return errorReply(cause);
  }
});
