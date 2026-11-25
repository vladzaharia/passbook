import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { snapshotMail } from './helpers/mail.ts';

const PAGES = ['/', '/door', '/blueprints', '/build', '/access', '/access/sent'];

/** The text of every message that arrived after `before`. */
const newMail = (before: Set<string>) =>
  [...snapshotMail()].filter((f) => !before.has(f)).map((f) => readFileSync(f, 'utf8'));

async function fill(page: Page, org: string) {
  await page.getByLabel('Name').fill('Alex Morgan');
  await page.getByLabel('Work email').fill('alex@example.test');
  await page.getByLabel('Organization').fill(org);
  await page.getByLabel('What is the pass for?').selectOption('Memberships');
  await page.getByLabel('Message').fill('We run a climbing gym.');
}

test.describe('signed out', () => {
  test('/ is the home page and Sign in goes to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: /Memberships/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My passes' })).toHaveCount(0);
    await page.getByRole('banner').getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test('no request leaves the origin on any page', async ({ page }) => {
    const base = new URL(test.info().project.use.baseURL ?? '').origin;
    const foreign: string[] = [];
    page.on('request', (r) => {
      const url = new URL(r.url());
      if (url.protocol.startsWith('http') && url.origin !== base) foreign.push(r.url());
    });
    for (const path of PAGES) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
    }
    expect(foreign).toEqual([]);
  });

  test('the pages are indexable and /access/sent is not', async ({ request }) => {
    for (const path of PAGES.slice(0, 5)) {
      const res = await request.get(path);
      expect(res.headers()['x-robots-tag'], path).toBe('index, follow');
    }
    expect((await request.get('/access/sent')).headers()['x-robots-tag']).toContain('noindex');
    expect((await request.get('/marketing/door')).status()).toBe(404);
    const sitemap = await request.get('/sitemap.xml');
    expect(await sitemap.text()).toContain('/blueprints');
  });

  for (const motion of ['no-preference', 'reduce'] as const) {
    test.describe(`request access, motion ${motion}`, () => {
      test.use({ reducedMotion: motion });

      test('sends the request and shows the sent state', async ({ page }) => {
        const org = `Northside ${motion} ${Date.now()}`;
        const before = snapshotMail();
        await page.goto('/access');
        await fill(page, org);
        await page.getByRole('button', { name: 'Send request' }).click();
        await expect(page.getByRole('heading', { name: 'Request sent.' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Send request' })).toBeHidden();
        await expect.poll(() => newMail(before).some((m) => m.includes(org))).toBe(true);
      });
    });
  }

  test('a failed send shows the error line and keeps the form', async ({ page }) => {
    await page.route('**/access', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 503, contentType: 'application/problem+json', body: '{}' })
        : route.continue(),
    );
    await page.goto('/access');
    await fill(page, 'Northside Climbing');
    await page.getByRole('button', { name: 'Send request' }).click();
    await expect(
      page.getByText('Your request was not sent. Email support@passbook.mobile.'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Request sent.' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Send request' })).toBeVisible();
  });

  test('invalid fields are named and nothing is sent', async ({ page }) => {
    let posted = false;
    page.on('request', (r) => {
      if (r.method() === 'POST') posted = true;
    });
    await page.goto('/access');
    await page.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByText('Enter your name.')).toBeVisible();
    expect(posted).toBe(false);
  });

  test.describe('without script', () => {
    test.use({ javaScriptEnabled: false });
    test('the form posts and lands on the sent page', async ({ page }) => {
      const org = `Plain ${Date.now()}`;
      const before = snapshotMail();
      await page.goto('/access');
      await fill(page, org);
      await page.getByRole('button', { name: 'Send request' }).click();
      await expect(page).toHaveURL(/\/access\/sent$/);
      await expect(page.getByRole('heading', { name: 'Request sent.' })).toBeVisible();
      await expect.poll(() => newMail(before).some((m) => m.includes(org))).toBe(true);
    });
  });
});

test.describe('signed in', () => {
  test.use({ storageState: 'e2e/.auth/user.json' });
  test('/ is My passes, not the home page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'My passes' })).toBeVisible();
  });
});
