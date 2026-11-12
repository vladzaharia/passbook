import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

test('remove from Wallet, check the sync log, then restore', async ({ page }) => {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const pass = await createPass(admin, orgId, { holder: `Remove ${uid('R')}` });

  await page.goto(`/admin/passes/${pass.id}?orgId=${encodeURIComponent(orgId)}`);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove from Wallet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove from Wallet?' });
  await dialog.getByLabel('Message for holders (optional)').fill('This pass has ended.');
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Pass removed from Wallet')).toBeVisible();
  await expect(page.getByText(/^Removed from Wallet on /)).toBeVisible();

  const removed = await admin.get(`/api/v1/passes/${pass.id}`);
  expect(removed.removedAt).not.toBeNull();
  const log = await admin.get(`/api/v1/passes/${pass.id}/events?group=changes`);
  expect(log.items.map((e: { kind: string }) => e.kind)).toContain('pass.removed');

  // The header and the Fields callout both offer Restore; they run the same action.
  await page
    .getByRole('tabpanel', { name: 'Fields' })
    .getByRole('button', { name: 'Restore', exact: true })
    .click();
  await expect(page.getByText('Pass restored')).toBeVisible();
  const restored = await admin.get(`/api/v1/passes/${pass.id}`);
  expect(restored.removedAt).toBeNull();
  expect(restored.status).toBe('active');

  await admin.dispose();
});
