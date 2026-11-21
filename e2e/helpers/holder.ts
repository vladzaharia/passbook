import { expect, type Page } from '@playwright/test';
import { nextSignInMail, snapshotMail } from './mail.ts';
import { stubTurnstile } from './turnstile.ts';

/** Signs a holder in through the emailed magic link and lands on the portal. */
export async function signInHolder(page: Page, email: string) {
  await stubTurnstile(page);
  const before = snapshotMail();
  const sent = page.getByRole('heading', { name: 'Check your email' });
  // RL_LOGIN allows 10 requests a minute per IP, which a long run can use up: wait the window out.
  await expect
    .poll(
      async () => {
        await page.goto('/login');
        await page.getByLabel('Email').fill(email);
        await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
        await sent.or(page.getByText('Too many requests')).waitFor();
        return sent.isVisible();
      },
      { intervals: [8_000], timeout: 70_000 },
    )
    .toBe(true);
  const mail = await nextSignInMail(before);
  await page.goto(mail.link);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname === '/');
}
