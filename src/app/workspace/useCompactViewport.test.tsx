import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useCompactViewport from './useCompactViewport';

afterEach(() => vi.unstubAllGlobals());

function viewport(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const media = {
    get matches() {
      return matches;
    },
    addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
  };
  return {
    media,
    change(value: boolean) {
      matches = value;
      act(() => listeners.forEach(listener => listener()));
    },
  };
}

describe('presentation breakpoint', () => {
  it('updates on viewport changes and releases its listener when the view closes', () => {
    const source = viewport(true);
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(source.media));
    const result = renderHook(() => useCompactViewport());
    expect(result.result.current).toBe(true);
    source.change(false);
    expect(result.result.current).toBe(false);
    result.unmount();
    expect(source.media.removeEventListener).toHaveBeenCalledWith('change', source.media.addEventListener.mock.calls[0][1]);
  });

  it('supports a separate navigation breakpoint without retaining the old subscription', () => {
    const phone = viewport(false),
      navigation = viewport(true);
    const match = vi.fn((query: string) => (query.includes('900') ? navigation.media : phone.media));
    vi.stubGlobal('matchMedia', match);
    const result = renderHook(({ query }) => useCompactViewport(query), { initialProps: { query: '(max-width: 700px)' } });
    expect(result.result.current).toBe(false);
    result.rerender({ query: '(max-width: 900px)' });
    expect(result.result.current).toBe(true);
    expect(phone.media.removeEventListener).toHaveBeenCalledOnce();
    phone.change(true);
    navigation.change(false);
    expect(result.result.current).toBe(false);
  });

  it('uses the desktop presentation when no media-query API is available', () => {
    vi.stubGlobal('matchMedia', undefined);
    const result = renderHook(() => useCompactViewport());
    expect(result.result.current).toBe(false);
  });
});
