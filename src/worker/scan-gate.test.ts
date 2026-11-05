import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fakeAuth } from '../../test/helpers/fake-auth.ts';
import { createApp } from './app.ts';
import type { AppEnv } from './platform/env.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
const app = createApp({ stores: fake.stores });
const SHELL = '<!doctype html><title>Scan · PassBook</title>';
const HTML = { accept: 'text/html' };

/** The env with SCAN_ENABLED set (or removed) and an ASSETS stub that records each path it serves. */
function appEnv(scan: string | undefined, fetched: string[]): AppEnv {
  const { SCAN_ENABLED: _on, ...rest } = env as AppEnv;
  const ASSETS = {
    fetch: async (input: Request) => {
      const path = new URL(input.url).pathname;
      fetched.push(path);
      const type = path.endsWith('.js') ? 'text/javascript' : 'text/html';
      return new Response(SHELL, { headers: { 'content-type': type } });
    },
  };
  return { ...rest, ...(scan === undefined ? {} : { SCAN_ENABLED: scan }), ASSETS } as AppEnv;
}

const call = (path: string, e: AppEnv, headers: Record<string, string> = HTML) =>
  app.request(`${ORIGIN}${path}`, { headers }, e);

const GATED = [
  '/scan',
  '/scan/',
  '/scan/pair',
  '/scan.html',
  '/scan.webmanifest',
  '/assets/decode-worker-AbC123.js',
];

describe('scan gate', () => {
  it.each([['0'], [undefined], ['true']])(
    'SCAN_ENABLED=%s answers every scanner path with the uncached not-found page',
    async (value) => {
      const fetched: string[] = [];
      for (const path of GATED) {
        const res = await call(path, appEnv(value, fetched));
        expect(res.status, path).toBe(404);
        expect(res.headers.get('content-type'), path).toContain('text/html');
        expect(res.headers.get('cache-control'), path).toBe('no-store');
        expect(await res.text(), path).not.toBe(SHELL);
      }
      const machine = await call('/scan', appEnv(value, fetched), {});
      expect(machine.status).toBe(404);
      expect(machine.headers.get('content-type')).toBe('application/problem+json');
      expect(fetched).toEqual([]);
    },
  );

  it('leaves the SPA, its other chunks and the scan API alone while off', async () => {
    const fetched: string[] = [];
    const off = appEnv('0', fetched);
    for (const path of ['/login', '/scanner', '/admin/passes']) {
      expect((await call(path, off)).status, path).toBe(200);
    }
    expect((await call('/assets/scan-4yfauZzv.js', off, {})).status).toBe(200);
    expect(fetched).toEqual(['/login', '/scanner', '/admin/passes', '/assets/scan-4yfauZzv.js']);
    const api = await call('/api/v1/scan/nothing-here', off, fake.admin());
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toBe('application/problem+json');
  });

  it('serves the document, its manifest and the decoder worker from assets when on', async () => {
    const fetched: string[] = [];
    const on = appEnv('1', fetched);
    expect(await (await call('/scan', on)).text()).toBe(SHELL);
    expect((await call('/scan.webmanifest', on, {})).status).toBe(200);
    expect((await call('/assets/decode-worker-AbC123.js', on, {})).status).toBe(200);
    expect(fetched).toEqual(['/scan', '/scan.webmanifest', '/assets/decode-worker-AbC123.js']);
  });
});
