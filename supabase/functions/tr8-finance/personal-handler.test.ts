import { expect, it, vi } from 'vitest';
import { createPersonalHandler, type createPersonalService } from './personal-handler.ts';
const origin = 'https://tr8.vercel.app';
function harness() {
  const actor = { id: '74368b81-39f8-4bc3-bbbf-f541b64df4cf', session: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expiresAt: 9999999999, passwordAt: null };
  const service = {
    enabled: true,
    origin,
    authenticate: vi.fn(async () => actor),
    read: vi.fn(async () => ({ state: {}, envelope: null })),
    sessionIdentity: vi.fn(async () => ({ state: {} })),
    closeSession: vi.fn(async () => ({ closed: true })),
    changeAccountPassword: vi.fn(async () => ({ updated: true })),
    identity: vi.fn(),
    put: vi.fn(),
    resume: vi.fn(),
    repair: vi.fn(),
  };
  return { service, handle: createPersonalHandler(service as unknown as ReturnType<typeof createPersonalService>) };
}
it('keeps operator repair outside the browser API and rejects foreign origins before authentication', async () => {
  const { service, handle } = harness();
  expect((await handle(new Request('https://edge.invalid/tr8-vault/repair', { method: 'POST' }))).status).toBe(405);
  expect(
    (
      await handle(
        new Request('https://edge.invalid/tr8-vault/logout', {
          method: 'POST',
          headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
          body: '{}',
        }),
      )
    ).status,
  ).toBe(403);
  expect(service.authenticate).not.toHaveBeenCalled();
  expect(service.repair).not.toHaveBeenCalled();
});
it('separates session metadata from ciphertext and requires a closed logout body', async () => {
  const { service, handle } = harness();
  const r = await handle(new Request('https://edge.invalid/tr8-vault/session', { headers: { Origin: origin } }));
  expect(await r.json()).toEqual({ state: {} });
  expect(service.read).not.toHaveBeenCalled();
  expect(
    (
      await handle(
        new Request('https://edge.invalid/tr8-vault/logout', {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: '{"ownerId":"other"}',
        }),
      )
    ).status,
  ).toBe(400);
  expect(service.closeSession).not.toHaveBeenCalled();
  const logout = await handle(
    new Request('https://edge.invalid/tr8-vault/logout', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }),
  );
  expect(logout.status).toBe(200);
  expect(service.closeSession).toHaveBeenCalledOnce();
});
