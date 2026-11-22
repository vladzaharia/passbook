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

test('the template page and the designer show unavailable channels as locked tabs', async ({
  page,
}) => {
  const seed = readSeed();
  const org = encodeURIComponent(seed.org.id);
  const id = encodeURIComponent(seed.template.id);
  // Google and Samsung are withheld for this organization; Paper is off on the template only,
  // so the designer, which edits every channel's design, keeps it open.
  for (const [url, scope, locked, open] of [
    [`/admin/o/${org}/templates/${id}`, column(page), ['Google', 'Samsung', 'Paper'], []],
    [
      `/admin/o/${org}/templates/${id}/design`,
      page.locator('.dz-stage'),
      ['Google', 'Samsung'],
      ['Paper'],
    ],
  ] as const) {
    await page.goto(url);
    const tabs = tabsOf(scope);
    await expect(tabs).toHaveCount(5);
    for (const name of locked) {
      const off = tabs.filter({ hasText: name });
      await expect(off).not.toHaveAttribute('aria-disabled', 'true');
      await expect(off).toHaveAttribute('title', /.+/);
    }
    // A locked tab opens a pane that names the level that stops it.
    await tabs.filter({ hasText: 'Google' }).click();
    await expect(scope.locator('[data-locked="passbook"]')).toContainText('PassBook stops it');
    for (const name of open) {
      await tabs.filter({ hasText: name }).click();
      await expect(scope.locator('[data-locked]')).toHaveCount(0);
    }
    await tabs.filter({ hasText: 'Apple' }).click();
    await expect(tabs.filter({ hasText: 'Apple' })).toBeChecked();
  }
});

test('a pass shows its channels that are off as locked tabs with why', async ({ page }) => {
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
  await expect(tabs.filter({ hasText: 'Mobile' })).toHaveAttribute('title', 'Off for this pass');
  await expect(tabs.filter({ hasText: 'Apple' })).not.toHaveAttribute('title', /.+/);
  await tabs.filter({ hasText: 'Mobile' }).click();
  await expect(column(page).locator('[data-locked="pass"]')).toContainText('This pass stops it');
  // The pass card's chain ends in This pass, and Use template drops its own choice.
  await page.getByRole('tab', { name: 'Holder' }).click();
  await expect(page.getByRole('list', { name: 'Chain' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use template', exact: true })).toBeVisible();
});
