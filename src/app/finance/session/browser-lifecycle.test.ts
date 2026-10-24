import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindVaultBrowserLifecycle } from './browser-lifecycle';
import type { VaultSessionController } from './controller';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function bind() {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const controller = { setHidden: vi.fn(), lock: vi.fn(), noteActivity: vi.fn(), tick: vi.fn() };
  const cleanup = bindVaultBrowserLifecycle(controller as unknown as VaultSessionController);
  return { controller, cleanup, hidden };
}

describe('browser lifecycle binding', () => {
  it('locks both pagehide and BFCache pageshow instead of restoring an unlocked view', () => {
    const h = bind();
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(h.controller.lock.mock.calls).toEqual([['pagehide'], ['pagehide']]);
    expect(h.controller.setHidden).toHaveBeenLastCalledWith(false);
    h.cleanup();
  });

  it('forwards visibility immediately and polls expiry as a supplemental guard', () => {
    const h = bind();
    expect(h.controller.setHidden).toHaveBeenCalledWith(false);
    h.hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.controller.setHidden).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(3000);
    expect(h.controller.tick).toHaveBeenCalledTimes(3);
    h.cleanup();
  });

  it('ignores untrusted synthetic activity and tears down every listener and timer on navigation', () => {
    const h = bind();
    for (const name of ['pointerdown', 'keydown', 'input']) document.dispatchEvent(new Event(name));
    expect(h.controller.noteActivity).not.toHaveBeenCalled();
    h.cleanup();
    expect(h.controller.lock).toHaveBeenLastCalledWith('navigation');
    expect(vi.getTimerCount()).toBe(0);
    h.controller.lock.mockClear();
    h.controller.setHidden.mockClear();
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(5000);
    expect(h.controller.lock).not.toHaveBeenCalled();
    expect(h.controller.setHidden).not.toHaveBeenCalled();
    expect(h.controller.tick).not.toHaveBeenCalled();
  });
});
