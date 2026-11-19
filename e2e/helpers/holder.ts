import { expect, type Page } from '@playwright/test';
import { nextSignInMail, snapshotMail } from './mail.ts';
import { stubTurnstile } from './turnstile.ts';

/** Signs a holder in through the emailed magic link and lands on the portal. */
export async function signInHolder(page: Page, email: string) {
  await stubTurnstile(page);
  const before = snapshotMail();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const mail = await nextSignInMail(before);
  await page.goto(mail.link);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname === '/');
}
