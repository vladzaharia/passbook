import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { Buddy } from './buddy.tsx';
import { BuddyFace } from './face.tsx';
import { ART_NAMES, EntityArt, preloadArt, WalletArt, type WalletState } from './index.ts';
import { ART } from './registry.ts';
import type { WalletMood } from './wallet.tsx';

const DIR = join(process.cwd(), 'src/web/ui/art');
const css = ['art.css', 'art-records.css', 'art-details.css', 'art-wallet.css']
  .map((f) => readFileSync(join(DIR, f), 'utf8'))
  .join('\n');
const STATES: WalletState[] = [
  'login',
  'empty',
  'lost',
  'confirm',
  'expired',
  'no-access',
  'break-glass',
];
const MOODS: WalletMood[] = ['happy', 'flat', 'sad', 'curious'];

/** Top-level blocks of a stylesheet: [prelude, body] with nesting resolved by brace depth. */
function blocks(source: string): [string, string][] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: [string, string][] = [];
  let depth = 0;
  let start = 0;
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        out.push([text.slice(start, open).trim(), text.slice(open + 1, i)]);
        start = i + 1;
      }
    }
  }
  return out;
}

const decls = (body: string) =>
  Object.fromEntries(
    body
      .split(';')
      .map((d) => d.split(/:(.*)/s).map((s) => s.trim()))
      .filter(([k, v]) => k && v),
  ) as Record<string, string>;

const RULES = blocks(css)
  .filter(([sel]) => !sel.startsWith('@'))
  .map(([sel, body]) => ({ sel, d: decls(body) }));

/** The last rule (source order) that sets `prop` on the element, like the cascade for our rules. */
function varOf(el: Element, prop: string): string | undefined {
  let value: string | undefined;
  for (const rule of RULES) if (prop in rule.d && el.matches(rule.sel)) value = rule.d[prop];
  return value === 'initial' ? undefined : value;
}

/** Milliseconds of a time value; calc(a + var(--i, 0) * b) is evaluated with the element's --i. */
function ms(el: Element, value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const i = Number(varOf(el, '--i') ?? 0);
  const expr = value
    .replace(/var\(--i, 0\)/g, String(i))
    .replace(/calc\(|\)/g, '')
    .replace(/(\d+(?:\.\d+)?)ms/g, '$1')
    .replace(/(\d+(?:\.\d+)?)s\b/g, (_, n) => String(Number(n) * 1000));
  // Sums of products only: "100 + 2 * 70".
  return expr
    .split('+')
    .reduce((sum, term) => sum + term.split('*').reduce((p, f) => p * Number(f.trim()), 1), 0);
}

