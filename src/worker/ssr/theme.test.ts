import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/index.ts';
import { THEME_COLOR } from '../../generated/resolved-tokens.ts';
import { createApp } from '../app.ts';
import { breakglassPage, expiredPage } from '../modules/auth/pages.ts';
import { type Kit, setupKit } from '../modules/passes/pass-test-fixtures.ts';
import { renderErrorPage } from './error-page.tsx';
import { themeFromCookie } from './head.ts';
import { renderNotFoundPage } from './pass-page.tsx';

const NONCE = 'n0nce';
const ORIGIN = 'https://wallet.test';
const metas = (html: string) => html.match(/<meta name="theme-color"[^>]*>/g) ?? [];

describe('theme choice', () => {
  it('reads the SPA cookie: light or dark stamps the page, system or junk follows the OS', () => {
    expect(themeFromCookie('a=1; wallet-theme=dark; b=2')).toBe('dark');
    expect(themeFromCookie('wallet-theme=light')).toBe('light');
    expect(themeFromCookie('wallet-theme=system')).toBeUndefined();
    expect(themeFromCookie('wallet-theme=blue')).toBeUndefined();
    expect(themeFromCookie('other-wallet-theme=dark')).toBeUndefined();
    expect(themeFromCookie(undefined)).toBeUndefined();
  });

  it.each([
    ['light', THEME_COLOR.light],
    ['dark', THEME_COLOR.dark],
  ] as const)('stamps %s on hosted, error and dead-link pages, one theme-color', (theme, color) => {
    for (const html of [
      expiredPage(NONCE, null, theme),
      renderErrorPage({ status: 500, nonce: NONCE, theme }),
      renderNotFoundPage(NONCE, theme),
    ]) {
      expect(html).toContain(`<html lang="en" data-theme="${theme}">`);
      expect(metas(html)).toEqual([`<meta name="theme-color" content="${color}">`]);
      expect(html).toContain(`<meta name="color-scheme" content="${theme}">`);
    }
  });

  it('follows the OS with both media metas when nothing is chosen', () => {
    const html = expiredPage(NONCE);
    expect(html).toContain('<html lang="en"><head>');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(metas(html)).toEqual([
      `<meta name="theme-color" content="${THEME_COLOR.light}" media="(prefers-color-scheme: light)">`,
      `<meta name="theme-color" content="${THEME_COLOR.dark}" media="(prefers-color-scheme: dark)">`,
    ]);
  });

  it('renders icons from lucide, as the SPA does', () => {
    expect(breakglassPage(NONCE, { error: 'Wrong token.' })).toContain(
      'class="lucide lucide-octagon-x',
    );
    expect(expiredPage(NONCE)).toContain('class="lucide lucide-lock');
  });
});

describe('theme cookie on Worker pages', () => {
  let kit: Kit;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    kit = await setupKit();
    app = createApp({ stores: fakeAuth(ORIGIN).stores });
  });
  // A Mac: the pass page shows the badge beside its QR (off Apple's devices, the QR alone).
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15';
  const get = async (path: string, theme?: string) =>
    (
      await app.request(
        `${ORIGIN}${path}`,
        {
          headers: {
            accept: 'text/html',
            'user-agent': MAC,
            ...(theme ? { cookie: `wallet-theme=${theme}` } : {}),
          },
        },
        kit.env,
      )
    ).text();

  it('stamps the pass page; the Apple badge art is the same in each theme', async () => {
    const pass = await kit.pass();
    const dark = await get(`/p/${pass.downloadToken}`, 'dark');
    expect(dark).toContain('<html lang="en" data-theme="dark">');
    const light = await get(`/p/${pass.downloadToken}`, 'light');
    expect(light).toContain('<html lang="en" data-theme="light">');
    const system = await get(`/p/${pass.downloadToken}`, 'system');
    expect(system).toContain('<html lang="en"><head>');
    for (const html of [dark, light, system]) {
      expect(html).toContain('/apple/badge/en/black.svg');
      expect(html).not.toContain('outline.svg');
    }
  });

  it.each([
    ['an auth page', '/auth/magic?token=nope'],
    ['a dead pass link', '/p/abcdefghijklmnopqrst'],
    // Other unknown paths belong to the SPA; only Worker-only prefixes answer with the 404 page.
    ['a 404', '/health/no/such/page'],
  ])('stamps %s', async (_, path) => {
    expect(await get(path, 'light')).toContain('<html lang="en" data-theme="light">');
    expect(await get(path)).toContain('<html lang="en"><head>');
  });
});
