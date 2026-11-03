// Renders the PassBook icons and the social image into public/ from the mark (tools/lib/icon-art.ts)
// and the real wallet art. Rerun after either changes: `node tools/build-icons.ts [outDir]`.
// Needs Playwright's Chromium. The sizes and paths are the ones index.html, the manifest and the
// SSR head declare; tools/site-meta.test.ts checks them.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type Browser, chromium } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type Plugin, runnerImport } from 'vite';
import { APP_DESCRIPTION } from '../src/worker/ssr/head.ts';
import { encodeIco } from './lib/ico.ts';
import { appIconSvg, tabIconSvg, tinyIconSvg } from './lib/icon-art.ts';
import { OG_SCALE, OG_SIZE, ogHtml } from './lib/og-art.ts';
import { decodePng, encodePng } from './lib/png.ts';
import { quantize } from './lib/quantize.ts';

const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? resolve(root, 'public'));

/** iOS masks the touch icon itself and fills transparency with black: full bleed, opaque. */
const APP = { shape: 'square', scale: 0.76 } as const;
/** The mark's farthest corner is 0.62 of its size from its centre: 0.6 keeps it in the 80% circle. */
const MASKABLE = { shape: 'square', scale: 0.6 } as const;
const ANY = { shape: 'round', scale: 0.76 } as const;

// The art's stylesheet imports are side effects for the app bundle; the CSS is inlined instead.
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

async function screenshot(
  browser: Browser,
  html: string,
  width: number,
  height = width,
  scale = 1,
) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: scale,
    reducedMotion: 'reduce',
  });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  const shot = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width, height } });
  await page.close();
  return decodePng(shot);
}

const svgPage = (svg: string, size: number) =>
  `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;

function write(path: string, data: Uint8Array | string) {
  const file = resolve(out, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`${file}: ${data.length} bytes`);
}

async function ogImage(browser: Browser) {
  const { WalletArt } = await load<{ WalletArt: (props: object) => unknown }>(
    'src/web/ui/art/wallet.tsx',
  );
  const { ART_CSS } = await load<{ ART_CSS: string }>('src/web/ui/art/css.ts');
  const { BrandMark } = await load<{ BrandMark: () => unknown }>(
    'src/web/ui/layout/brand-mark.tsx',
  );
  const markCss = readFileSync(resolve(root, 'src/web/ui/layout/brand-mark.css'), 'utf8');
  const font = readFileSync(resolve(root, 'public/fonts/rubik-var-latin.woff2')).toString('base64');
  const html = ogHtml({
    // The resting frame: no entrance, beat or idle motion.
    art: renderToStaticMarkup(
      createElement(WalletArt as never, { state: 'login', seat: true, beat: false, still: true }),
    ),
    mark: renderToStaticMarkup(createElement(BrandMark as never)),
    css: `${ART_CSS}\n${markCss}`,
    font: `data:font/woff2;base64,${font}`,
    description: APP_DESCRIPTION,
  });
  return screenshot(browser, html, OG_SIZE.width / OG_SCALE, OG_SIZE.height / OG_SCALE, OG_SCALE);
}

const browser = await chromium.launch();
try {
  const png = async (svg: string, size: number) =>
    encodePng(quantize(await screenshot(browser, svgPage(svg, size), size)));
  write('favicon.svg', `${tabIconSvg()}\n`);
  write(
    'favicon.ico',
    encodeIco([
      { size: 16, png: await png(tinyIconSvg(), 16) },
      { size: 32, png: await png(tabIconSvg(), 32) },
      { size: 48, png: await png(tabIconSvg(), 48) },
    ]),
  );
  write('apple-touch-icon.png', await png(appIconSvg(APP), 180));
  write('icons/icon-192.png', await png(appIconSvg(ANY), 192));
  write('icons/icon-512.png', await png(appIconSvg(ANY), 512));
  write('icons/icon-maskable-512.png', await png(appIconSvg(MASKABLE), 512));
  write('og-image.png', encodePng(quantize(await ogImage(browser))));
} finally {
  await browser.close();
}
