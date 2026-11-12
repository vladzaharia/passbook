import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

test('a message sent now to one template reaches the pass back', async ({ page }) => {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const holder = `Message ${uid('M')}`;
  const pass = await createPass(admin, orgId, { holder });
  const text = `Doors open at 8. ${uid('T')}`;

  await page.goto(`/admin/messages/new?orgId=${orgId}`);
  const main = page.locator('main');
  await main.getByRole('checkbox', { name: 'PassBook · Generic', exact: true }).check();
  await main.getByRole('textbox', { name: 'Search' }).fill(holder);
  await expect(main.getByText('1 pass, 0 on a device.')).toBeVisible();
  await main.getByRole('textbox', { name: 'Message' }).fill(text);
  await main.getByRole('button', { name: 'Send now' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Send to 1 pass?' });
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();

  await page.waitForURL((u) => /^\/admin\/messages\/[0-9a-f-]+$/.test(u.pathname));
  const id = new URL(page.url()).pathname.split('/').pop() ?? '';
  await expect
    .poll(async () => (await admin.get(`/api/v1/broadcasts/${id}`)).state, { timeout: 30_000 })
    .toBe('sent');
  await expect(main.getByText('Completed', { exact: true }).first()).toBeVisible();
  const done = await admin.get(`/api/v1/broadcasts/${id}`);
  expect(done.counts).toMatchObject({ targeted: 1, updated: 1, failed: 0 });

  const detail = await admin.get(`/api/v1/passes/${pass.id}`);
  const back = detail.passJson.generic.backFields as { key: string; value: unknown }[];
  expect(back.find((f) => f.key === 'message')?.value).toBe(text);
  const log = await admin.get(`/api/v1/passes/${pass.id}/events?kind=message.applied`);
  expect(log.items).toHaveLength(1);

  await admin.dispose();
});
