import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { nextSignInMail, snapshotMail } from './helpers/mail.ts';
import { readSeed } from './helpers/seed.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

test('magic link: sign in, see the linked pass, refresh, remove, and 6-digit code sign-in', async ({
  page,
}) => {
  const admin = await apiAs('admin');
  const email = `${uid('holder')}@example.test`;
  const holder = `Linked ${uid('H')}`;
  const pass = await createPass(admin, readSeed().org.id, { holder, email });
  await stubTurnstile(page);

  async function requestLink() {
    const before = snapshotMail();
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(page.getByRole('heading', { name: 'Enter the code' })).toBeVisible();
    return nextSignInMail(before);
  }

  // Link path: the confirm page needs a click, then the portal lists the pass.
  const mail = await requestLink();
  expect(mail.code).toMatch(/^\d{6}$/);
  await page.goto(mail.link);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname === '/');
  await expect(page.getByRole('link', { name: holder, exact: true })).toBeVisible();

  // Link is single use.
  await page.context().clearCookies();
  await page.goto(mail.link);
  await expect(page.getByRole('heading', { name: 'Link expired' })).toBeVisible();

  // Force refresh: pending, then done.
  const again = await requestLink();
  await page.goto(again.link);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname === '/');
  const tile = page.getByRole('listitem').filter({ hasText: holder });
  await tile.getByRole('button', { name: 'Refresh' }).click();
  await expect(tile.getByRole('button', { name: /Refreshing|Refresh in \d+s/ })).toBeVisible();
  await expect(page.getByText('Pass updated')).toBeVisible({ timeout: 30_000 });
  const mine = await page.evaluate(async () => (await fetch('/api/v1/me/passes')).json());
  const row = mine.items.find((p: { id: string }) => p.id === pass.id);
  expect(row.lastRefreshedAt).toBeGreaterThanOrEqual(row.refreshRequestedAt);

  // Remove from my passes.
  await tile.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Remove from My passes' }).click();
  await page
    .getByRole('alertdialog', { name: 'Remove from my passes?' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.getByText('No passes', { exact: true })).toBeVisible();

  // Sign out, then sign in again with the 6-digit code from the same browser.
  await page.context().clearCookies();
  const before = snapshotMail();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Enter the code' })).toBeVisible();
  const second = await nextSignInMail(before);
  await page.getByLabel('Code', { exact: true }).fill(second.code as string);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => u.pathname === '/');
  // The removed pass does not come back.
  await expect(page.getByText('No passes', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: holder, exact: true })).toHaveCount(0);
  await admin.dispose();
});
