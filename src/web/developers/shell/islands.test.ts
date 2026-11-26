import { describe, expect, it, vi } from 'vitest';
import { ZOD_CONFIG_KEY } from '../model/jitless.ts';
import { mountIslands } from './islands.ts';

describe('mountIslands', () => {
  it('turns zod compiling off before any island chunk can load', () => {
    Reflect.deleteProperty(globalThis, ZOD_CONFIG_KEY);
    mountIslands(document.createElement('div'));
    expect(
      (globalThis as unknown as Record<string, { jitless?: boolean }>)[ZOD_CONFIG_KEY]?.jitless,
    ).toBe(true);
  });
});

describe('the account and sandbox slots', () => {
  it('are marked ready once their island ran, whatever happened, and without an observer', async () => {
    const { ISLANDS } = await import('./islands.ts');
    const original = { ...ISLANDS };
    ISLANDS.account = async () => ({
      mount: () => {
        throw new Error('boom');
      },
    });
    ISLANDS.operations = async () => ({ mount: () => {} });
    class Seen {
      fn: (e: unknown[]) => void;
      constructor(fn: (e: unknown[]) => void) {
        this.fn = fn;
      }
      observe(el: Element) {
        this.fn([{ isIntersecting: true, target: el }]);
      }
      unobserve() {}
    }
    const onError = vi.fn((e: Event) => e.preventDefault());
    window.addEventListener('error', onError);
    vi.stubGlobal('IntersectionObserver', Seen);
    document.body.innerHTML =
      '<span data-island="account" id="a"></span><div data-island="operations" id="w"></div>';
    mountIslands();
    // Held in CSS from the first paint, not by an attribute script sets late.
    await vi.waitFor(() => {
      expect(document.getElementById('a')?.hasAttribute('data-ready')).toBe(true);
      expect(document.getElementById('w')?.hasAttribute('data-ready')).toBe(true);
    });
    expect(document.getElementById('a')?.hasAttribute('data-hydrating')).toBe(false);
    window.removeEventListener('error', onError);
    vi.unstubAllGlobals();
    vi.stubGlobal('IntersectionObserver', undefined);
    Reflect.deleteProperty(window, 'IntersectionObserver');
    document.body.innerHTML = '<span data-island="account" id="b"></span>';
    mountIslands();
    expect(document.getElementById('b')?.hasAttribute('data-ready')).toBe(true);
    vi.unstubAllGlobals();
    Object.assign(ISLANDS, original);
  });
});
