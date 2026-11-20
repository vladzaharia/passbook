import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/fake-auth.ts';
import { STATUS_SLOT } from '../../../web/developers/pages/status.tsx';
import { createApp } from '../../app.ts';
import type { AppEnv } from '../../platform/env.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';

const ORIGIN = 'https://passbook.mobile';
const MANIFEST = {
  '/developers/status': { asset: '/developers/status', type: 'text/html; charset=utf-8' },
};

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
}, 30_000);

const appEnv = (): AppEnv =>
  ({
    ...rk.kit.env,
    ASSETS: {
      fetch: async (input: Request) => {
        const path = new URL(input.url).pathname;
        if (path === '/developers/manifest.json') return Response.json(MANIFEST);
        if (path === '/developers/status')
          return new Response(`<main><h1>Status</h1>${STATUS_SLOT}</main>`, {
            headers: { 'content-type': 'text/html', etag: '"v1"' },
          });
        return new Response('spa', { headers: { 'content-type': 'text/html' } });
      },
    },
  }) as unknown as AppEnv;

const app = createApp({ stores: fakeAuth(ORIGIN).stores });
const call = (path: string) => app.request(`${ORIGIN}${path}`, {}, appEnv());

describe('/developers/status', () => {
  it('is public: the page fills its slot from the platform checks and is cached for 30 seconds', async () => {
    const res = await call('/developers/status');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(STATUS_SLOT);
    expect(html).toContain('Apple push');
    expect(html).toContain('Webhook delivery');
    expect(res.headers.get('cache-control')).toBe('public, max-age=30');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('serves the same data as JSON, with only the public fields', async () => {
    const res = await call('/developers/status.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = (await res.json()) as { components: { id: string }[] };
    expect(body.components.map((c) => c.id)).toEqual([
      'api',
      'apple_push',
      'email',
      'webhooks',
      'google',
      'samsung',
    ]);
    expect(Object.keys(body).sort()).toEqual(['checkedAt', 'components', 'incidents', 'overall']);
  });
});
