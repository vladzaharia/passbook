import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { API_VERSIONS, apiVersionGate, atLeast, pinnedVersion } from './api-version.ts';
import type { AppBindings } from './context.ts';
import { handleError } from './error-handler.ts';

const app = new Hono<AppBindings>();
app.onError((e, c) => handleError(e, c) as Response);
app.get('/', (c) => c.json({ pinned: pinnedVersion(c), new: atLeast(c, '2026-11-20') }));
const get = (headers: Record<string, string> = {}) => app.request('/', { headers });

describe('PassBook-Version', () => {
  it('lists the first dated version', () => {
    expect(API_VERSIONS).toContain('2026-11-20');
  });

  it('selects the dated behaviour only when pinned to it', async () => {
    expect(await (await get()).json()).toEqual({ pinned: null, new: false });
    expect(await (await get({ 'PassBook-Version': '2026-11-20' })).json()).toEqual({
      pinned: '2026-11-20',
      new: true,
    });
  });

  it('refuses a date that is not listed', async () => {
    const res = await get({ 'PassBook-Version': '2026-01-01' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('API_VERSION_UNKNOWN');
  });

  it('refuses an unlisted date in middleware, before the handler writes', async () => {
    let ran = false;
    const gated = new Hono<AppBindings>();
    gated.onError((e, c) => handleError(e, c) as Response);
    gated.use('*', apiVersionGate);
    gated.post('/', (c) => {
      ran = true;
      return c.json({});
    });
    const post = (headers: Record<string, string> = {}) =>
      gated.request('/', { method: 'POST', headers });
    const res = await post({ 'PassBook-Version': '2026-01-01' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('API_VERSION_UNKNOWN');
    expect(ran).toBe(false);
    expect((await post({ 'PassBook-Version': '2026-11-22' })).status).toBe(200);
    expect(ran).toBe(true);
  });

  it('is wired ahead of every /api/v1 route', async () => {
    const { createApp } = await import('../app.ts');
    const res = await createApp().request(
      'https://wallet.test/api/v1/passes',
      { headers: { 'PassBook-Version': '2026-01-01' } },
      env,
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('API_VERSION_UNKNOWN');
  });
});
