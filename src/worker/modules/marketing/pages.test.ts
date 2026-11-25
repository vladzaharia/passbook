import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/fake-auth.ts';
import { createApp } from '../../app.ts';
import type { AppEnv } from '../../platform/env.ts';

const ORIGIN = 'https://passbook.mobile';
const SPA = '<!doctype html><div id="root"></div>';
const ACCESS =
  '<!doctype html><script src="/assets/marketing-access-x.js"></script><div class="panel acc-ticket" id="acc-ticket"><div id="acc-buddy" data-buddy="curious"></div>' +
  '<form id="acc-form"></form><div id="acc-done" hidden tabindex="-1"></div></div>';
const PAGES: Record<string, string> = {
  '/marketing/':
    '<!doctype html><title>Home</title><script src="/assets/marketing-home-x.js"></script>',
  '/marketing/door':
    '<!doctype html><title>Door</title><script src="/assets/marketing-door-x.js"></script>',
  '/marketing/blueprints':
    '<!doctype html><title>Blueprints</title><script src="/assets/marketing-blueprints-x.js"></script>',
  '/marketing/build':
    '<!doctype html><title>Build</title><script src="/assets/marketing-build-x.js"></script>',
  '/marketing/access': ACCESS,
};

/** ASSETS as Cloudflare answers: the built pages by their bare path, the SPA's shell for the rest. */
function appEnv(pages: Record<string, string> = PAGES): AppEnv {
  const ASSETS = {
    fetch: async (input: Request) => {
      const path = new URL(input.url).pathname;
      const page = pages[path];
      if (page !== undefined)
        return new Response(page, {
          headers: { 'content-type': 'text/html; charset=utf-8', etag: '"v1"' },
        });
      return new Response(SPA, { headers: { 'content-type': 'text/html', 'x-shell': '1' } });
    },
  };
  return { ...env, ASSETS } as unknown as AppEnv;
}

const app = createApp({ stores: fakeAuth(ORIGIN).stores, hostPolicy: true });
const call = (path: string, init: RequestInit = {}, e = appEnv()) =>
  app.request(`${ORIGIN}${path}`, init, e);

describe('marketing pages', () => {
  it.each([
    ['/door', 'Door'],
    ['/blueprints', 'Blueprints'],
    ['/build', 'Build'],
    ['/access', ACCESS],
  ])('%s is public, indexable and under the marketing CSP', async (path, text) => {
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(text);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, no-transform');
    expect(res.headers.get('x-robots-tag')).toBe('index, follow');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('trusted-types passbook-marketing');
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toMatch(/nonce|unsafe-eval|script-src[^;]*unsafe-inline/);
    expect(res.headers.get('strict-transport-security')).toBeTruthy();
  });

  it('a HEAD has no body', async () => {
    const res = await call('/door', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect((await call('/', { method: 'HEAD' })).status).toBe(200);
  });

  it('a trailing slash is a 308 to the page, keeping the query', async () => {
    for (const path of ['/door', '/blueprints', '/build', '/access', '/access/sent']) {
      const res = await call(`${path}/?x=1`);
      expect(res.status, path).toBe(308);
      expect(res.headers.get('location'), path).toBe(`${path}?x=1`);
    }
  });

  it('serves nothing at the built path', async () => {
    for (const path of ['/marketing/door', '/marketing/', '/marketing/index.html']) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('<title>');
    }
  });

  it('is a 404, not the app shell, when the build has no page', async () => {
    const res = await call('/door', {}, appEnv({}));
    expect(res.status).toBe(404);
    expect(res.headers.get('x-shell')).toBeNull();
  });

  it('/access/sent shows the sent state, uncached and noindex', async () => {
    const res = await call('/access/sent');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<form id="acc-form" hidden(="")?>/);
    expect(html).toMatch(/<div id="acc-done"\s+tabindex="-1">/);
    expect(html).toContain('class="panel acc-ticket sent"');
    expect(html).toContain('data-buddy="tuck"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('content-security-policy')).toContain('passbook-marketing');
  });

  it('/access still takes a post and refuses other methods', async () => {
    const res = await call('/access', { method: 'PUT' });
    expect(res.status).not.toBe(200);
  });
});

describe('home', () => {
  it('with no session cookie is Home, varying by cookie', async () => {
    const res = await call('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Home</title>');
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.headers.get('vary')).toContain('Cookie');
    expect(res.headers.get('x-robots-tag')).toBe('index, follow');
    expect(res.headers.get('content-security-policy')).toContain('passbook-marketing');
  });

  it('with a session cookie is the app shell, as the asset layer serves it', async () => {
    const res = await call('/', { headers: { cookie: '__Host-wallet_sid=abc' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SPA);
    expect(res.headers.get('x-shell')).toBe('1');
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.headers.get('vary')).toContain('Cookie');
    expect(res.headers.get('content-security-policy') ?? '').not.toContain('passbook-marketing');
  });

  it('other cookies do not count as a session', async () => {
    const res = await call('/', { headers: { cookie: 'theme=dark' } });
    expect(await res.text()).toContain('<title>Home</title>');
  });
});

describe('sitemap', () => {
  it('lists the five pages and not /access/sent', async () => {
    const res = await call('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(
      ['/', '/door', '/blueprints', '/build', '/access'].map((p) => `${ORIGIN}${p}`),
    );
  });
});
