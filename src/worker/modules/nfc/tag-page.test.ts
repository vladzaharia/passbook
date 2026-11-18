import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { tagPageRoutes } from './tag-page.ts';

describe('GET /t/{slug}', () => {
  const app = new Hono();
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
  });
});
