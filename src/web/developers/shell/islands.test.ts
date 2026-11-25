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

describe('the account and sandbox slots', () => {
  it('are marked ready once their island ran, whatever happened, and without an observer', async () => {
    const { ISLANDS } = await import('./islands.ts');
    const original = { ...ISLANDS };
    ISLANDS.account = async () => ({
      mount: () => {
        throw new Error('boom');
      },
    });
    ISLANDS.workbench = async () => ({ mount: () => {} });
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
      '<span data-island="account" id="a"></span><div data-island="workbench" id="w"></div>';
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
