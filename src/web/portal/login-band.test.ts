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
    // Left: the card's border and padding, less the mark's 1/12 inset ink. Right: the padding,
    // less the space between the pocket's ink and the art's edge (20 px; 17 px under 640).
    expect(bandMetrics(spa, '\\.wl-login-band', '\\.wl-login-brand')).toEqual([
      'calc(1px+1.375rem)calc(1.5rem-19px)',
      '56px',
      'calc(1px+1.125rem)calc(1.25rem-17px)',
      '49px',
    ]);
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
    expect(ssr).toContain('.band.marksvg{width:1.5rem;height:1.5rem}');
  });

  it('posts the pass and stands the hourglass on the open side, left of the wallet', () => {
    expect(spa).toContain('100%{opacity:0;transform:translate(-44px,58px)rotate(-60deg);}');
    expect(spa).toMatch(/\.wl-login-hourglass\{[^}]*left:calc\(8\.33%-10px\);/);
    const art = readFileSync(join(ROOT, 'src/worker/ssr/hosted-art.tsx'), 'utf8');
    expect(art).toContain('<path d="M4 52h8M4 65.5h8');
  });
});
