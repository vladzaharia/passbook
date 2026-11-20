import { expect, test } from '@playwright/test';
import { apiAs, createPass } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

const column = (page: import('@playwright/test').Page) =>
  page.locator('aside[aria-label="Pass preview"]');

test('a blueprint previews Apple, Google, Samsung, Mobile and Paper from sample data', async ({
  page,
}) => {
  const seed = readSeed();
  const org = encodeURIComponent(seed.org.id);
  await page.goto(`/admin/o/${org}/blueprints/${encodeURIComponent('baked:starter-event-ticket')}`);
  const stage = column(page);
  await expect(stage.getByRole('radiogroup', { name: 'Channel' }).getByRole('radio')).toHaveText([
    'Apple',
    'Google',
    'Samsung',
    'Mobile',
    'Paper',
  ]);

  await stage.getByRole('radio', { name: 'Google', exact: true }).click();
  await expect(stage.getByTestId('google-preview')).toContainText('Sample Event');
  await expect(stage.getByText('Google Wallet draws the real card.')).toBeVisible();
  await expect(stage.getByTestId('fidelity-notes')).toBeVisible();

  await stage.getByRole('radio', { name: 'Samsung', exact: true }).click();
  await expect(stage.getByTestId('samsung-preview')).toContainText('Sample Event');

  await stage.getByRole('radio', { name: 'Mobile', exact: true }).click();
  const phone = stage.frameLocator('iframe[title="Mobile ticket preview"]');
  await expect(phone.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(phone.getByRole('link', { name: /Apple Wallet/ })).toBeVisible();
});

test('the template page and the designer share the switcher', async ({ page }) => {
  const seed = readSeed();
  const org = encodeURIComponent(seed.org.id);
  const id = encodeURIComponent(seed.template.id);
  await page.goto(`/admin/o/${org}/templates/${id}`);
  await column(page).getByRole('radio', { name: 'Google', exact: true }).click();
  await expect(column(page).getByTestId('google-preview')).toBeVisible();

  await page.goto(`/admin/o/${org}/templates/${id}/design`);
  const stage = page.locator('.dz-stage');
  await stage.getByRole('radio', { name: 'Samsung', exact: true }).click();
  await expect(stage.getByTestId('samsung-preview')).toBeVisible();
  // The Paper tab keeps its place in the same switcher.
  await stage.getByRole('radio', { name: 'Paper', exact: true }).click();
  await expect(page.getByTestId('designer-paper')).toBeVisible();
});

test('a pass previews only its effective channels and says why the others are off', async ({
  page,
}) => {
  const seed = readSeed();
  const api = await apiAs('admin');
  let passId: string;
  try {
    const pass = (await createPass(api, seed.org.id)) as { id: string };
    passId = pass.id;
    await api.send('PUT', `/api/v1/passes/${passId}/channels`, {
      channels: { google: 'off' },
      notify: false,
    });
  } finally {
    await api.dispose();
  }
  await page.goto(`/admin/o/${encodeURIComponent(seed.org.id)}/passes/${passId}`);
  const stage = column(page);
  // Samsung and Paper are off for the organization here; Google is this pass's own override.
  await expect(stage.getByRole('radiogroup', { name: 'Channel' }).getByRole('radio')).toHaveText([
    'Apple',
    'Mobile',
  ]);
  await expect(
    stage.getByRole('region', { name: 'Off for this pass' }).getByText(/^Google Wallet:/),
  ).toBeVisible();
});
