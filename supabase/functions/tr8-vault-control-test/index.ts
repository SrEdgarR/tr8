import { createControlHandler, createControlService } from '../tr8-finance/control-handler.ts';
declare const Deno: { env: { get(key: string): string | undefined }; serve(handler: (r: Request) => Promise<Response>): void };
Deno.serve(createControlHandler(createControlService(key => Deno.env.get(key))));
