import { createFinanceHandler } from '../tr8-finance/handler.ts';
import { createCoordinatedRuntime } from '../tr8-finance/coordinator.ts';
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };
Deno.serve(request => {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace('/tr8-finance-restore-test', '/tr8-finance');
  return createFinanceHandler(createCoordinatedRuntime(key => Deno.env.get(key)))(new Request(url, request));
});
