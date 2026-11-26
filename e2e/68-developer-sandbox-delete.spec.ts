import { expect, test } from '@playwright/test';
import { startOidcAs } from './helpers/auth.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/** The developer role's sandbox is made here if no earlier spec made it; a spec that deletes it leaves none. */
test("Delete sandbox from the switcher's Danger group confirms, runs through the tray, and leaves no sandbox", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await stubTurnstile(page);
  await startOidcAs(page, 'developer', '/workbench/quickstart');
  await page.waitForURL((u) => u.pathname === '/workbench/quickstart');
  const create = page.getByRole('button', { name: 'Create sandbox' });
  const switcher = page.getByRole('button', { name: /Sandbox · Test\s*, Switch context$/ });
  await expect(create.or(switcher).first()).toBeVisible();
  if (await create.isVisible()) await create.click();
  // Making it is an operation: its steps run, the key is minted, and the switcher names the sandbox when it ends.
  await expect(switcher).toBeVisible({ timeout: 60_000 });

  await switcher.click();
  await expect(page.getByRole('menu').getByText('Danger')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Delete sandbox' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete this sandbox?' });
  await expect(confirm).toBeVisible();
  await shots(page, 'sandbox-delete-1-confirm');

  const started = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/developer/sandbox') && r.request().method() === 'DELETE',
  );
  await confirm.getByRole('button', { name: 'Delete sandbox' }).click();

  // The server answers 202 with an operation; the tray carries its steps: close, revoke, remove, erase.
  const response = await started;
  expect(response.status()).toBe(202);
  const { operation } = (await response.json()) as { operation: { id: string; kind: string } };
  expect(operation.kind).toBe('sandbox.delete');
  await expect(confirm).toBeHidden();

  // It ends and the Workbench reloads on the chooser: nothing of the sandbox is left.
  await page.waitForURL((u) => u.pathname === '/workbench', { timeout: 60_000 });
  await expect(
    page.getByRole('button', { name: /Sandbox · Test\s*, Switch context$/ }),
  ).toHaveCount(0);
  const read = await page.evaluate(async () => {
    const res = await fetch('/api/v1/developer/sandbox');
    return ((await res.json()) as { sandbox: unknown }).sandbox;
  });
  expect(read).toBeNull();
  const ended = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/operations/${id}`);
    return (await res.json()) as { steps: { key: string; state: string }[] };
  }, operation.id);
  expect(ended.steps.map((x) => [x.key, x.state])).toEqual([
    ['close', 'done'],
    ['keys', 'done'],
    ['passes', 'done'],
    ['erase', 'waiting'],
  ]);
});
