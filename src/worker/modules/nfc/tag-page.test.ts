import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppBindings } from '../../platform/context.ts';
import { tagPageRoutes } from './tag-page.ts';

describe('GET /t/{slug}', () => {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('nonce', 'n0nce');
    await next();
  });
  app.route('/t', tagPageRoutes);

  it('is static, uncached and names no one', async () => {
    const res = await app.request(
      '/t/door-1?p=EF963FF7828658A599F3041510671E88&m=94EED9EE65337086',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const html = await res.text();
    expect(html).toContain('Hold this tag to a PassBook scanner.');
    expect(html).not.toContain('94EED9EE65337086');
    expect(html).not.toContain('door-1');
    expect(html).not.toContain('EF963FF7');
  });

  it('leaks no referrer, sets no cookie, is not indexed', async () => {
    const res = await app.request(
      '/t/door-1?p=EF963FF7828658A599F3041510671E88&m=94EED9EE65337086',
    );
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('answers the same for a missing query', async () => {
    const a = await (await app.request('/t/x')).text();
    const b = await (await app.request('/t/y?p=1&m=2')).text();
    expect(a).toBe(b);
  });
});