describe('entity art', () => {
  beforeAll(async () => {
    await preloadArt();
  });

  it('lists every registered art by name, in order', () => {
    expect(Object.keys(ART)).toEqual([...ART_NAMES]);
  });

  it.each(ART_NAMES)('%s renders at lg and sm within the SVG rules', (name) => {
    for (const size of ['lg', 'sm'] as const) {
      const { container, unmount } = render(<EntityArt name={name} size={size} />);
      const svg = container.querySelector('svg.wl-art');
      expect(svg).not.toBeNull();
      expect(svg).toHaveAttribute('data-art', name);
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(svg).toHaveAttribute('focusable', 'false');
      expect(svg).toHaveAttribute('viewBox', '0 0 96 72');
      expect(svg).toHaveAttribute('width', size === 'lg' ? '96' : '64');
      expect(svg?.querySelectorAll('*').length).toBeLessThanOrEqual(39);
      expect(svg?.querySelector('text')).toBeNull();
      // Exactly one accent (or, for the error art, one danger) part.
      expect(svg?.querySelectorAll('.a, .x')).toHaveLength(1);
      unmount();
    }
  });

  it('gives every art its own name', () => {
    expect(new Set(Object.values(ART)).size).toBe(ART_NAMES.length);
    const names = ART_NAMES.map((name) => {
      const { container, unmount } = render(<EntityArt name={name} />);
      const value = container.querySelector('svg')?.getAttribute('data-art');
      unmount();
      return value;
    });
    expect(new Set(names).size).toBe(ART_NAMES.length);
  });

  it('renders every wallet state as static markup without inline styles', () => {
    for (const state of STATES) {
      const html = renderToStaticMarkup(<WalletArt state={state} />);
      expect(html).toContain(`data-state="${state}"`);
      expect(html).not.toContain('style=');
      const doc = new DOMParser().parseFromString(html, 'image/svg+xml');
      expect(doc.querySelectorAll('*').length).toBeLessThanOrEqual(40);
    }
    // SSR pages inline ART_CSS (css.ts): every art stylesheet, the engine first.
    const ssr = readFileSync(join(DIR, 'css.ts'), 'utf8');
    const sheets = readdirSync(DIR).filter((f) => f.endsWith('.css'));
    for (const f of sheets) expect(ssr).toContain(`./${f}?raw`);
    expect(ssr).toMatch(/\[base, records, details, wallet, rest, hello\]/);
  });

  it('draws each mood on the face and seats the wallet on a surface', () => {
    for (const mood of MOODS) {
      const { container, unmount } = render(<WalletArt state="login" mood={mood} seat />);
      const w = container.querySelector('[data-part="w"]');
      expect(w).toHaveAttribute('data-mood', mood);
      expect(w).toHaveAttribute('data-seat');
      expect(container.querySelectorAll('[data-part="l1"], [data-part="l2"]')).toHaveLength(2);
      expect(container.querySelector('[data-part="sd"]')).not.toBeNull();
      expect(container.querySelector('[data-look] [data-part="joy"]') !== null).toBe(
        mood === 'happy',
      );
      const brows = mood === 'sad' || mood === 'curious';
      expect(container.querySelector('[data-look] [data-part="br"]') !== null).toBe(brows);
      expect(container.querySelectorAll('*').length).toBeLessThanOrEqual(40);
      unmount();
    }
    const mouth = (mood?: WalletMood) =>
      new DOMParser()
        .parseFromString(renderToStaticMarkup(<WalletArt mood={mood} />), 'image/svg+xml')
        .querySelector('[data-trunk] > path.m')
        ?.getAttribute('d');
    expect(new Set([undefined, ...MOODS].map(mouth)).size).toBe(4);
    expect(mouth('happy')).toBe(mouth());
    const plain = render(<WalletArt state="login" />).container;
    expect(plain.querySelector('[data-seat], [data-part="sd"], [data-part="l1"]')).toBeNull();
  });

  it('seats the buddy with its prop, decorative and still on request', () => {
    const { container } = render(
      <Buddy mood="sad" prop={<EntityArt name="unplugged" size="sm" />} still />,
    );
    const buddy = container.querySelector('.wl-buddy');
    expect(buddy).toHaveAttribute('aria-hidden', 'true');
    expect(buddy).toHaveAttribute('data-prop');
    expect(buddy?.querySelector('[data-art="wallet"]')).toHaveAttribute('data-still');
    expect(buddy?.querySelector('[data-part="w"]')).toHaveAttribute('data-seat');
    expect(buddy?.querySelector('.wl-buddy-prop [data-art="unplugged"]')).not.toBeNull();
    // The perch and the one-beat moods live in the kit CSS.
    expect(css).toMatch(/\.wl-buddy \{[^}]*translate: -50% -91\.67%/);
    expect(css).toMatch(/\.wl-art\[data-still\] :is\(\[data-body\], \[data-fan\]\)/);
  });

  it('draws the face as a decorative icon that winks once', () => {
    const { container } = render(<BuddyFace className="size-4" />);
    const svg = container.querySelector('svg.wl-face');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(svg).toHaveClass('size-4');
    expect(svg?.querySelectorAll('[data-eye]')).toHaveLength(2);
    expect(svg?.querySelectorAll('[data-wink]')).toHaveLength(1);
    expect(svg?.querySelector('text')).toBeNull();
    // One wink, never a loop; the media test below keeps it under no-preference.
    expect(css).toMatch(/\.wl-face \[data-wink\] \{\s*animation: wl-wink 200ms/);
    expect(css).not.toMatch(/wl-wink[^;]*infinite/);
  });

  it('turns the buddy toward an action under the pointer or focus', () => {
    expect(css).toMatch(
      /\[data-art-host\]:has\(:is\(a, button\):is\(:hover, :focus-visible\)\) \.wl-buddy \[data-look\]/,
    );
  });

  it('animates only transform and opacity', () => {
    const keyframes = blocks(css).filter(([sel]) => sel.startsWith('@keyframes'));
    expect(keyframes.length).toBeGreaterThan(3);
    for (const [, body] of keyframes) {
      for (const [, frame] of blocks(body)) {
        for (const prop of Object.keys(decls(frame)))
          expect(['opacity', 'transform']).toContain(prop);
      }
    }
  });

  it('moves only under prefers-reduced-motion: no-preference', () => {
    for (const [sel, body] of blocks(css)) {
      if (sel.startsWith('@keyframes')) continue;
      const moving = /(^|[\s;{])(animation|transition)(-[a-z]+)?\s*:/.test(body);
      if (moving) expect(sel).toBe('@media (prefers-reduced-motion: no-preference)');
    }
  });

  it('keeps each part under 480 ms, the art under 600 ms and the beat under 400 ms', () => {
    const renders = [
      ...ART_NAMES.map((name) => <EntityArt key={name} name={name} />),
      ...STATES.map((state) => <WalletArt key={state} state={state} />),
      ...MOODS.map((mood) => <WalletArt key={mood} state="login" mood={mood} seat />),
    ];
    let longest = 0;
    for (const node of renders) {
      const { container, unmount } = render(node);
      for (const part of container.querySelectorAll('[data-part]')) {
        const u = ms(part, varOf(part, '--u'), 360);
        const d = ms(part, varOf(part, '--d'), 0);
        expect(u, part.outerHTML).toBeLessThanOrEqual(480);
        expect(d + u, part.outerHTML).toBeLessThanOrEqual(600);
        longest = Math.max(longest, d + u);
        if (part.hasAttribute('data-b')) {
          const beat = ms(part, varOf(part, '--bd'), 0) + ms(part, varOf(part, '--bu'), 400);
          expect(beat, part.outerHTML).toBeLessThanOrEqual(400);
        }
      }
      unmount();
    }
    // The parser read real values (the longest entrances end at 600 ms).
    expect(longest).toBe(600);
  });

  // Raised for the buddy (moods, seat, composition) and the lazy registry's name list. The art
  // left the initial chunk (registry.ts), so the initial budget fell; the rest is CSS. Then by
  // 0.5 kB for the face (toasts, status) and the buddy's glance at an action; then by 2 kB for
  // click-to-replay (replay.ts, cameo.tsx) and the scenes' rest sheet (scenes/rest.css). The lazy
  // scenes rose by 1 kB for the search walk's planted steps (scenes/search-steps.css).
  it('fits the 13.5 kB gzip budget; the lazy scenes fit 8 kB', () => {
    // css.ts is SSR glue: the browser bundle never loads it.
    const files = readdirSync(DIR)
      .filter((f) => !f.includes('.test.') && f !== 'css.ts' && f.includes('.'))
      .sort()
      .map((f) => join(DIR, f));
    const kit = [...files, join(DIR, 'scenes/rest.css')];
    const gz = (paths: string[]) =>
      gzipSync(paths.map((f) => readFileSync(f, 'utf8')).join('\n'), { level: 9 }).length;
    expect(gz(kit)).toBeLessThanOrEqual(13.5 * 1024);
    // The scenes ride in the registry chunk (registry.ts imports each one).
    const scenes = readdirSync(join(DIR, 'scenes')).filter((f) => f !== 'rest.css');
    const registry = readFileSync(join(DIR, 'registry.ts'), 'utf8');
    for (const f of scenes) expect(registry).toContain(`import './scenes/${f}';`);
    expect(gz(scenes.map((f) => join(DIR, 'scenes', f)))).toBeLessThanOrEqual(8 * 1024);
  });
});
