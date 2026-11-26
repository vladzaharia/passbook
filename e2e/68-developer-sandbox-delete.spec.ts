import { expect, test } from '@playwright/test';
import { startOidcAs } from './helpers/auth.ts';
import { shots } from './helpers/shots.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/** The developer role's sandbox is made here if no earlier spec made it; a spec that deletes it leaves none. */
test('Delete sandbox from the chip menu while on the quickstart opens the confirm, works, and leaves no sandbox', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await stubTurnstile(page);
  await startOidcAs(page, 'developer', '/developers/quickstart');
  await page.waitForURL((u) => u.pathname === '/developers/quickstart');
  await expect(page.getByRole('heading', { level: 1, name: 'Your first pass' })).toBeVisible();
  const create = page.getByRole('button', { name: 'Create sandbox' });
  const chip = page.locator('summary.orgchip-head');
  await expect(create.or(chip)).toBeVisible();
  if (await create.isVisible()) await create.click();
  await expect(chip).toBeVisible();
  // The confirm is far down the page: hold the scroll at the top to prove the menu brings it into view.
  await page.evaluate(() => window.scrollTo(0, 0));

  await chip.click();
  await page.getByRole('link', { name: 'Delete sandbox' }).click();
  const confirm = page.getByRole('region', { name: 'Delete this sandbox?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeInViewport();
  await expect(confirm).toBeFocused();
  await expect(chip.locator('xpath=..')).not.toHaveAttribute('open', '');
  await shots(page, 'sandbox-delete-1-confirm');

  // Hold the delete so the working state can be seen.
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/api/v1/developer/sandbox', async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    await held;
    return route.fallback();
  });
  await confirm.getByRole('button', { name: 'Delete sandbox' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Deleting your sandbox' })).toBeVisible();
  await shots(page, 'sandbox-delete-2-working');
  release();

  // The page reloads on the signed-in, no-sandbox quickstart: nothing of the sandbox is left.
  await expect(page.getByRole('button', { name: 'Create sandbox' }).first()).toBeVisible();
  await expect(page.locator('summary.orgchip-head')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete sandbox' })).toHaveCount(0);
  const read = await page.evaluate(async () => {
    const res = await fetch('/api/v1/developer/sandbox');
    return ((await res.json()) as { sandbox: unknown }).sandbox;
  });
  expect(read).toBeNull();
  await shots(page, 'sandbox-delete-3-gone');
});
