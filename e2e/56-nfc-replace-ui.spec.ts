import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';
import { stateFile } from './helpers/auth.ts';
import { readSeed } from './helpers/seed.ts';
import { shots } from './helpers/shots.ts';

const META = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const KEY = '0123456789abcdef0123456789abcdef';

test('the import dialog offers replace: dry run count, then a confirm that says what stops working', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const context = await browser.newContext({
    storageState: stateFile('admin'),
    reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    const orgId = readSeed().org.id;
    const made = await api.send('POST', `/api/v1/nfc/keysets?orgId=${orgId}`, {
      name: uid('Own keys').slice(0, 40),
      perTag: true,
      metaKey: META,
    });
    const csv = `uid,key\n04ab0000000001,${KEY}\n`;
    await api.send('POST', `/api/v1/nfc/keysets/${made.id}/import`, { csv, dryRun: false });

    await page.goto(`/admin/scanning?orgId=${orgId}&tab=tags&tagView=keys&keyset=${made.id}`);
    await page.getByRole('button', { name: 'Import tags', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /^Import tags to/ });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'tags.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    await dialog
      .getByRole('checkbox', { name: 'Replace keys for tags already on this keyset' })
      .click();
    await expect(dialog.getByText('1 of 1 rows will re-key a tag')).toBeVisible();
    await shots(page, 'nfc-replace-dialog');
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);

    await dialog.getByRole('button', { name: 'Re-key 1 tags' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Re-key 1 tag?' });
    await expect(confirm.getByText(/Taps with the old keys stop working/)).toBeVisible();
    await shots(page, 'nfc-replace-confirm');
    const axeConfirm = await new AxeBuilder({ page }).analyze();
    expect(axeConfirm.violations).toEqual([]);
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
  } finally {
    await context.close();
    await api.dispose();
  }
});
