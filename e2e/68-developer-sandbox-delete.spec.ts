import { expect, test } from '@playwright/test';
import { startOidcAs } from './helpers/auth.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

/**
 * The developer role's sandbox is made here if no earlier spec made it; a spec that deletes it leaves none.
 * Delete's panel moves into the Workbench's Sandbox area (T8, a placeholder today): until it lands this
 * drives the same server contract from the Workbench Quickstart's session, and T8 restores the UI steps.
 */
test('Delete sandbox answers 202 with its four steps, ends, and leaves no sandbox', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await stubTurnstile(page);
  await startOidcAs(page, 'developer', '/workbench/quickstart');
  await page.waitForURL((u) => u.pathname === '/workbench/quickstart');
  await expect(page.getByRole('heading', { level: 1, name: 'Your first pass' })).toBeVisible();
  const create = page.getByRole('button', { name: 'Create sandbox' });
  const made = page.getByRole('radio', { name: 'Run here' });
  await expect(create.or(made).first()).toBeVisible();
  if (await create.isVisible()) await create.click();
  await expect(page.locator('.qs-env-v').or(made).first()).toBeVisible({ timeout: 60_000 });

  const started = await page.evaluate(async () => {
    const session = (await (await fetch('/api/v1/session')).json()) as { csrfToken: string };
    const res = await fetch('/api/v1/developer/sandbox', {
      method: 'DELETE',
      headers: { 'x-csrf-token': session.csrfToken },
    });
    return {
      status: res.status,
      body: (await res.json()) as { operation: { id: string; kind: string } },
    };
  });
  expect(started.status).toBe(202);
  const { operation } = started.body;
  expect(operation.kind).toBe('sandbox.delete');

  // It ends, and the sandbox is gone from the person's own read.
  await expect
    .poll(
      async () =>
        page.evaluate(async (id) => {
          const res = await fetch(`/api/v1/operations/${id}`);
          return ((await res.json()) as { status: string }).status;
        }, operation.id),
      { timeout: 60_000 },
    )
    .toBe('succeeded');
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
