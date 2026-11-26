import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/fake-auth.ts';
import { MOVED } from '../../../shared/developers.ts';
import { createApp } from '../../app.ts';
import type { AppEnv } from '../../platform/env.ts';

const ORIGIN = 'https://passbook.mobile';
const SPA = '<!doctype html><div id="root"></div>';
const PAGE = '<!doctype html><title>Passes</title>';
const NOT_FOUND = '<!doctype html><title>Page not found</title>';
const MANIFEST = {
  '/developers/not-found.html': {
    asset: '/developers/not-found',
    type: 'text/html; charset=utf-8',
  },
  '/developers/errors/INVALID_INPUT': {
    asset: '/developers/errors/INVALID_INPUT',
    type: 'text/html; charset=utf-8',
  },
  '/developers': { asset: '/developers/', type: 'text/html; charset=utf-8' },
  '/developers/reference/passes': {
    asset: '/developers/reference/passes',
    type: 'text/html; charset=utf-8',
  },
  '/developers/reference/passes.md': {
    asset: '/developers/reference/passes.md',
    type: 'text/markdown; charset=utf-8',
  },
  '/developers/run/passes.json': {
    asset: '/developers/run/passes.json',
    type: 'application/json; charset=utf-8',
  },
};

/** ASSETS as Cloudflare answers: the listed files, and the SPA's shell for anything else. */
function appEnv(fetched: string[] = [], manifest: object = MANIFEST): AppEnv {
  const ASSETS = {
    fetch: async (input: Request) => {
      const path = new URL(input.url).pathname;
      fetched.push(path);
      if (path === '/developers/manifest.json') return Response.json(manifest);
      if (path === '/developers/run/passes.json') return Response.json({ origin: ORIGIN, ops: [] });
      if (path === '/developers/' || path === '/developers/reference/passes')
        return new Response(PAGE, { headers: { 'content-type': 'text/html', etag: '"v1"' } });
      if (path === '/developers/not-found')
        return new Response(NOT_FOUND, { headers: { 'content-type': 'text/html' } });
      if (path === '/developers/errors/INVALID_INPUT')
        return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
      if (path === '/developers/reference/passes.md')
        return new Response('# Passes', { headers: { 'content-type': 'text/markdown' } });
      return new Response(SPA, { headers: { 'content-type': 'text/html' } });
    },
  };
  return { ...env, ASSETS } as unknown as AppEnv;
}

const app = createApp({ stores: fakeAuth(ORIGIN).stores, hostPolicy: true });
const call = (path: string, init: RequestInit = {}, e = appEnv(), host = ORIGIN) =>
  app.request(`${host}${path}`, init, e);

describe('developer portal route', () => {
  it('serves a listed page with its own CSP, no nonce and noindex', async () => {
    const res = await call('/developers/reference/passes');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PAGE);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('etag')).toBe('"v1"');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).not.toMatch(/nonce|unsafe-inline|unsafe-eval/);
  });

  it('admits the Turnstile widget on the home page alone, for Reset', async () => {
    const home = (await call('/developers')).headers.get('content-security-policy') ?? '';
    expect(home).toContain("script-src 'self' https://challenges.cloudflare.com;");
    expect(home).toContain('frame-src https://challenges.cloudflare.com;');
    expect(home).toContain("require-trusted-types-for 'script'");
    expect(home).toContain('trusted-types passbook-turnstile;');
    for (const path of ['/developers/reference/passes', '/developers/logs']) {
      const other = (await call(path)).headers.get('content-security-policy') ?? '';
      expect(other, path).not.toContain('cloudflare');
      expect(other, path).toContain("frame-src 'none'");
      expect(other, path).toContain("trusted-types 'none'");
    }
  });

  it('301s the pages the Workbench took over, keeping the query', async () => {
    for (const [from, to] of Object.entries(MOVED)) {
      const res = await call(`${from}?op=passes.postPasses`);
      expect(res.status, from).toBe(301);
      expect(res.headers.get('location'), from).toBe(`${to}?op=passes.postPasses`);
    }
  });

  it('serves what the Run island reads as JSON, under the ordinary CSP', async () => {
    const res = await call('/developers/run/passes.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ origin: ORIGIN, ops: [] });
    expect(res.headers.get('content-security-policy')).not.toContain('passbook-turnstile');
  });

  it('serves the home page for /developers, and a markdown twin', async () => {
    const res = await call('/developers');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PAGE);
    const md = await call('/developers/reference/passes.md');
    expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(md.headers.get('content-security-policy')).not.toContain('passbook-turnstile');
  });

  it('answers 404 for a path the manifest does not list, never the SPA shell', async () => {
    for (const path of [
      '/developers/nope',
      '/developers/reference/passes.html',
      '/developers/x.md',
    ]) {
      const res = await call(path, { headers: { accept: 'text/html' } });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toBe(SPA);
    }
  });

  it('answers a page that does not exist with the portal page, 404 and noindex, not problem+json', async () => {
    for (const path of ['/developers/nope', '/developers/errors/x']) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toBe('text/html; charset=utf-8');
      expect(await res.text(), path).toBe(NOT_FOUND);
      expect(res.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
      expect(res.headers.get('cache-control'), path).toBe('no-store');
      expect(res.headers.get('content-security-policy'), path).toContain("script-src 'self';");
    }
    const head = await call('/developers/nope', { method: 'HEAD' });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe('');
  });

  it('keeps problem+json for files that do not exist', async () => {
    const res = await call('/developers/x.md');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('redirects a trailing slash, and a code in the wrong case, with a 308', async () => {
    const moves: [string, string][] = [
      ['/developers/', '/developers'],
      ['/developers/reference/passes/?x=1', '/developers/reference/passes?x=1'],
      ['/developers/errors/invalid_input', '/developers/errors/INVALID_INPUT'],
      ['/developers/Reference/Passes', '/developers/reference/passes'],
    ];
    for (const [from, to] of moves) {
      const res = await call(from);
      expect(res.status, from).toBe(308);
      expect(
        new URL(res.headers.get('location') ?? '', ORIGIN).pathname +
          new URL(res.headers.get('location') ?? '', ORIGIN).search,
        from,
      ).toBe(to);
    }
  });

  it('marks pages no-transform, so the edge injects no analytics beacon the CSP would refuse', async () => {
    const page = await call('/developers/reference/passes');
    expect(page.headers.get('cache-control')).toBe('public, max-age=300, no-transform');
    const md = await call('/developers/reference/passes.md');
    expect(md.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('answers 404 for everything when the build left no manifest', async () => {
    const res = await call('/developers', {}, appEnv([], {}));
    expect(res.status).toBe(404);
  });

  it('does not serve other methods', async () => {
    const res = await call('/developers/reference/passes', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('is refused on any host but the canonical one (custom domains answer 421)', async () => {
    const res = await call('/developers', {}, appEnv(), 'https://tickets.example.com');
    expect(res.status).toBe(421);
  });

  it('moves the developers host to /developers with a 308', async () => {
    const e = { ...appEnv(), DEVELOPERS_HOSTS: 'developers.passbook.mobile' } as AppEnv;
    const moves: [string, string][] = [
      ['/', '/developers'],
      ['/reference/passes?x=1', '/developers/reference/passes?x=1'],
      ['/developers/reference/passes', '/developers/reference/passes'],
      ['/llms.txt', '/developers/llms.txt'],
    ];
    for (const [from, to] of moves) {
      const res = await call(from, {}, e, 'https://developers.passbook.mobile');
      expect(res.status, from).toBe(308);
      expect(res.headers.get('location'), from).toBe(`${ORIGIN}${to}`);
    }
  });
});
