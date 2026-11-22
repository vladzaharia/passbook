import { expect, test } from '@playwright/test';
import { uid } from './helpers/api.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

/** The public note row for one title on /developers/status. */
const publicNote = (page: import('@playwright/test').Page, title: string) =>
  page.locator('li.incident', { hasText: title });

test('an incident note opens in the console, shows on the public status page, and resolves', async ({
  page,
  browser,
}) => {
  // The public page is cached for 30 s, so each public check may wait out one window.
  test.setTimeout(180_000);
  const title = uid('Delayed pushes');
  const note = 'Apple push is slow. Passes still update.';

  await page.goto('/admin/status');
  await expect(page.getByRole('heading', { name: 'Public incident notes' })).toBeVisible();
  await page.getByRole('button', { name: 'Open note' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open incident note' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Note').fill(note);
  const opened = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/v1/status/incidents'),
  );
  await dialog.getByRole('button', { name: 'Publish' }).click();
  expect((await opened).status()).toBe(201);
  const row = page.locator('li', { hasText: title });
  await expect(row.getByRole('button', { name: 'Resolve' })).toBeVisible();

  // Anyone reads it: a signed-out visitor sees it open, with its note.
  const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const pub = await visitor.newPage();
  await expect(async () => {
    await pub.goto('/developers/status');
    await expect(publicNote(pub, title).locator('.pill')).toHaveText('Open', { timeout: 2_000 });
  }).toPass({ timeout: 70_000 });
  await expect(publicNote(pub, title)).toContainText(note);

  const resolved = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/status\/incidents\/[^/]+\/resolve$/.test(r.url()),
  );
  await row.getByRole('button', { name: 'Resolve' }).click();
  expect((await resolved).status()).toBe(200);
  await expect(row.getByRole('button', { name: 'Resolve' })).toHaveCount(0);
  await expect(row).toContainText('resolved');

  // The note is no longer open on the public page.
  await expect(async () => {
    await pub.goto('/developers/status');
    await expect(publicNote(pub, title).locator('.pill')).toHaveText('Resolved', {
      timeout: 2_000,
    });
  }).toPass({ timeout: 70_000 });
  await visitor.close();
});
