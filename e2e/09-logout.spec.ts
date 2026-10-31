import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { signInAs } from './helpers/auth.ts';
import { nextSignInMail, snapshotMail } from './helpers/mail.ts';
import { readSeed } from './helpers/seed.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

async function expectSignedOut(page: import('@playwright/test').Page) {
  await expect
    .poll(() =>
      page.evaluate(async () => (await (await fetch('/api/v1/session')).json()).authenticated),
    )
    .toBe(false);
}

test('admin signs out and the revoked session no longer works', async ({ page, browser }) => {
  await signInAs(page, 'admin', '/admin');
  const cookies = await page.context().cookies();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/admin') || u.pathname === '/login');
  await expectSignedOut(page);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin/);

  // The old cookie is dead server-side, not just deleted in the browser.
  const replay = await browser.newContext();
  await replay.addCookies(cookies);
  const res = await replay.request.get('/api/v1/orgs');
  expect(res.status()).toBe(401);
  await replay.close();
});

test('portal user signs out', async ({ page }) => {
  const admin = await apiAs('admin');
  const email = `${uid('logout')}@example.test`;
  await createPass(admin, readSeed().org.id, { email });
  await admin.dispose();
  await stubTurnstile(page);

  const before = snapshotMail();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  const mail = await nextSignInMail(before);
  await page.goto(mail.link);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname === '/');
  await expect(page.getByRole('heading', { name: 'My passes' })).toBeVisible();

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await expectSignedOut(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});
