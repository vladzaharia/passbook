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
  await expect(stage.getByTestId('google-report')).toBeVisible();

  await stage.getByRole('radio', { name: 'Samsung', exact: true }).click();
  await expect(stage.getByTestId('samsung-preview')).toContainText('Sample Event');

  await stage.getByRole('radio', { name: 'Mobile', exact: true }).click();
  const phone = stage.frameLocator('iframe[title="Mobile ticket preview"]');
  await expect(phone.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(phone.getByRole('link', { name: /Apple Wallet/ })).toBeVisible();
});

const tabsOf = (scope: import('@playwright/test').Locator) =>
  scope.getByRole('radiogroup', { name: 'Channel' }).getByRole('radio');

test('the template page and the designer hide withheld channels and keep template offs', async ({
  page,
}) => {
  const seed = readSeed();
  const org = encodeURIComponent(seed.org.id);
  const id = encodeURIComponent(seed.template.id);
  // PassBook withholds Google and Samsung here: no tab. Paper is off on the template only, a quiet
  // tab on the template page; the designer, which edits every channel's design, keeps it open.
  for (const [url, scope, off] of [
    [`/admin/o/${org}/templates/${id}`, column(page), true],
    [`/admin/o/${org}/templates/${id}/design`, page.locator('.dz-stage'), false],
  ] as const) {
    await page.goto(url);
    const tabs = tabsOf(scope);
    await expect(tabs).toHaveText(['Apple', 'Mobile', /^Paper/]);
    const paper = tabs.filter({ hasText: 'Paper' });
    await paper.click();
    await expect(paper).toBeChecked();
    if (off) {
      await expect(paper).toHaveAttribute('data-off', '');
      await expect(paper).toHaveAccessibleDescription('Off for this template');
      // The off tab opens a pane that says why and links to where it turns back on.
      await expect(scope.locator('[data-locked="template"]')).toContainText(
        'Off for this template',
      );
    } else {
      await expect(paper).not.toHaveAttribute('data-off');
      await expect(scope.locator('[data-locked]')).toHaveCount(0);
    }
    await tabs.filter({ hasText: 'Apple' }).click();
    await expect(tabs.filter({ hasText: 'Apple' })).toBeChecked();
  }
});

test('a pass shows its channels that are off as quiet tabs with why', async ({ page }) => {
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
  await expect(tabs).toHaveCount(3);
  await expect(tabs.filter({ hasText: 'Mobile' })).toHaveAccessibleDescription('Off for this pass');
  await expect(tabs.filter({ hasText: 'Apple' })).not.toHaveAttribute('data-off');
  await tabs.filter({ hasText: 'Mobile' }).click();
  await expect(column(page).locator('[data-locked="pass"]')).toContainText('Off for this pass');
  // The pass card's chain ends in This pass, and Use template drops its own choice.
  await page.getByRole('tab', { name: 'Holder' }).click();
  await expect(page.getByRole('list', { name: 'Chain' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use template', exact: true })).toBeVisible();
});
