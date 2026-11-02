import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { Buddy } from './buddy.tsx';
import { Cameo } from './cameo.tsx';
import { BuddyFace } from './face.tsx';
import { WalletArt } from './wallet.tsx';

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
          <Cameo scene="peek">
            <WalletArt state="lost" mood="curious" size="sm" />
          </Cameo>
        </a>
      </div>,
    );
    const targets = [
      painted(container.querySelector('[data-buddy]') as Element),
      container.querySelector('svg.wl-face') as Element,
      painted(container.querySelector('[data-scene="peek"]') as Element),
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
        <Cameo scene="wave">
          <WalletArt state="login" mood="happy" size="sm" />
        </Cameo>
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

  it('never loop and settle within 9 s of starting', () => {
    for (const [f, text] of all) {
      expect(text, f).not.toMatch(/\binfinite\b/);
      for (const m of text.matchAll(/animation:\s*([^;]+);/g)) {
        for (const item of (m[1] ?? '').split(/,(?![^(]*\))/)) {
          const times = [...item.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)].map(
            ([, n, unit]) => Number(n) * (unit === 's' ? 1000 : 1),
          );
          const count = Number(item.trim().match(/\s(\d+)$/)?.[1] ?? 1);
          const [duration = 0, delay = 0] = times;
          expect(delay + duration * count, `${f}: ${item.trim()}`).toBeLessThanOrEqual(8000);
        }
      }
    }
  });

  it('end the search walk where it began: seated at the centre, the "?" gone', () => {
    const text = css('search.css') + css('search-beats.css');
    const last = (name: string) => {
      const body = blocks(text).find(([sel]) => sel === `@keyframes ${name}`)?.[1] ?? '';
      return blocks(body).at(-1) ?? ['', ''];
    };
    expect(last('wl-s-search-go')).toEqual([
      '90%,\n  100%',
      expect.stringMatching(/transform: none/),
    ]);
    expect(last('wl-s-search-body')[1]).toMatch(/translate: 0 0;\s*scale: 1;\s*rotate: 0deg/);
    expect(last('wl-s-search-look')[1]).toMatch(/translate: 0 0/);
    expect(last('wl-s-search-ask')[1]).toMatch(/opacity: 0/);
    expect(last('wl-s-search-shadow')[1]).toMatch(/scale: 1/);
  });
});
