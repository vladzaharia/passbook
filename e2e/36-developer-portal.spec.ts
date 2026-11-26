import { expect, test } from '@playwright/test';

/** Needs the prerendered portal: `WALLET_E2E_PREVIEW=1` (tools/e2e-server.ts builds it). */

test.describe('portal routes', () => {
  test('a page that does not exist is the portal 404, not problem+json', async ({ request }) => {
    const res = await request.get('/developers/nope');
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type']).toContain('text/html');
    expect(res.headers()['x-robots-tag']).toBe('noindex, nofollow');
    expect(await res.text()).toContain('Page not found');
  });

  test('the 404 page has the portal chrome and a way back', async ({ page }) => {
    const res = await page.goto('/developers/nope');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page.locator('main').getByRole('link', { name: 'Developers home' })).toBeVisible();
  });

  test('a file that does not exist keeps problem+json', async ({ request }) => {
    const res = await request.get('/developers/nope.md');
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type']).toContain('application/problem+json');
  });

  test('a trailing slash and a wrong-case code redirect with a 308', async ({ request }) => {
    const moves = [
      ['/developers/', '/developers'],
      ['/developers/reference/passes/?x=1', '/developers/reference/passes?x=1'],
      ['/developers/errors/invalid_input', '/developers/errors/INVALID_INPUT'],
    ] as const;
    for (const [from, to] of moves) {
      const res = await request.get(from, { maxRedirects: 0 });
      expect(res.status(), from).toBe(308);
      const location = new URL(res.headers().location ?? '', 'http://x');
      expect(location.pathname + location.search, from).toBe(to);
    }
  });

  test('every page has a markdown twin', async ({ request }) => {
    for (const path of [
      '/developers/index.md',
      '/developers/quickstart.md',
      '/developers/errors.md',
      '/developers/errors/INVALID_INPUT.md',
      '/developers/webhooks.md',
      '/developers/changelog.md',
      '/developers/reference/protocols.md',
      '/developers/guides.md',
    ]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()['content-type'], path).toContain('text/markdown');
    }
  });

  test('error rows carry their HTTP status', async ({ page }) => {
    await page.goto('/developers/errors');
    const row = page.locator('table.errs tr', { hasText: 'INVALID_INPUT' });
    await expect(row.locator('td').nth(1)).toHaveText(/^\d{3}$/);
    await page.goto('/developers/errors/INVALID_INPUT');
    await expect(page.locator('.eyebrow .pill').first()).toHaveText(/^\d{3}$/);
  });
});

test('an old operation anchor lands on the operation page', async ({ page }) => {
  await page.goto('/developers/reference/passes#create');
  await page.waitForURL('**/developers/reference/passes/create');
  await expect(page.getByRole('heading', { level: 1, name: 'Create a pass' })).toBeVisible();
});

test.describe('reference pages at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('none scrolls sideways', async ({ page }) => {
    await page.goto('/developers/reference');
    const hrefs = await page
      .locator('main a[href^="/developers/reference/"]')
      .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
    const paths = [
      ...new Set([
        ...hrefs,
        '/developers/reference/protocols',
        '/developers/reference/passes/create',
        '/developers/reference/templates/retrieveinputschema',
      ]),
    ];
    expect(paths.length).toBeGreaterThan(10);
    const wide: string[] = [];
    for (const path of paths) {
      await page.goto(path);
      const [scroll, client] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      if (scroll > client) wide.push(`${path}: ${scroll} > ${client}`);
    }
    expect(wide).toEqual([]);
  });
});
