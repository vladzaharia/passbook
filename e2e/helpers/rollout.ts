import type { Page } from '@playwright/test';

/**
 * Opens a template's Releases tab and waits for the rollout read. The tab is a lazy chunk and the
 * card has no placeholder, so on a cold server the read starts late; the card paints right after it.
 */
export async function gotoRollout(page: Page, url: string): Promise<void> {
  const read = page.waitForResponse(
    (r) => r.request().method() === 'GET' && /\/templates\/[^/]+\/rollout\?/.test(r.url()),
    { timeout: 60_000 },
  );
  await page.goto(url);
  await read;
}
