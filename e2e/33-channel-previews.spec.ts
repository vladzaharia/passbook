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

const tabsOf = (scope: import('@playwright/test').Locator) =>
  scope.getByRole('radiogroup', { name: 'Channel' }).getByRole('radio');

test('the template page and the designer show unavailable channels as disabled tabs', async ({
  page,
}) => {
  const seed = readSeed();
  const org = encodeURIComponent(seed.org.id);
  const id = encodeURIComponent(seed.template.id);
  for (const [url, scope] of [
    [`/admin/o/${org}/templates/${id}`, column(page)],
    [`/admin/o/${org}/templates/${id}/design`, page.locator('.dz-stage')],
  ] as const) {
    await page.goto(url);
    const tabs = tabsOf(scope);
    await expect(tabs).toHaveCount(5);
    // Google, Samsung and Paper are not available for this organization here.
    for (const name of ['Google', 'Samsung', 'Paper']) {
      const off = tabs.filter({ hasText: name });
      await expect(off).toHaveAttribute('aria-disabled', 'true');
      await expect(off).not.toHaveAccessibleDescription('');
    }
    await expect(tabs.filter({ hasText: 'Apple' })).toBeChecked();
  }
});

test('a pass shows its channels that are off as disabled tabs with why', async ({ page }) => {
  const seed = readSeed();
  const api = await apiAs('admin');
  let passId: string;
  try {
    const pass = (await createPass(api, seed.org.id)) as { id: string };
    passId = pass.id;
    await api.send('PUT', `/api/v1/passes/${passId}/channels`, {
      channels: { mobile: 'off' },
      notify: false,
    });
  } finally {
    await api.dispose();
  }
  await page.goto(`/admin/o/${encodeURIComponent(seed.org.id)}/passes/${passId}`);
  const tabs = tabsOf(column(page));
  await expect(tabs).toHaveCount(5);
  await expect(tabs.filter({ hasText: 'Mobile' })).toHaveAttribute('aria-disabled', 'true');
  await expect(tabs.filter({ hasText: 'Mobile' })).toHaveAccessibleDescription('Off for this pass');
  await expect(tabs.filter({ hasText: 'Apple' })).not.toHaveAttribute('aria-disabled');
});
