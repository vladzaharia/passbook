import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { Buddy } from './buddy.tsx';
import { BuddyFace } from './face.tsx';

const SCENES = join(process.cwd(), 'src/web/ui/art/scenes');
const sheets = readdirSync(SCENES).filter((f) => f.endsWith('.css'));
const css = (f: string) => readFileSync(join(SCENES, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level blocks: [prelude, body]. */
function blocks(text: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let start = 0;
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (text[i] === '}' && --depth === 0) {
      out.push([text.slice(start, open).trim(), text.slice(open + 1, i)]);
      start = i + 1;
    }
  }
  return out;
}

function reduce(on: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (q: string) => ({ matches: on && q.includes('reduce'), media: q }) as MediaQueryList,
  );
}

/** A fake IntersectionObserver whose callback the test fires. */
function observer() {
  const seen: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        seen.push(cb);
      }
      observe() {}
      disconnect() {}
    },
  );
  return (visible: boolean) => {
    for (const cb of seen) cb([{ isIntersecting: visible }]);
  };
}

const painted = (root: Element) => root.querySelector('[data-part="w"] rect.o') as Element;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('buddy scenes', () => {
  it('replays on a click: off, a style flush, on again, even mid-scene', () => {
    reduce(false);
    const { container } = render(<Buddy mood="curious" scene="inspect" />);
    const host = container.querySelector('[data-buddy]') as HTMLElement;
    fireEvent.click(painted(host));
    expect(host).toHaveAttribute('data-run');
    const order: string[] = [];
    const remove = vi.spyOn(host, 'removeAttribute').mockImplementation(function (
      this: Element,
      n,
    ) {
      order.push(`-${n}`);
      Element.prototype.removeAttribute.call(this, n);
    });
    const flush = vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => {
      order.push('flush');
      return new DOMRect();
    });
    fireEvent.click(painted(host));
    expect(order).toEqual(['-data-run', 'flush']);
    expect(host).toHaveAttribute('data-run');
    remove.mockRestore();
    flush.mockRestore();
  });

  it('does nothing on a click under reduced motion, and never starts on its own', () => {
    reduce(true);
    vi.useFakeTimers();
    const show = observer();
    const { container } = render(<Buddy mood="sad" scene="plug" />);
    const host = container.querySelector('[data-buddy]') as HTMLElement;
    act(() => show(true));
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.click(painted(host));
    expect(host).not.toHaveAttribute('data-run');
  });

  it('starts once in view, after the art has landed; still art waits for a click', () => {
    reduce(false);
    vi.useFakeTimers();
    const show = observer();
    const { container } = render(
      <>
        <Buddy mood="curious" state="empty" scene="search" />
        <Buddy mood="curious" scene="inspect" still />
      </>,
    );
    const [walk, still] = [...container.querySelectorAll('[data-buddy]')];
    act(() => show(false));
    act(() => vi.advanceTimersByTime(2000));
    expect(walk).not.toHaveAttribute('data-run');
    act(() => show(true));
    act(() => vi.advanceTimersByTime(600));
    expect(walk).toHaveAttribute('data-run');
    expect(still).not.toHaveAttribute('data-run');
  });

  it('replays when its host asks (Retry sends it back to the plug)', () => {
    reduce(false);
    const { container, rerender } = render(<Buddy mood="sad" scene="plug" replay={0} />);
    const host = container.querySelector('[data-buddy]') as HTMLElement;
    expect(host).not.toHaveAttribute('data-run');
    rerender(<Buddy mood="sad" scene="plug" replay={1} />);
    expect(host).toHaveAttribute('data-run');
  });

  it('keeps a click to itself: no parent link, row or card action sees it', () => {
    reduce(false);
    const parent = vi.fn();
    const { container } = render(
      // biome-ignore lint/a11y/useKeyWithClickEvents: a stand-in for a clickable card or row
      // biome-ignore lint/a11y/noStaticElementInteractions: a stand-in for a clickable card or row
      <div onClick={parent}>
        <a href="#next">
          <Buddy mood="curious" scene="inspect" />
          <BuddyFace className="size-4" />
        </a>
      </div>,
    );
    const targets = [
      painted(container.querySelector('[data-buddy]') as Element),
      container.querySelector('svg.wl-face') as Element,
    ];
    for (const target of targets) {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      target.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
    }
    expect(parent).not.toHaveBeenCalled();
    expect(window.location.hash).not.toBe('#next');
  });

  it('stays decorative: hidden from assistive tech and out of the tab order', async () => {
    const { container } = render(
      <main>
        <Buddy mood="curious" state="empty" scene="search" />
        <BuddyFace scene="cheer" />
        <Buddy mood="happy" size="sm" at="end" scene="wave" />
      </main>,
    );
    const hosts = container.querySelectorAll('[data-replay]');
    expect(hosts).toHaveLength(3);
    for (const host of hosts) {
      expect(host).toHaveAttribute('aria-hidden', 'true');
      expect(host).not.toHaveAttribute('tabindex');
      expect(host.closest('[aria-hidden="true"]')).toBe(host);
    }
    for (const svg of container.querySelectorAll('svg'))
      expect(svg).toHaveAttribute('focusable', 'false');
    // The search scene's "?" is drawn, never written.
    expect(container.querySelector('[data-q]')?.tagName).toBe('path');
    expect(container.textContent).toBe('');
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('scene stylesheets', () => {
  const all = sheets.map((f) => [f, css(f)] as const);

  it('animate transforms and opacity only', () => {
    for (const [f, text] of all) {
      for (const [sel, body] of blocks(text)) {
        if (!sel.startsWith('@keyframes')) continue;
        for (const [, frame] of blocks(body)) {
          for (const decl of frame.split(';')) {
            const prop = decl.split(':')[0]?.trim();
            if (!prop || prop === 'animation-timing-function') continue;
            expect(
              ['opacity', 'transform', 'translate', 'rotate', 'scale'],
              `${f} ${sel}`,
            ).toContain(prop);
          }
        }
      }
    }
  });

  it('move only under prefers-reduced-motion: no-preference', () => {
    for (const [f, text] of all) {
      for (const [sel, body] of blocks(text)) {
        if (sel.startsWith('@keyframes')) continue;
        if (/(^|[\s;{])(animation|transition)(-[a-z]+)?\s*:/.test(body))
          expect(sel, f).toMatch(/^@media \(prefers-reduced-motion: no-preference\)( and |$)/);
      }
    }
  });

  // Scenes start once the art has landed (700 ms); nothing moves on its own past 5 s (WCAG 2.2.2).
  it('never loop and settle within 5 s of the page', () => {
    for (const [f, text] of all) {
      expect(text, f).not.toMatch(/\binfinite\b/);
      for (const m of text.matchAll(/animation:\s*([^;]+);/g)) {
        for (const item of (m[1] ?? '').split(/,(?![^(]*\))/)) {
          const times = [...item.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)].map(
            ([, n, unit]) => Number(n) * (unit === 's' ? 1000 : 1),
          );
          const count = Number(item.trim().match(/\s(\d+(?:\.\d+)?)$/)?.[1] ?? 1);
          const [duration = 0, delay = 0] = times;
          expect(700 + delay + duration * count, `${f}: ${item.trim()}`).toBeLessThanOrEqual(5000);
        }
      }
    }
  });

  it('end the search walk where it began: seated at the centre, the "?" gone', () => {
    const last = (name: string) => blocks(keyframes(name)).at(-1) ?? ['', ''];
    expect(last('wl-s-search-go')).toEqual([
      '87.5%,\n  100%',
      expect.stringMatching(/transform: none/),
    ]);
    expect(last('wl-s-search-body')[1]).toMatch(/translate: 0 0;\s*scale: 1/);
    expect(last('wl-s-search-trunk')[1]).toMatch(/translate: 0 0;\s*rotate: 0deg;\s*scale: 1/);
    for (const leg of ['l1', 'l2'])
      expect(last(`wl-s-search-${leg}-hop`)[1]).toMatch(/translate: 0 0;\s*rotate: 0deg/);
    expect(last('wl-s-search-look')[1]).toMatch(/translate: 0 0/);
    expect(last('wl-s-search-ask')[1]).toMatch(/opacity: 0/);
    expect(last('wl-s-search-shadow')[1]).toMatch(/scale: 1/);
  });

  // The owner asked for 300-400 px of walking in all (out, across, back: four reaches).
  it('cap the search walk in px, and narrow it in a narrow box', () => {
    const terms =
      css('search.css')
        .match(/--wl-reach:\s*min\(([^;]+)\);/)?.[1]
        ?.split(',') ?? [];
    const reach = (contentWidth: number) =>
      Math.min(
        ...terms.map((term) =>
          [...term.matchAll(/([+-]?)\s*(\d+(?:\.\d+)?)(cqw|px)/g)].reduce(
            (sum, [, sign, n, unit]) =>
              sum + (sign === '-' ? -1 : 1) * Number(n) * (unit === 'cqw' ? contentWidth / 100 : 1),
            0,
          ),
        ),
      );
    expect(terms.length).toBeGreaterThan(1);
    for (const wide of [942, 1400, 4000]) {
      expect(4 * reach(wide)).toBeGreaterThanOrEqual(300);
      expect(4 * reach(wide)).toBeLessThanOrEqual(400);
    }
    // A phone's box (390 px viewport): a shorter walk that keeps the buddy inside the box.
    expect(reach(308)).toBeLessThan(reach(942));
    expect(reach(308) + 48).toBeLessThan(308 / 2);
  });

  // A foot in stance moves against the travel between the same two keyframes with the same easing,
  // so it stays put on the edge while the body passes over it.
  it('plant the feet of the search walk', () => {
    const at = (decl: string, prop: string) => decl.match(new RegExp(`${prop}: ([^;]+);`))?.[1];
    const reachOf = (v = '') => Number(v.match(/var\(--wl-reach\) \* (-?[\d.]+)/)?.[1] ?? 0);
    const go = blocks(keyframes('wl-s-search-go')).flatMap(([sel, decl]) =>
      sel.split(',').map((p) => ({
        ms: Number.parseFloat(p) * 40,
        r: reachOf(at(decl, 'transform')),
        fn: at(decl, 'animation-timing-function') ?? 'linear',
      })),
    );
    const rule = css('search.css').match(/\[data-part="l1"\] \{\s*animation:([^;]+);/)?.[1] ?? '';
    let stances = 0;
    for (const item of rule.split(',').filter((x) => !x.includes('-hop'))) {
      const [name = '', dur = '', , delay = ''] = item.trim().split(/\s+/);
      for (const leg of [
        name,
        name.replace(/lead|trail/, (m) => (m === 'lead' ? 'trail' : 'lead')),
      ]) {
        const frames = blocks(keyframes(leg)).map(([sel, decl]) => {
          const [x = '', y = ''] = (at(decl, 'translate') ?? '').split(/ (?![^(]*\))/);
          return {
            ms: Number.parseFloat(delay) + (Number.parseFloat(sel) / 100) * Number.parseFloat(dur),
            r: reachOf(x),
            px: Number(x.match(/(-?[\d.]+)px\)?$/)?.[1] ?? 0) * (/ - [\d.]+px\)$/.test(x) ? -1 : 1),
            y,
            fn: at(decl, 'animation-timing-function') ?? 'linear',
          };
        });
        for (let i = 1; i < frames.length; i++) {
          const [a, b] = [frames[i - 1], frames[i]];
          // On the ground at both ends and moving against the body: a stance.
          if (a?.y !== '0' || b?.y !== '0' || a.r === b.r) continue;
          const g = go.findIndex((k) => Math.abs(k.ms - a.ms) < 0.1);
          const h = go[g + 1];
          expect(h && Math.abs(h.ms - b.ms) < 0.1, `${leg} at ${a.ms} ms`).toBe(true);
          expect(b.r - a.r).toBeCloseTo(-((h?.r ?? 0) - (go[g]?.r ?? 0)), 6);
          expect([b.px, a.fn]).toEqual([a.px, go[g]?.fn]);
          stances++;
        }
      }
    }
    expect(stances).toBe(11);
  });
});

const keyframes = (name: string) =>
  blocks(['search.css', 'search-beats.css', 'search-steps.css'].map(css).join('\n')).find(
    ([sel]) => sel === `@keyframes ${name}`,
  )?.[1] ?? '';
