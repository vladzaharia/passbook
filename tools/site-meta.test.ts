import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_DESCRIPTION, HEAD_HTML } from '../src/worker/ssr/head.ts';
import { decodeIco } from './lib/ico.ts';
import { ICON_COLORS, tabIconSvg } from './lib/icon-art.ts';
import { OG_ALT, OG_SIZE } from './lib/og-art.ts';
import { decodePng, type Image } from './lib/png.ts';
import { ORIGIN_TOKEN, publicBaseUrl, withOrigin } from './lib/site-origin.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path));
const pub = (url: string) => read(`public${new URL(url, 'https://x').pathname}`);
const html = read('index.html').toString();
const manifest = JSON.parse(read('public/manifest.webmanifest').toString());
const BASE = publicBaseUrl(resolve(root, 'wrangler.jsonc'));

/** The content of `<meta name|property="key">`; every match when there are several. */
const meta = (source: string, key: string) =>
  [...source.matchAll(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`, 'g'))].map(
    (m) => m[1],
  );
const links = (source: string, rel: string) =>
  [...source.matchAll(new RegExp(`<link rel="${rel}" href="([^"]+)"`, 'g'))].map((m) => m[1]);
const pixel = (img: Image, x: number, y: number) =>
  [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)].join();
const hex = (c: string) => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16)).join();
const opaque = (img: Image) => img.data.every((v, i) => i % 4 !== 3 || v === 255);

describe('manifest.webmanifest', () => {
  it('installs PassBook standalone at the portal, in the dark brand colours', () => {
    expect(manifest).toMatchObject({
      id: '/',
      name: 'PassBook',
      short_name: 'PassBook',
      description: APP_DESCRIPTION,
      lang: 'en',
      dir: 'ltr',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: ICON_COLORS.page,
      theme_color: ICON_COLORS.page,
    });
    const purposes = manifest.icons.map((i: { sizes: string; purpose: string }) =>
      [i.sizes, i.purpose].join(' '),
    );
    expect(purposes).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
  });

  it.each(manifest.icons as { src: string; sizes: string; purpose: string }[])(
    '$src is a $sizes PNG',
    ({ src, sizes, purpose }) => {
      const img = decodePng(pub(src));
      expect(`${img.width}x${img.height}`).toBe(sizes);
      const corner = pixel(img, 0, 0);
      if (purpose === 'any') expect(corner.endsWith(',0')).toBe(true);
      else {
        // Maskable: full bleed, and the mark stays inside the 80% safe circle.
        expect(opaque(img)).toBe(true);
        const r = img.width * 0.4;
        const c = img.width / 2;
        for (let y = 0; y < img.height; y += 2)
          for (let x = 0; x < img.width; x += 2)
            if ((x - c) ** 2 + (y - c) ** 2 > r * r)
              expect(pixel(img, x, y)).toBe(`${hex(ICON_COLORS.tile)},255`);
      }
    },
  );
});

describe('client metadata logo', () => {
  it('is the rounded app icon the manifest installs', () => {
    // Read from source: the worker module's imports need the Workers types.
    const CIMD_LOGO_PATH = /export const CIMD_LOGO_PATH = '([^']+)'/.exec(
      read('src/worker/modules/auth/oidc-cimd.ts').toString(),
    )?.[1];
    expect(manifest.icons).toContainEqual(
      expect.objectContaining({ src: CIMD_LOGO_PATH, purpose: 'any' }),
    );
    expect(existsSync(resolve(root, `public${CIMD_LOGO_PATH}`))).toBe(true);
  });
});

