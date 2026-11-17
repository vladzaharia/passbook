import { expect, type Page } from '@playwright/test';

/**
 * Opens a pairing link and presses Pair on the confirm card. Every spec pairs through here.
 * The e2e Worker runs RL_SCAN_PAIR at a limit no run reaches (vite.config.ts); production's 30 a
 * minute is covered by a worker test. A refused or failed preview is named in the failure, not
 * retried: the idle pairing form also shows a Pair button, so waiting on that button proves nothing.
 */
export async function pairScanner(page: Page, code: string, origin = '') {
  await page.goto(`${origin}/scan#pair=${encodeURIComponent(code)}`);
  const confirm = page.getByTestId('scan-pair-confirm');
  const refused = page.getByTestId('scan-pair').getByRole('alert');
  await expect(confirm.or(refused)).toBeVisible();
  await expect(refused, 'pairing preview was refused').toBeHidden();
  await confirm.getByRole('button', { name: 'Pair', exact: true }).click();
}
