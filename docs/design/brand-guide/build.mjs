import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runnerImport } from 'vite';

const out = import.meta.dirname;
const root = resolve(out, '../../..');
const review = '/private/tmp/passbook-brand-guide-review';
mkdirSync(review, { recursive: true });
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const data = (path, mime) =>
  `data:${mime};base64,${readFileSync(resolve(root, path)).toString('base64')}`;
const noCss = {
  name: 'brand-guide-no-css-side-effects',
  enforce: 'pre',
  resolveId: (id) => (id.endsWith('.css') ? '\0guide-no-css' : null),
  load: (id) => (id === '\0guide-no-css' ? 'export {}' : null),
};
const load = async (path) =>
  (
    await runnerImport(resolve(root, path), {
      configFile: false,
      root,
      logLevel: 'error',
      plugins: [noCss],
    })
  ).module;

const [{ BrandMark }, { WalletArt }, { ART_CSS }, { ART }, { confirmPage }, signIn, passEmail] =
  await Promise.all([
    load('src/web/ui/layout/brand-mark.tsx'),
    load('src/web/ui/art/wallet.tsx'),
    load('src/web/ui/art/css.ts'),
    load('src/web/ui/art/registry.ts'),
    load('src/worker/modules/auth/pages.ts'),
    load('src/worker/email/sign-in.ts'),
    load('src/worker/email/pass.ts'),
  ]);

let serial = 0;
const render = (component, props = {}) =>
  renderToStaticMarkup(createElement(component, props), { identifierPrefix: `guide-${serial++}-` });
