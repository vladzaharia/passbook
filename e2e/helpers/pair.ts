import { expect, type Page } from '@playwright/test';

/**
 * RL_SCAN_PAIR allows 30 pair calls a minute per IP and is enforced locally too, and one serial run
 * pairs many devices. A refused preview shows an error and no Pair button, so reload until the
 * window reopens instead of waiting on a button that never comes.
 */
export async function pairScanner(page: Page, code: string) {
  const pair = page.getByRole('button', { name: 'Pair', exact: true });
  await expect
    .poll(
      async () => {
        await page.goto('about:blank');
        await page.goto(`/scan#pair=${code}`);
        return await pair.waitFor({ state: 'visible', timeout: 15_000 }).then(
          () => true,
          () => false,
        );
      },
      { intervals: [1_000], timeout: 80_000 },
    )
    .toBe(true);
  await pair.click();
}
