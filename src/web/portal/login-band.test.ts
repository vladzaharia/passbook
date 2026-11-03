import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Read as text: the worker's SSR shell (hosted.ts) draws the same band as /login.
const ROOT = join(import.meta.dirname, '../../..');
const squash = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
const spa = squash(readFileSync(join(ROOT, 'src/web/portal/login-scene.css'), 'utf8'));
const ssr = squash(readFileSync(join(ROOT, 'src/worker/ssr/hosted.ts'), 'utf8'));

/** [padding-inline, brand height] at 640 and up, then under 640. */
function bandMetrics(css: string, band: string, brand: string): string[] {
  const re = new RegExp(
    `${band}\\{[^}]*?padding-inline:([^;}]+)|${brand}\\{[^}]*?height:([^;}]+)`,
    'g',
  );
  return [...css.matchAll(re)].map((m) => m[1] ?? m[2] ?? '');
}

describe('sign-in band', () => {
  it('puts the mark on the card text inset and the pocket on the right inset', () => {
    // Left: the card's border and padding (the mark's ink fills its box). Right: the padding,
    // less the space between the pocket's ink and the art's edge (20 px; 17 px under 640).
    expect(bandMetrics(spa, '\\.wl-login-band', '\\.wl-login-brand')).toEqual([
      'calc(1px+1.5rem)calc(1.5rem-19px)',
      '56px',
      'calc(1px+1.25rem)calc(1.25rem-17px)',
      '49px',
    ]);
  });

  it('draws the mark edge to edge: the pocket line ends on the box', () => {
    const mark = readFileSync(join(ROOT, 'src/web/ui/layout/brand-mark.tsx'), 'utf8');
    const css = squash(readFileSync(join(ROOT, 'src/web/ui/layout/brand-mark.css'), 'utf8'));
    expect(mark).toContain('viewBox="0 0 20 20"');
    expect(mark).toContain('<rect x="1" y="7" width="18" height="12"');
    expect(css).toMatch(/^\.wl-mark\{[^}]*stroke-width:2;/);
  });

  it('matches the worker pages: insets, the face line and the seat', () => {
    expect(bandMetrics(ssr, '\\.band', '\\.brand')).toEqual(
      bandMetrics(spa, '\\.wl-login-band', '\\.wl-login-brand'),
    );
    expect(spa).toMatch(
      /\.wl-login-scene\{[^}]*flex:none;width:128px;height:96px;margin-bottom:-8px;/,
    );
    expect(ssr).toMatch(/\.scene\{[^}]*flex:none;width:128px;height:96px;margin-bottom:-8px;/);
  });

  it('sizes the worker wordmark like the lg Wordmark: 20 px, a 24 px mark, 10 px apart', () => {
    const wordmark = readFileSync(join(ROOT, 'src/web/ui/layout/wordmark.tsx'), 'utf8');
    expect(wordmark).toContain(
      "lg: { link: 'gap-2.5 text-xl tracking-[-0.015em]', icon: 'size-6' }",
    );
    expect(ssr).toContain(
      '.band.mark{gap:.625rem;font-size:1.25rem;line-height:1.75rem;letter-spacing:-.015em}',
    );
    expect(ssr).toContain('.band.mark>svg{width:1.5rem;height:1.5rem}');
  });

  it('posts the pass; its states are the SSR band parts (art/wallet-states.tsx)', () => {
    expect(spa).toContain('100%{opacity:0;transform:translate(-44px,58px)rotate(-60deg);}');
    const scene = readFileSync(join(ROOT, 'src/web/portal/login-scene.tsx'), 'utf8');
    expect(scene).toContain("import { HOURGLASS } from '../ui/art/wallet-states.tsx';");
    expect(scene).toContain("state={why === 'expired' ? 'expired' : 'login'}");
    const states = readFileSync(join(ROOT, 'src/web/ui/art/state-art.tsx'), 'utf8');
    expect(states).toContain("import { CHECK, HOURGLASS, KEY } from './wallet-states.tsx';");
    // No drawing of its own: the hourglass stands on the card at the wallet's left in both.
    expect(spa).not.toContain('hourglass');
    const parts = readFileSync(join(ROOT, 'src/web/ui/art/wallet-states.tsx'), 'utf8');
    expect(parts).toContain('<path d="M4 52h8M4 65.5h8');
  });
});