describe('icons the heads link', () => {
  it('index.html and the SSR head link the same icons', () => {
    for (const rel of ['icon', 'apple-touch-icon'])
      expect(links(html, rel)).toEqual(links(HEAD_HTML, rel));
    expect(links(HEAD_HTML, 'icon')).toEqual(['/favicon.ico', '/favicon.svg']);
  });

  it('favicon.ico holds sharp 16, 32 and 48 px PNG frames', () => {
    const frames = decodeIco(read('public/favicon.ico'));
    expect(frames.map((f) => f.size)).toEqual([16, 32, 48]);
    for (const { size, png } of frames) {
      const img = decodePng(png);
      expect([img.width, img.height]).toEqual([size, size]);
      expect(pixel(img, size / 2, size - 1)).toBe(`${hex(ICON_COLORS.tile)},255`);
    }
  });

  it('favicon.svg is the generated tab icon', () => {
    expect(read('public/favicon.svg').toString().trim()).toBe(tabIconSvg());
  });

  it('apple-touch-icon.png is 180 px and opaque (iOS fills transparency with black)', () => {
    const img = decodePng(read('public/apple-touch-icon.png'));
    expect([img.width, img.height]).toEqual([180, 180]);
    expect(opaque(img)).toBe(true);
  });

  it('og-image.png is 1200×630, under 100 kB, as declared', () => {
    const file = read('public/og-image.png');
    expect(file.length).toBeLessThan(100_000);
    const img = decodePng(file);
    expect([img.width, img.height]).toEqual([OG_SIZE.width, OG_SIZE.height]);
    expect(opaque(img)).toBe(true);
    expect(meta(html, 'og:image:width')).toEqual([String(OG_SIZE.width)]);
    expect(meta(html, 'og:image:height')).toEqual([String(OG_SIZE.height)]);
    expect(meta(html, 'og:image:alt')).toEqual([OG_ALT]);
  });
});

