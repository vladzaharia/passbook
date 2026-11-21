import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { signInHolder } from './helpers/holder.ts';
import { readSeed } from './helpers/seed.ts';

// An email link signs a holder in for holder features only; the console is Polaris ID (the mock OIDC) only.
test('an email-link session keeps holder features and meets the Polaris ID card on /admin', async ({
  page,
}) => {
  const admin = await apiAs('admin');
  const email = `${uid('strength')}@example.test`;
  try {
    await createPass(admin, readSeed().org.id, { email });
  } finally {
    await admin.dispose();
  }
  await signInHolder(page, email);
  await expect(page.getByRole('heading', { name: 'My passes' })).toBeVisible();

  const status = (path: string) => page.evaluate(async (url) => (await fetch(url)).status, path);
  expect(await status('/api/v1/me/passes')).toBe(200);
  const refused = await page.evaluate(async () => {
    const res = await fetch('/api/v1/orgs');
    return { status: res.status, body: await res.json() };
  });
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('IDP_SIGN_IN_REQUIRED');

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Sign in with Polaris ID' })).toBeVisible();
  const button = page.getByRole('link', { name: 'Sign in with Polaris ID' });
  await expect(button).toHaveAttribute('href', /^\/auth\/oidc\/start\?next=%2Fadmin/);
});
