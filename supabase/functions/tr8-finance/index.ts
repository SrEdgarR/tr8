import { createFinanceHandler } from './handler.ts';
import { createFinanceRuntime } from './runtime.ts';

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };

Deno.serve(request => createFinanceHandler(createFinanceRuntime(name => Deno.env.get(name)))(request));
