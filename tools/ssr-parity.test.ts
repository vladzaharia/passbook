// The SSR pages and emails share the SPA's sources (tools/build-ssr-tokens.ts, build-ssr-kit.ts).
// These read the files: generated outputs are current and every colour matches the SPA per theme.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMAIL_TOKENS, THEME_COLOR } from '../src/generated/resolved-tokens.ts';
import { type Env, parseCss, resolveTheme } from './lib/css-tokens.ts';
import { CONTROL_SOURCES, sourceHash, TILT_SOURCE } from './lib/ssr-kit.ts';
import {
  FONT_SOURCE,
  fontSheet,
  readSources,
  resolvedTokensTs,
  ssrTokensCss,
  TOKEN_SOURCES,
} from './lib/ssr-tokens.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const sources = readSources(root);
const generated = read('src/generated/ssr-tokens.css');

/** The SPA's own cascade: every rule of the sheets app.css imports, unpruned. */
const spaRules = TOKEN_SOURCES.flatMap((p) => parseCss(read(p)));
const ssrRules = parseCss(generated);

const ENVS: [string, Env][] = [
  ['system light', { system: 'light' }],
  ['system dark', { system: 'dark' }],
  ['chosen light on a dark OS', { system: 'dark', attr: 'light' }],
  ['chosen dark on a light OS', { system: 'light', attr: 'dark' }],
];

describe('generated SSR tokens', () => {
  it('are current: `npm run gen` writes exactly the committed files', () => {
    expect(generated).toBe(ssrTokensCss(sources));
    expect(read('src/generated/resolved-tokens.ts')).toBe(resolvedTokensTs(sources));
  });

  it.each(ENVS)('match every SPA token value for %s', (_, env) => {
    const spa = resolveTheme(spaRules, env);
    const ssr = resolveTheme(ssrRules, env);
    expect(ssr.size).toBeGreaterThan(150);
    for (const [name, value] of ssr) expect([name, value]).toEqual([name, spa.get(name)]);
  });

  it('resolve a chosen theme to the same values as the OS one', () => {
    const at = (env: Env) => Object.fromEntries(resolveTheme(ssrRules, env));
    expect(at({ system: 'dark', attr: 'light' })).toEqual(at({ system: 'light' }));
    expect(at({ system: 'light', attr: 'dark' })).toEqual(at({ system: 'dark' }));
  });

  it('give the emails and theme-color the SPA colours per scheme', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const spa = resolveTheme(spaRules, { system: scheme });
      const c = EMAIL_TOKENS[scheme];
      expect(c.page).toBe(spa.get('--pk-surface-page'));
      expect(c.card).toBe(spa.get('--pk-surface-raised'));
      expect(c.muted).toBe(spa.get('--pk-text-muted'));
      expect(c.line).toBe(spa.get('--pk-border-subtle'));
      expect(c.accent).toBe(spa.get('--pk-accent'));
      expect(c.foil1).toBe(spa.get('--wl-foil-1'));
      expect(THEME_COLOR[scheme]).toBe(spa.get('--pk-surface-page'));
    }
    // The SPA's own dark muted, not the brand's brighter one.
    expect(EMAIL_TOKENS.dark.muted).toBe('#8f98ad');
  });

  it('carry the brand faces (both subsets, the fallback) and the files they point at', () => {
    expect(generated).toContain('url("/fonts/rubik-var-latin.woff2")');
    expect(generated).toContain('url("/fonts/rubik-var-latin-ext.woff2")');
    expect(generated.match(/font-family:"Rubik Fallback"/g)).toHaveLength(2);
    const { files } = fontSheet(sources);
    expect(readdirSync(resolve(root, 'public/fonts')).sort()).toEqual([...files].sort());
    for (const file of files) {
      const brand = readFileSync(resolve(root, FONT_SOURCE, '..', file));
      expect(readFileSync(resolve(root, 'public/fonts', file)).equals(brand)).toBe(true);
    }
  });
});

