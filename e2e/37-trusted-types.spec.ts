import { expect, type Page, test } from '@playwright/test';
import { apiAs, BASE, createPass, uid } from './helpers/api.ts';
import { ANDROID_CHROME } from './helpers/devices.ts';
import { signInHolder } from './helpers/holder.ts';
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

test('the public site draws under its own policy', async ({ page }) => {
  await arm(page);
  const violations = watch(page);
  for (const path of ['/', '/door', '/blueprints', '/build', '/access', '/access/sent']) {
    await page.goto(path);
    await expect(page.getByRole('main')).toBeVisible();
    await page.waitForLoadState('networkidle');
  }
  expect(await violations()).toEqual([]);
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

test('Save to this phone works on /p under the policy, and the door view needs no sink', async ({
  browser,
}) => {
  const admin = await apiAs('admin');
  const pass = await createPass(admin, readSeed().org.id, { holder: 'Trusted Types' });
  const detail = await admin.get(`/api/v1/passes/${pass.id}`);
  await admin.dispose();
  const publicPath = new URL(detail.publicUrl, BASE).pathname;
  const ctx = await browser.newContext({ userAgent: ANDROID_CHROME });
  const page = await ctx.newPage();
  await arm(page);
  const violations = watch(page);
  await page.goto(publicPath);
  await page.getByRole('link', { name: 'Save to this phone' }).first().click();
  await expect(page.getByText('On this phone · Works offline')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('link', { name: 'Show at the door' }).first().click();
  await expect(page.getByText('Works offline')).toBeVisible();
  expect(await violations()).toEqual([]);
  await ctx.close();
});

test('Save to this phone works in the portal under the policy', async ({ browser }) => {
  const admin = await apiAs('admin');
  const email = `${uid('tt')}@example.test`;
  const pass = await createPass(admin, readSeed().org.id, { holder: 'Trusted Types', email });
  await admin.dispose();
  const ctx = await browser.newContext({ userAgent: ANDROID_CHROME });
  const page = await ctx.newPage();
  await arm(page);
  const violations = watch(page);
  await signInHolder(page, email);
  await page.goto(`/passes/${pass.id}`);
  // The portal loads the save logic lazily; before it wires the host the lead is a plain link to the door view.
  await expect(page.locator('[data-save-phone][data-save-ready]').first()).toBeAttached();
  await page.getByRole('link', { name: 'Save to this phone' }).first().click();
  await expect(page.getByText('On this phone · Works offline')).toBeVisible();
  expect(await violations()).toEqual([]);
  await ctx.close();
});

test('Save to this phone works on a bundle member page under the policy', async ({ browser }) => {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const a = await createPass(admin, orgId, { holder: 'Trusted Bundle A' });
  const b = await createPass(admin, orgId, { holder: 'Trusted Bundle B' });
  const bundle = await admin.send('POST', '/api/v1/bundles', {
    orgId,
    passIds: [a.id, b.id],
    name: 'Trusted Types',
  });
  await admin.dispose();
  const path = new URL(bundle.url, BASE).pathname;
  const ctx = await browser.newContext({ userAgent: ANDROID_CHROME });
  const page = await ctx.newPage();
  await arm(page);
  const violations = watch(page);
  await page.goto(`${path}/${a.id}`);
  await page.getByRole('link', { name: 'Save to this phone' }).first().click();
  await expect(page.getByText('On this phone · Works offline')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('link', { name: 'Show at the door' }).first().click();
  await expect(page.getByText('Works offline')).toBeVisible();
  expect(await violations()).toEqual([]);
  await ctx.close();
});