describe('index.html head', () => {
  it('keeps zoom, the safe-area layout, the title and the language', () => {
    expect(html).toContain('<html lang="en"');
    expect(html).toContain('<meta charset="utf-8" />');
    const [viewport] = meta(html, 'viewport');
    expect(viewport).toContain('viewport-fit=cover');
    expect(viewport).not.toMatch(/maximum-scale|user-scalable/);
    expect(html).toContain('<title>PassBook</title>');
  });

  it('describes the app and colours the browser like the page in both themes', () => {
    expect(meta(html, 'description')).toEqual([APP_DESCRIPTION]);
    expect(meta(html, 'color-scheme')).toEqual(['dark light']);
    expect(meta(html, 'format-detection')).toEqual(['telephone=no']);
    expect(meta(html, 'theme-color')).toEqual(['#f6f8ff', ICON_COLORS.page]);
    expect(html).toContain('media="(prefers-color-scheme: dark)"');
  });

  it('installs from the manifest and pins to the iOS home screen', () => {
    expect(links(html, 'manifest')).toEqual(['/manifest.webmanifest']);
    expect(meta(html, 'mobile-web-app-capable')).toEqual(['yes']);
    expect(meta(html, 'apple-mobile-web-app-capable')).toEqual(['yes']);
    expect(meta(html, 'apple-mobile-web-app-title')).toEqual(['PassBook']);
    // Opaque bar in the theme colour: black-translucent would put white text on the light page.
    expect(meta(html, 'apple-mobile-web-app-status-bar-style')).toEqual(['default']);
  });

  it('previews links with absolute URLs the build takes from PUBLIC_BASE_URL', () => {
    expect(meta(html, 'og:site_name')).toEqual(['PassBook']);
    expect(meta(html, 'og:type')).toEqual(['website']);
    expect(meta(html, 'og:title')).toEqual(['PassBook']);
    expect(meta(html, 'og:description')).toEqual([APP_DESCRIPTION]);
    expect(meta(html, 'og:url')).toEqual([`${ORIGIN_TOKEN}/`]);
    expect(html).not.toMatch(/https?:\/\//);
    const built = withOrigin(html, BASE);
    expect(BASE).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    expect(meta(built, 'og:url')).toEqual([`${BASE}/`]);
    expect(meta(built, 'og:image')).toEqual([`${BASE}/og-image.png`]);
    expect(meta(built, 'twitter:card')).toEqual(['summary_large_image']);
  });
});

/** Google selects the most specific user-agent group, then the longest matching path rule. */
function crawlable(robots: string, path: string, agent = '*'): boolean {
  const groups = robots.split(/\n\s*\n/).map((group) => {
    const names = [...group.matchAll(/^User-agent:\s*(\S+)/gim)].map((match) =>
      match[1]!.toLowerCase(),
    );
    const specificity = Math.max(
      -1,
      ...names.map((name) =>
        name === '*' ? 0 : agent.toLowerCase().includes(name) ? name.length : -1,
      ),
    );
    return { group, specificity };
  });
  const specificity = Math.max(...groups.map((group) => group.specificity));
  let best = { length: -1, allow: true };
  for (const { group } of groups.filter((candidate) => candidate.specificity === specificity)) {
    for (const line of group.split('\n')) {
      const m = /^(Allow|Disallow):\s*(\S+)/.exec(line);
      if (!m?.[1] || !m[2]) continue;
      const rule = m[2];
      const exact = rule.endsWith('$');
      const prefix = exact ? rule.slice(0, -1) : rule;
      const hit = exact ? path === prefix : path.startsWith(prefix);
      if (hit && (rule.length > best.length || (rule.length === best.length && m[1] === 'Allow')))
        best = { length: rule.length, allow: m[1] === 'Allow' };
    }
  }
  return best.allow;
}

describe('robots.txt', () => {
  const robots = read('public/robots.txt').toString();

  it.each([
    '/',
    '/login',
    '/login?next=%2F',
    '/favicon.ico',
    '/og-image.png',
    '/icons/icon-192.png',
  ])('lets crawlers read %s', (path) => expect(crawlable(robots, path)).toBe(true));

  it.each([
    '/p/abcdefghijklmnopqrst',
    '/auth/magic?token=x',
    '/api/v1/session',
    '/admin',
    '/account',
    '/passes/1',
    '/wallet/v1/log',
    '/hooks/x',
    '/somewhere-new',
  ])('keeps %s out', (path) => expect(crawlable(robots, path)).toBe(false));

  it.each(['Googlebot', 'Google-Valuables'])('allows only the Wallet callback for %s', (agent) => {
    expect(crawlable(robots, '/wallet/v1/google/account-id', agent)).toBe(true);
    expect(crawlable(robots, '/wallet/v1/log', agent)).toBe(false);
    expect(crawlable(robots, '/p/abcdefghijklmnopqrst', agent)).toBe(false);
    expect(crawlable(robots, '/auth/magic?token=x', agent)).toBe(false);
    expect(crawlable(robots, '/login', agent)).toBe(true);
  });

  it('keeps the callback closed to unrelated crawlers', () => {
    expect(crawlable(robots, '/wallet/v1/google/account-id', '*')).toBe(false);
  });

  it('names every file it allows', () => {
    for (const [, path] of robots.matchAll(/^Allow: (\/[\w.-]+\.\w+)$/gm))
      expect(existsSync(resolve(root, `public${path}`)), path).toBe(true);
  });
});

/** public/_headers as path -> header lines. */
function headerRules(): Map<string, string[]> {
  const rules = new Map<string, string[]>();
  for (const block of read('public/_headers')
    .toString()
    .trim()
    .split(/\n\s*\n/)) {
    const [path, ...lines] = block.split('\n');
    rules.set(
      path?.trim() ?? '',
      lines.map((l) => l.trim()),
    );
  }
  return rules;
}

describe('_headers for the site files', () => {
  const rules = headerRules();

  it('serves the manifest as JSON, cached for a day', () => {
    expect(rules.get('/manifest.webmanifest')).toEqual([
      'Content-Type: application/manifest+json',
      'Cache-Control: public, max-age=86400',
    ]);
  });

  it.each(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/icons/*', '/og-image.png'])(
    'caches %s for a day and lets other sites embed it',
    (path) => {
      expect(rules.get(path)).toEqual([
        'Cache-Control: public, max-age=86400',
        '! Cross-Origin-Resource-Policy',
        'Cross-Origin-Resource-Policy: cross-origin',
      ]);
    },
  );

  it('lets the manifest load under the CSP', () => {
    expect(rules.get('/*')?.join('\n')).toContain("manifest-src 'self'");
  });
});
