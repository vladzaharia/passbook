import { expect, type Page, test } from '@playwright/test';
import { apiAs, BASE, createPass } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/** Trusted Types breaks a DOM sink with a thrown TypeError and a securitypolicyviolation event. */
function watch(page: Page): () => Promise<string[]> {
  const found: string[] = [];
  page.on('console', (m) => {
    if (/trusted ?type|TrustedHTML|TrustedScript/i.test(m.text())) found.push(m.text());
  });
  page.on('pageerror', (e) => {
    if (/trusted ?type|TrustedHTML|TrustedScript/i.test(e.message)) found.push(e.message);
  });
  return async () => {
    const events = await page
      .evaluate(() => (window as unknown as { __tt?: string[] }).__tt ?? [])
      .catch(() => []);
    return [...found, ...events.filter((e) => /^require-trusted-types-for|^trusted-types/.test(e))];
  };
}

async function arm(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __tt: string[] }).__tt = seen;
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sample}`),
    );
  });
}

test.describe('admin', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });
  test('pages draw without a Trusted Types violation', async ({ page }) => {
    const org = encodeURIComponent(readSeed().org.id);
    const api = await apiAs('admin');
    const pass = await createPass(api, readSeed().org.id, { email: 'tt@example.test' });
    await api.dispose();
    await arm(page);
    const violations = watch(page);
    for (const path of [
      '/admin',
      `/admin/passes?orgId=${org}`,
      `/admin/passes/${pass.id}?orgId=${org}`,
      `/admin/templates?orgId=${org}`,
      '/admin/settings',
      '/admin/audit',
    ]) {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
    }
    expect(await violations()).toEqual([]);
  });
});

test('login loads the widget under the policy', async ({ page }) => {
  await arm(page);
  await stubTurnstile(page);
  const violations = watch(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(await violations()).toEqual([]);
});

test.describe('portal', () => {
  test.use({ storageState: 'e2e/.auth/user.json' });
  test('home draws without a Trusted Types violation', async ({ page }) => {
    await arm(page);
    const violations = watch(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'My passes' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await violations()).toEqual([]);
  });
});

test('the scanner document draws without a Trusted Types violation', async ({ page }) => {
  await arm(page);
  const violations = watch(page);
  await page.goto('/scan');
  await page.waitForLoadState('networkidle');
  expect(await violations()).toEqual([]);
});

test('the public pass and its barcode page save offline under the policy', async ({ page }) => {
  const admin = await apiAs('admin');
  const pass = await createPass(admin, readSeed().org.id, { holder: 'Trusted Types' });
  const detail = await admin.get(`/api/v1/passes/${pass.id}`);
  await admin.dispose();
  const publicPath = new URL(detail.publicUrl, BASE).pathname;
  await arm(page);
  const violations = watch(page);
  await page.goto(publicPath);
  await expect(page.locator('main')).toBeVisible();
  await page.goto(`${publicPath}/barcode`);
  const save = page.getByRole('button', { name: /save/i }).first();
  await expect(save).toBeVisible();
  await save.click();
  await expect(page.getByText('Saved on this device')).toBeVisible();
  expect(await violations()).toEqual([]);
});