const slots = {
  mark: () => render(BrandMark),
  favicon: () => data('public/favicon.svg', 'image/svg+xml'),
};
for (const mood of ['default', 'happy', 'curious', 'sad', 'flat']) {
  slots[`buddy-${mood}`] = () =>
    render(WalletArt, {
      state: 'login',
      mood: mood === 'default' ? undefined : mood,
      seat: true,
      beat: false,
      still: true,
    });
}
for (const name of [
  'passes',
  'template',
  'plugs',
  'building',
  'certificate',
  'key',
  'envelope',
  'phone',
]) {
  slots[`art-${name}`] = () => render(ART[name], { still: true, beat: false });
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.route('https://brand-guide.invalid/**', async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const asset = resolve(root, `public${path}`);
    assert(asset.startsWith(`${root}/public/`), 'Asset escaped public directory');
    const mime = { '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
    assert(mime[extname(asset)], `Unexpected asset: ${path}`);
    await route.fulfill({ body: readFileSync(asset), contentType: mime[extname(asset)] });
  });
  const confirm = confirmPage('brand-guide-preview', {
    token: 'example-only',
    email: 'reader@example.test',
    purpose: 'sign_in',
  });
  const origin = 'https://brand-guide.invalid';
  const emails = {
    'sign-in-email': signIn.renderSignInEmail({
      purpose: 'sign_in',
      link: `${origin}/example`,
      base: origin,
      code: '123456',
      expiresMinutes: 15,
    }).html,
    'pass-email': passEmail.renderPassEmail({
      orgName: 'Northwind Climbing',
      accent: '#1e3a5f',
      downloadUrl: `${origin}/example`,
      manageUrl: `${origin}/example`,
      badgeUrl: `${origin}/apple/badge/en/black@2x.png`,
      attached: false,
      passTitle: 'Membership',
      senderName: 'PassBook',
      summary: {
        colors: { background: '#1e3a5f', foreground: '#ffffff', label: '#cbd5e1' },
        fields: [
          { label: 'Member', value: 'Alex Morgan' },
          { label: 'Tier', value: 'Annual' },
        ],
      },
    }).html,
  };
  const specimens = [
    ['confirm-dark', confirm, 'dark', '.hosted', 440],
    ['confirm-light', confirm, 'light', '.hosted', 440],
    ...Object.entries(emails).map(([name, html]) => [name, html, 'light', '.e-card', 512]),
  ];
  for (const [name, html, colorScheme, selector, width] of specimens) {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ colorScheme });
    await page.setContent(
      html
        .replace('<head>', `<head><base href="${origin}/">`)
        .replace(/<script[^>]*>.*?<\/script>/gs, ''),
    );
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode()));
    });
    const png = await page.locator(selector).screenshot({ path: `${review}/${name}.png` });
    slots[`shot-${name}`] = () => `data:image/png;base64,${png.toString('base64')}`;
  }

  const fontRoot = 'node_modules/@polaris-key/brand/fonts';
  const fonts = `@font-face{font-family:Rubik;font-style:normal;font-weight:300 900;src:url(${data('public/fonts/rubik-var-latin.woff2', 'font/woff2')}) format('woff2')}\n@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:400 600;src:url(${data(`${fontRoot}/jetbrains-mono-var-latin.woff2`, 'font/woff2')}) format('woff2')}`;
  const licenses = ['FONT-NOTICE.txt', 'OFL.txt', 'OFL-JetBrainsMono.txt']
    .map((file) => read(`${fontRoot}/${file}`))
    .join('\n\n');
  writeFileSync(resolve(out, 'font-licenses.txt'), licenses);
  const content = read('docs/design/brand-guide/pages.html').replace(
    /\{\{([\w-]+)\}\}/g,
    (_, name) => {
      assert(slots[name], `Missing guide slot: ${name}`);
      return slots[name]();
    },
  );
  const styles = [
    fonts,
    ART_CSS,
    read('src/web/ui/layout/brand-mark.css'),
    read('docs/design/brand-guide/guide.css'),
    read('docs/design/brand-guide/identity.css'),
    read('docs/design/brand-guide/expression.css'),
    read('docs/design/brand-guide/responsive.css'),
  ].join('\n');
  const html = `<!doctype html>\n<!-- Generated by build.mjs from checked source components; edit pages.html and guide styles. -->\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PassBook brand guide</title><style>${styles}</style></head><body>${content}\n<!-- Embedded font licenses\n${licenses.replaceAll('-->', '-- >')}\n--></body></html>`;
  const htmlPath = resolve(out, 'passbook-brand-guide.html');
  writeFileSync(htmlPath, html);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(pathToFileURL(htmlPath).href);
  await page.evaluate(() => document.fonts.ready);
  assert(
    await page.evaluate(
      () => document.fonts.check('16px Rubik') && document.fonts.check('16px "JetBrains Mono"'),
    ),
  );
  assert(
    await page.evaluate(() =>
      [...document.images].every((img) => img.complete && img.naturalWidth > 0),
    ),
  );
  const sheets = page.locator('.sheet');
  assert.equal(await sheets.count(), 11);
  const pictures = [];
  const issues = await page.evaluate(() =>
    [...document.querySelectorAll('.sheet')].flatMap((sheet) => {
      const box = sheet.getBoundingClientRect();
      const footer = sheet.querySelector('footer').getBoundingClientRect();
      return [...sheet.children].flatMap((child) => {
        if (child.tagName === 'FOOTER') return [];
        const r = child.getBoundingClientRect();
        return r.bottom > footer.top - 8 || r.right > box.right || r.left < box.left
          ? [`${sheet.id}: ${child.className || child.tagName} crosses page or footer boundary`]
          : [];
      });
    }),
  );
  for (let i = 0; i < (await sheets.count()); i++) {
    const png = await sheets
      .nth(i)
      .screenshot({ path: `${review}/page-${String(i + 1).padStart(2, '0')}.png` });
    pictures.push(`data:image/png;base64,${png.toString('base64')}`);
  }
  await page.pdf({
    path: resolve(out, 'passbook-brand-guide.pdf'),
    preferCSSPageSize: true,
    printBackground: true,
    tagged: true,
  });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) {
      const wide = await page.evaluate(() =>
        [...document.querySelectorAll('body *')]
          .filter((element) => element.getBoundingClientRect().right > innerWidth)
          .map((element) => `${element.closest('.sheet')?.id}: ${element.className}`)
          .slice(0, 15),
      );
      issues.push(`Horizontal overflow at ${width}px: ${wide.join(', ')}`);
    }
    await page.locator('#cover').screenshot({ path: `${review}/phone-${width}.png` });
  }
  const report = {
    pages: 11,
    desktop: 1440,
    phoneWidths: [390, 320],
    issues,
    browserErrors: failures,
  };
  writeFileSync(`${review}/checks.json`, `${JSON.stringify(report, null, 2)}\n`);
  await page.setViewportSize({ width: 1200, height: 2400 });
  await page.setContent(
    `<!doctype html><style>body{margin:0;padding:16px;background:#20232b;display:grid;grid-template-columns:repeat(3,1fr);gap:14px;align-content:start}img{width:100%;display:block}</style>${pictures.map((src) => `<img src="${src}" alt="">`).join('')}`,
  );
  await page.locator('body').screenshot({ path: `${review}/contact-sheet.png` });
  assert.deepEqual([...issues, ...failures], [], 'Visual checks failed; inspect review captures');
  process.stdout.write(
    `Built HTML and PDF; 11 pages, 390/320 px overflow checks, fonts and images passed.\nReview: ${review}\n`,
  );
} finally {
  await browser.close();
}