describe('SSR and email sources', () => {
  const ssr = [
    'src/worker/ssr/theme.ts',
    'src/worker/ssr/hosted.ts',
    'src/worker/ssr/pass-page.tsx',
  ];
  const email = [
    'src/worker/email/shell.ts',
    'src/worker/email/sign-in.ts',
    'src/worker/email/pass.ts',
  ];

  it('name colours by token only (white backs the QR and the black Apple badge)', () => {
    for (const file of [...ssr, ...email]) {
      const hex = read(file).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect([file, hex.filter((h) => !/^#f{3}(f{3})?$/i.test(h))]).toEqual([file, []]);
    }
  });

  it('read only variables the generated tokens or their own sheets define', () => {
    const tokens = resolveTheme(ssrRules, { system: 'light' });
    for (const file of ssr) {
      const text = read(file);
      const local = new Set([...text.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
      for (const [, name] of text.matchAll(/var\((--[a-z0-9-]+)/g)) {
        expect([file, name, tokens.has(name ?? '') || local.has(name)]).toEqual([file, name, true]);
      }
    }
  });
});

describe('generated SSR kit', () => {
  it('compiles ssr-controls.css from the current kit sources', () => {
    const css = read('src/generated/ssr-controls.css');
    expect(css).toContain(`(sources ${sourceHash(root, CONTROL_SOURCES)})`);
    // The SPA Button: 36 px (44 on touch), 14/500, 6 px radius, the same hover mix and glow.
    expect(css).toContain('min-height:2.25rem');
    expect(css).toMatch(/@media \(pointer:coarse\)\{\.btn\{min-height:2\.75rem\}/);
    expect(css).toContain('border-radius:var(--pk-radius-md)');
    expect(css).toContain('color-mix(in oklab,var(--pk-accent),var(--wl-hover-mix) 12%)');
    expect(css).toContain('--tw-shadow:var(--wl-glow-accent)');
    // The kit Input: 36 px, 44 px and 16 px text on touch so iOS never zooms; radios stay out.
    expect(css).toMatch(
      /@media \(pointer:coarse\)\{input:where\(:not\(\[type=hidden\],\[type=radio\],\[type=checkbox\]\)\)\{height:2\.75rem;font-size:max\(16px,1rem\)\}/,
    );
  });

  it('bundles public/pass-tilt.js from the current tilt.ts', () => {
    expect(read('public/pass-tilt.js')).toContain(`(sources ${sourceHash(root, [TILT_SOURCE])})`);
  });

  it('keeps the md wordmark and the hosted card in step with the SPA', () => {
    const wordmark = read('src/web/ui/layout/wordmark.tsx');
    expect(wordmark).toContain("md: { link: 'gap-2 text-base', icon: 'size-5' }");
    expect(wordmark).toContain(
      "'inline-flex min-h-8 min-w-8 items-center justify-center rounded-md font-semibold text-fg-strong pointer-coarse:min-h-11 pointer-coarse:min-w-11'",
    );
    const theme = read('src/worker/ssr/theme.ts');
    expect(theme).toContain(
      '.mark{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-width:2rem;min-height:2rem;border-radius:var(--pk-radius-md);font-size:var(--pk-font-size-base);line-height:var(--pk-line-height-base);font-weight:var(--pk-font-weight-semibold);color:var(--pk-text-strong);',
    );
    expect(theme).toContain('.mark>svg{width:1.25rem;height:1.25rem;color:var(--pk-accent-fg)}');
    expect(theme).toContain('@media(pointer:coarse){.mark{min-width:2.75rem;min-height:2.75rem}}');

    expect(read('src/web/portal/login-card.tsx')).toContain(
      'wl-foil-edge flex flex-col overflow-hidden rounded-xl border border-border bg-surface-raised shadow-elevation-1',
    );
    const hosted = read('src/worker/ssr/hosted.ts');
    expect(hosted).toContain(
      'border:1px solid var(--pk-border-subtle);border-radius:var(--pk-radius-xl);background:var(--pk-surface-raised);box-shadow:var(--pk-elevation-1)}',
    );
    expect(hosted).toContain(
      '.card::before{content:"";position:absolute;inset:0 0 auto;height:2px;background:var(--wl-foil)}',
    );
    expect(read('src/web/styles/kit-controls.css')).toMatch(
      /\.wl-foil-edge::before \{[^}]*height: 2px;\s*background: var\(--wl-foil\);/,
    );
  });
});
