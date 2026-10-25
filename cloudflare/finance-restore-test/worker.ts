/** Separate synthetic restore cases. Never admits real users or changes the 6B.5B namespace. */
import base, { Tr8SyntheticAuthority } from '../finance-authority-test/worker';
export class Tr8RestoreAuthority extends Tr8SyntheticAuthority {}
export default {
  async fetch(request: Request, env: Parameters<typeof base.fetch>[1]) {
    const url = new URL(request.url);
    const route = /^\/v1\/cases\/(reset|revoke|purge)\/(bootstrap|state|check|prepare|commit)$/.exec(url.pathname);
    if (!route || url.search) return Response.json({ error: { code: 'CONTEXT_DENIED' } }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
    url.pathname = '/v1/' + route[2];
    const response = await base.fetch(new Request(url, request), {
      ...env,
      JOURNAL: { idFromName: name => env.JOURNAL.idFromName(`${name}/${route[1]}`), get: id => env.JOURNAL.get(id) },
    });
    return Response.json({ ...(await response.json()), caseId: route[1] }, { status: response.status, headers: response.headers });
  },
};
