import { describe, expect, it, vi } from 'vitest';
import { BENCH_VT_HEAD, benchVtScript } from './transition.ts';

const ORIGIN = 'https://passbook.mobile';

/** Runs the served script against a fake page and returns what it did to the view transition. */
function reveal(at: string, from: { nav?: string | null; referrer?: string }) {
  let onReveal: ((e: unknown) => void) | undefined;
  const listen = (type: string, fn: (e: unknown) => void) => {
    if (type === 'pagereveal') onReveal = fn;
  };
  const self =
    from.nav === undefined
      ? {}
      : { navigation: { activation: { from: from.nav ? { url: from.nav } : null } } };
  new Function('addEventListener', 'self', 'document', 'location', benchVtScript())(
    listen,
    self,
    { referrer: from.referrer ?? '' },
    new URL(at, ORIGIN),
  );
  const vt = { skipTransition: vi.fn(), types: new Set<string>() };
  onReveal?.({ viewTransition: vt });
  return vt;
}

describe('the tool switch', () => {
  it('runs from one tool to another, typed by tab order', () => {
    const next = reveal('/developers/logs', { nav: `${ORIGIN}/developers/console` });
    expect(next.skipTransition).not.toHaveBeenCalled();
    expect([...next.types]).toEqual(['bench-next']);
    const back = reveal('/developers/webhooks/', { nav: `${ORIGIN}/developers/keys#k1` });
    expect([...back.types]).toEqual(['bench-back']);
  });

  it('reads the referrer where there is no Navigation API', () => {
    const vt = reveal('/developers/keys', { referrer: `${ORIGIN}/developers/logs?status=4xx` });
    expect([...vt.types]).toEqual(['bench-next']);
  });

  it('skips any other navigation: from a docs page, the same tool, or nowhere', () => {
    for (const vt of [
      reveal('/developers/logs', { nav: `${ORIGIN}/developers/guides` }),
      reveal('/developers/logs', { nav: `${ORIGIN}/developers/logs` }),
      reveal('/developers/logs', { nav: null }),
      reveal('/developers/guides', { nav: `${ORIGIN}/developers/logs` }),
    ])
      expect(vt.skipTransition).toHaveBeenCalledOnce();
  });

  it('holds the first paint until the head and the title are parsed', () => {
    expect(BENCH_VT_HEAD).toBe(
      '<script async blocking="render" src="/developers/bench-vt.js"></script><link rel="expect" href="#bench-title" blocking="render">',
    );
  });
});
