import { createPersonalHandler, createPersonalService } from '../tr8-finance/personal-handler.ts';
declare const Deno: { env: { get(key: string): string | undefined }; serve(handler: (r: Request) => Promise<Response>): void };
Deno.serve(createPersonalHandler(createPersonalService(key => Deno.env.get(key))));
