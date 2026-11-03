// Renders the email buddy PNGs (public/email/) from the real wallet art, seated, at the canonical
// L size in each scheme's tokens, cut at the seam. Rerun after the art or the tokens change:
// `node tools/build-email-art.ts [outDir]`. Needs Playwright's Chromium.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type Plugin, runnerImport } from 'vite';
import {
  BUDDY_SLICES,
  buddyPath,
  EMAIL_BUDDY,
  EMAIL_MOODS,
  EMAIL_SCHEMES,
  sliceHeight,
} from '../src/worker/email/buddy.ts';
import { decodePng, encodePng } from './lib/png.ts';
import { quantize } from './lib/quantize.ts';

const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? resolve(root, 'public'));

/** The SPA tokens as the SSR pages carry them (tools/build-ssr-tokens.ts). */
const TOKENS = readFileSync(resolve(root, 'src/generated/ssr-tokens.css'), 'utf8');

// The art's stylesheet imports are side effects for the app bundle; ART_CSS is inlined below.
const noCss: Plugin = {
  name: 'no-side-effect-css',
  enforce: 'pre',
  resolveId: (id) => (id.endsWith('.css') ? '\0no-css' : null),
  load: (id) => (id === '\0no-css' ? 'export {}' : null),
};
const load = async <T>(id: string): Promise<T> =>
  (
    await runnerImport<T>(resolve(root, id), {
      configFile: false,
      root,
      logLevel: 'error',
      plugins: [noCss],
    })
  ).module;

const { WalletArt } = await load<{ WalletArt: (props: object) => unknown }>(
  'src/web/ui/art/wallet.tsx',
);
const { ART_CSS } = await load<{ ART_CSS: string }>('src/web/ui/art/css.ts');

const { width, height, seam } = EMAIL_BUDDY;
const browser = await chromium.launch();
try {
  for (const density of [2, 3] as const) {
    const page = await browser.newPage({ deviceScaleFactor: density, reducedMotion: 'reduce' });
    for (const scheme of EMAIL_SCHEMES) {
      for (const mood of EMAIL_MOODS) {
        // The resting frame, seated: legs and the contact shadow below the base.
        const svg = renderToStaticMarkup(
          createElement(WalletArt as never, {
            state: 'login',
            mood,
            beat: false,
            still: true,
            seat: true,
          }),
        );
        await page.setContent(
          `<html data-theme="${scheme}"><head><style>${TOKENS}${ART_CSS}html,body{margin:0;background:transparent}body{padding-bottom:${EMAIL_BUDDY.legs}px}.wl-art{width:${width}px;height:${height}px}</style></head><body>${svg}</body></html>`,
        );
        for (const slice of BUDDY_SLICES) {
          const shot = await page.screenshot({
            omitBackground: true,
            clip: { x: 0, y: slice === 'top' ? 0 : seam, width, height: sliceHeight(slice) },
          });
          const png = encodePng(quantize(decodePng(shot)));
          const file = resolve(out, `.${buddyPath(mood, scheme, slice, density)}`);
          mkdirSync(resolve(file, '..'), { recursive: true });
          writeFileSync(file, png);
          console.log(`${file}: ${png.length} bytes (Chromium ${shot.length})`);
        }
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
}
