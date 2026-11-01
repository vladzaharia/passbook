import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ART, ART_NAMES, EntityArt, WalletArt, type WalletState } from './index.ts';

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
    expect(ssr).toMatch(/\[base, records, details, wallet\]/);
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

  it('fits the 8 kB gzip budget', () => {
    // css.ts is SSR glue: the browser bundle never loads it.
    const files = readdirSync(DIR)
      .filter((f) => !f.includes('.test.') && f !== 'css.ts')
      .sort();
    const all = files.map((f) => readFileSync(join(DIR, f), 'utf8')).join('\n');
    expect(gzipSync(all, { level: 9 }).length).toBeLessThanOrEqual(8 * 1024);
  });
});
