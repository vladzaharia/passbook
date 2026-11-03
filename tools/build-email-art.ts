// Renders the email buddy PNGs (public/email/) from the real wallet art. Rerun after the art
// changes: `node tools/build-email-art.ts [outDir]`. Needs Playwright's Chromium.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type Plugin, runnerImport } from 'vite';
import { buddyPath, EMAIL_BUDDY, EMAIL_MOODS } from '../src/worker/email/buddy.ts';
import { decodePng, encodePng } from './lib/png.ts';
import { quantize } from './lib/quantize.ts';

const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? resolve(root, 'public'));

/** The dark-theme tokens (src/worker/ssr/theme.ts) the art reads: it stands on a dark header. */
const DARK =
  '--raised:#0d111b;--sunken:#020408;--strong:#fff;--line-strong:#61697b;--accent:#2dd4bf;--accent-on:#04201c;--foil-1:#2dd4bf;--foil-2:#9a5cff;--foil-3:#ffc24d';

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

const { scale, crop } = EMAIL_BUDDY;
const browser = await chromium.launch();
try {
  for (const density of [2, 3] as const) {
    const page = await browser.newPage({ deviceScaleFactor: density, reducedMotion: 'reduce' });
    for (const mood of EMAIL_MOODS) {
      // The resting frame: no entrance, beat or idle motion.
      const svg = renderToStaticMarkup(
        createElement(WalletArt as never, { state: 'login', mood, beat: false, still: true }),
      );
      await page.setContent(
        `<style>${ART_CSS}:root{${DARK}}html,body{margin:0;background:transparent}.wl-art{width:${96 * scale}px;height:${72 * scale}px}</style>${svg}`,
      );
      const shot = await page.screenshot({
        omitBackground: true,
        clip: {
          x: crop.x * scale,
          y: crop.y * scale,
          width: crop.width * scale,
          height: crop.height * scale,
        },
      });
      const png = encodePng(quantize(decodePng(shot)));
      const file = resolve(out, `.${buddyPath(mood, density)}`);
      mkdirSync(resolve(file, '..'), { recursive: true });
      writeFileSync(file, png);
      console.log(`${file}: ${png.length} bytes (Chromium ${shot.length})`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
