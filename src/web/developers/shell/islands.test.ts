import { describe, expect, it, vi } from 'vitest';
import { ZOD_CONFIG_KEY } from '../playground/jitless.ts';
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

describe('the signed-out markup of the quickstart and console', () => {
  it('is held until the island has mounted, then shown whatever happened', async () => {
    const { ISLANDS } = await import('./islands.ts');
    const original = { ...ISLANDS };
    let release: () => void = () => {};
    ISLANDS.quickstart = async () => ({
      mount: () =>
        new Promise<void>((done) => {
          release = done;
        }),
    });
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
    vi.stubGlobal('IntersectionObserver', Seen);
    document.body.innerHTML =
      '<div data-island="quickstart" id="q"></div><div data-island="run" data-mode="console" id="r"></div><div data-island="run" id="o"></div>';
    mountIslands();
    const q = document.getElementById('q') as HTMLElement;
    expect(q.hasAttribute('data-hydrating')).toBe(true);
    expect(document.getElementById('r')?.hasAttribute('data-hydrating')).toBe(true);
    expect(document.getElementById('o')?.hasAttribute('data-hydrating')).toBe(false);
    await vi.waitFor(() => expect(release).not.toBe(undefined));
    release();
    await vi.waitFor(() => expect(q.hasAttribute('data-hydrating')).toBe(false));
    Object.assign(ISLANDS, original);
    vi.unstubAllGlobals();
  });
});
