import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DIM } from './base.tsx';
import { Buddy } from './buddy.tsx';
import { BuddyArt } from './buddy-art.tsx';
import { WalletArt } from './wallet.tsx';

const DIR = join(process.cwd(), 'src/web/ui/art');
const read = (f: string) =>
  readFileSync(join(DIR, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
const art = read('art.css');
const wallet = read('art-wallet.css');

// The canonical buddy (motion-and-expression.md, The buddy).
describe('buddy scale', () => {
  it('draws S, M and L, L stepping to 112 x 84 under 640, and nothing else', () => {
    expect(DIM).toEqual({ sm: [64, 48], lg: [96, 72], xl: [128, 96] });
    for (const size of ['sm', 'lg', 'xl'] as const) {
      const svg = render(<WalletArt size={size} />).container.querySelector('svg');
      expect(svg).toHaveAttribute('data-size', size);
      expect(svg).toHaveAttribute('width', String(DIM[size][0]));
    }
    expect(art).toContain(
      '@media (max-width: 39.99rem) { .wl-art[data-size="xl"] { width: 112px; height: 84px; } }',
    );
  });

  it('weighs its lines per tier: S 1.25, M 1.5, L 1.75, the heavier lines in step', () => {
    expect(art).toMatch(/\.wl-art \{[^}]*--art-w: 1\.5;[^}]*stroke-width: var\(--art-w\);/);
    expect(art).toContain('.wl-art[data-size="sm"] { --art-w: 1.25; }');
    expect(art).toContain('.wl-art[data-size="xl"] { --art-w: 1.75; }');
    expect(art).toContain('.wl-art .f { stroke-width: calc(var(--art-w) * 4 / 3); }');
    expect(art).not.toMatch(/stroke-width: \d/);
  });
});

describe('buddy seat', () => {
  it('sits its base on the border line, 1 px by default, or the border the host names', () => {
    expect(wallet).toMatch(
      /\.wl-buddy \{ position: absolute; top: calc\(-1 \* var\(--wl-seat-border, 1px\)\); left: 50%; translate: -50% -91\.67%;/,
    );
    const upload = readFileSync(join(process.cwd(), 'src/web/admin/templates/upload.css'), 'utf8');
    expect(upload).toMatch(/\.wl-drop \{\s*--wl-seat-border: 2px;/);
  });

  it('falls onto the edge as it mounts: one entrance for every seated buddy', () => {
    expect(wallet).toMatch(
      /\[data-art="wallet"\] \[data-part="w"\]\[data-seat\] \{ --k: wl-w-fall; --o: 48px 66px; --u: 480ms;/,
    );
    const fall = wallet.match(/@keyframes wl-w-fall \{(.*?)\} @keyframes/)?.[1] ?? '';
    // From 36 units up (so the drop scales with the art), faded in, gravity to the impact at 45%.
    expect(fall).toMatch(
      /0% \{ opacity: 0; transform: translateY\(-36px\) scale\(0\.94, 1\.07\); animation-timing-function: cubic-bezier\(0\.55, 0, 1, 0\.45\); \}/,
    );
    expect(fall).toMatch(/45% \{ transform: scale\(0\.94, 1\.07\);/);
    expect(fall).toMatch(/60% \{ transform: scale\(1\.12, 0\.86\); \}/);
  });

  it('sits centred, or at the start or end inset of a card with a title', () => {
    const { container } = render(
      <div>
        <Buddy />
        <Buddy at="start" />
        <Buddy at="end" />
      </div>,
    );
    const [centre, start, end] = [...container.querySelectorAll('[data-buddy]')];
    expect(centre).not.toHaveAttribute('data-at');
    expect(start).toHaveAttribute('data-at', 'start');
    expect(end).toHaveAttribute('data-at', 'end');
    expect(wallet).toContain('.wl-buddy[data-at] { translate: 0 -91.67%; }');
    expect(wallet).toContain(
      '.wl-buddy[data-at="end"] { left: auto; right: var(--wl-buddy-inset, 12px); }',
    );
  });
});

describe('buddy markup', () => {
  it('is the same markup in the app and on SSR pages; SSR marks its scene to play on load', () => {
    const props = { mood: 'sad', scene: 'plug', size: 'xl' } as const;
    const app = renderToStaticMarkup(<Buddy {...props} />);
    expect(renderToStaticMarkup(<BuddyArt {...props} />)).toBe(app);
    expect(app).not.toContain('data-run');
    expect(renderToStaticMarkup(<BuddyArt {...props} playOnLoad />)).toContain('data-run="load"');
    // A loaded page's scene waits for the landing, as the app's does (scenes/common.css).
    expect(read('scenes/common.css')).toContain('[data-run="load"] { --wl-at: 700ms; }');
    for (const f of ['plug', 'peek', 'mend', 'tug'])
      for (const [, delay] of read(`scenes/${f}.css`).matchAll(/animation: wl-s-[^;]*?(\S+);/g))
        expect(delay, f).toBe('0s)');
  });

  it('draws the tear only for the tear scene, hidden until it runs', () => {
    const tear = render(<Buddy mood="sad" size="sm" scene="tear" />).container;
    expect(tear.querySelector('[data-tear]')).toHaveAttribute('opacity', '0');
    const wave = render(<Buddy mood="happy" size="sm" scene="wave" />).container;
    expect(wave.querySelector('[data-tear]')).toBeNull();
  });
});
