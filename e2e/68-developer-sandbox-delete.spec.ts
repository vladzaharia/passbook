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
  await startOidcAs(page, 'developer', '/workbench/quickstart');
  await page.waitForURL((u) => u.pathname === '/workbench/quickstart');
  await expect(page.getByRole('heading', { level: 1, name: 'Quickstart' })).toBeVisible();
  const create = page.getByRole('button', { name: 'Create sandbox' });
  // The sandbox step's Delete sandbox (the Workbench has no bar chip: the step carries the menu's actions).
  const del = page.locator('main').getByRole('button', { name: 'Delete sandbox' });
  await expect(create.or(del)).toBeVisible();
  if (await create.isVisible()) await create.click();
  // Making it is an operation now: its steps run, the key is minted, and Delete appears when it ends.
  await expect(del).toBeVisible({ timeout: 60_000 });

  await del.click();
  const confirm = page.getByRole('region', { name: 'Delete this sandbox?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeInViewport();
  await expect(confirm).toBeFocused();
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
  const started = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/developer/sandbox') && r.request().method() === 'DELETE',
  );
  await confirm.getByRole('button', { name: 'Delete sandbox' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Deleting your sandbox' })).toBeVisible();
  await shots(page, 'sandbox-delete-2-working');
  release();

  // The server answers 202 with an operation, and the confirm shows its steps: close, revoke, remove, erase.
  const response = await started;
  expect(response.status()).toBe(202);
  const { operation } = (await response.json()) as { operation: { id: string; kind: string } };
  expect(operation.kind).toBe('sandbox.delete');
  const steps = confirm.getByRole('list').getByRole('listitem');
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toContainText('Close sandbox');
  await expect(steps.nth(1)).toContainText('Revoke keys');
  await expect(steps.nth(2)).toContainText('Remove Test passes');
  await expect(steps.nth(3)).toContainText('Erase sandbox data');
  await expect(page).toHaveURL(new RegExp(`[?&]op=${operation.id}`));
  await shots(page, 'sandbox-delete-3-steps');

  // A reload brings the same panel back, whatever stage the delete has reached.
  await page.reload();
  const again = page.getByRole('region', { name: 'Delete this sandbox?' });
  await expect(again.getByRole('list').getByRole('listitem')).toHaveCount(4);

  // It ends: Done, with when the data is erased, and the way back to the first step.
  await expect(again.locator('[data-headline]')).toHaveText('Sandbox deleted', { timeout: 60_000 });
  await expect(again.getByText(/Data is erased by/)).toBeVisible();
  await expect(again.getByRole('list').getByRole('listitem').nth(3)).toContainText('By ');
  await shots(page, 'sandbox-delete-4-done');
  await again.getByRole('button', { name: 'Create sandbox' }).click();

  // The page reloads on the signed-in, no-sandbox quickstart: nothing of the sandbox is left.
  await expect(page.getByRole('button', { name: 'Create sandbox' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sandbox menu' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete sandbox' })).toHaveCount(0);
  const read = await page.evaluate(async () => {
    const res = await fetch('/api/v1/developer/sandbox');
    return ((await res.json()) as { sandbox: unknown }).sandbox;
  });
  expect(read).toBeNull();
  // The operation is the person's own: the same read says what ended.
  const ended = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/operations/${id}`);
    return (await res.json()) as { status: string; steps: { key: string; state: string }[] };
  }, operation.id);
  expect(ended.status).toBe('succeeded');
  expect(ended.steps.map((x) => [x.key, x.state])).toEqual([
    ['close', 'done'],
    ['keys', 'done'],
    ['passes', 'done'],
    ['erase', 'waiting'],
  ]);
  await shots(page, 'sandbox-delete-5-gone');
});
