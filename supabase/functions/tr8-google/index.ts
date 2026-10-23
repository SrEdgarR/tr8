import { createGoogleRuntime, errorReply } from '../_shared/google-runtime.ts';
import { createGoogleUserHandler } from '../_shared/google-service.ts';

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };

Deno.serve(async request => {
  try {
    return await createGoogleUserHandler(createGoogleRuntime(name => Deno.env.get(name)))(request);
  } catch (cause) {
    return errorReply(cause);
  }
});
