import { describe, expect, it, vi } from 'vitest';
import { VaultSessionLifecycle } from './lifecycle';

const identity = { ownerId: 'owner', sessionId: 'session', epoch: '1', valid: true };

describe('memory-only financial session lifecycle', () => {
  it('enforces inactivity at disclosure even when timers were throttled', () => {
    let now = 100;
    const clear = vi.fn();
    const life = new VaultSessionLifecycle(() => now, clear);
    const generation = life.begin(identity);
    expect(life.activate(generation)).toBe(true);
    now += 299_999;
    expect(life.canDisplay()).toBe(true);
    now++;
    expect(life.canDisplay()).toBe(false);
    expect(life.accepts(generation)).toBe(false);
    expect(clear).toHaveBeenLastCalledWith('expired');
  });

  it('only extends an engaged, visible, verified identity on activity', () => {
    let now = 0;
    const life = new VaultSessionLifecycle(() => now);
    const generation = life.begin(identity);
    life.activate(generation);
    now = 200_000;
    life.noteActivity();
    now = 400_000;
    expect(life.canDisplay()).toBe(true);
    life.setHidden(true);
    now = 450_000;
    life.noteActivity();
    life.setHidden(false);
    expect(life.canDisplay()).toBe(false);
    life.noteActivity();
    expect(life.validate(identity)).toBe(true);
    expect(life.canDisplay()).toBe(true);
    now = 500_000;
    expect(life.canDisplay()).toBe(false);
  });

  it('hides immediately, requires fresh identity on return, and terminates after sixty seconds hidden', () => {
    let now = 100;
    const life = new VaultSessionLifecycle(() => now);
    const generation = life.begin(identity);
    life.activate(generation);
    life.setHidden(true);
    expect(life.canDisplay()).toBe(false);
    now += 59_999;
    expect(life.accepts(generation)).toBe(true);
    life.setHidden(false);
    expect(life.canDisplay()).toBe(false);
    expect(life.validate(identity)).toBe(true);
    expect(life.canDisplay()).toBe(true);
    life.setHidden(true);
    now += 60_000;
    expect(life.canReceive(generation)).toBe(false);
    expect(life.currentGeneration()).toBeGreaterThan(generation);
  });

  it.each(['ownerId', 'sessionId', 'epoch'] as const)('locks when trusted %s changes', field => {
    const life = new VaultSessionLifecycle(() => 0);
    const generation = life.begin(identity);
    life.activate(generation);
    expect(life.validate({ ...identity, [field]: '2' })).toBe(false);
    expect(life.canDisplay()).toBe(false);
    expect(life.accepts(generation)).toBe(false);
  });

  it.each(['logout', 'navigation', 'pagehide', 'abort'] as const)('invalidates generation for %s', reason => {
    const life = new VaultSessionLifecycle(() => 0);
    const generation = life.begin(identity);
    life.activate(generation);
    life.lock(reason);
    expect(life.activate(generation)).toBe(false);
    expect(life.canDisplay()).toBe(false);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('fails closed on invalid clock %s', clock => {
    let now = 100;
    const life = new VaultSessionLifecycle(() => now);
    const generation = life.begin(identity);
    life.activate(generation);
    now = clock;
    expect(life.canDisplay()).toBe(false);
    now = 101;
    expect(life.activate(generation)).toBe(false);
  });
});
