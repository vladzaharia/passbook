import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';
import { shots } from './helpers/shots.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.setTimeout(180_000);

const VIEWS = [
  [1440, 900],
  [834, 1112],
  [390, 844],
] as const;

/** Every width and both themes: no serious or critical axe finding on the open step. */
async function clean(page: Page, step: string) {
  const before = page.viewportSize();
  for (const [width, height] of VIEWS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      const found = (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`);
      expect(found, `${step} at ${width} ${scheme}`).toEqual([]);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (before) await page.setViewportSize(before);
}

async function look(page: Page, name: string) {
  await page.waitForTimeout(400);
  await shots(page, name);
  await clean(page, name);
}

test('New organization: Basics, Plan, Review, then the org opens', async ({ page }) => {
  const name = `Wizard Org ${uid('w')}`;
  await page.goto('/admin/platform/orgs');
  await page.getByRole('button', { name: 'New organization' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New organization' });
  await expect(dialog.getByRole('heading', { name: 'Name it' })).toBeVisible();
  await look(page, 'org-1-basics');

  // A blocked Next shows the errors instead of moving.
  await dialog.getByRole('button', { name: 'Next' }).click({ force: true });
  await expect(dialog.getByText('Required.')).toBeVisible();
  await dialog.getByLabel('Name').fill(name);
  await expect(dialog.getByLabel('Slug')).not.toHaveValue('');
  await dialog.getByRole('button', { name: 'Next' }).click();

  await expect(dialog.getByRole('heading', { name: 'Pick a plan' })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Standard' })).toBeChecked();
  await dialog.getByRole('radio', { name: 'Premium' }).check({ force: true });
  await look(page, 'org-2-plan');
  await dialog.getByRole('button', { name: 'Next' }).click();

  await expect(dialog.getByRole('heading', { name: 'Check and create' })).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Basics' }).getByText(name)).toBeVisible();
  await look(page, 'org-3-review');
  await dialog.getByRole('button', { name: 'Create organization' }).click();
  await page.waitForURL((u) => /\/admin\/platform\/orgs\/[0-9a-f-]+$/.test(u.pathname));
});

test('Use blueprint: Name, Look, Review, then the template opens', async ({ page }) => {
  const seed = readSeed();
  const name = `Wizard card ${uid('b')}`;
  await page.goto(`/admin/blueprints?orgId=${encodeURIComponent(seed.org.id)}`);
  await page.getByRole('button', { name: 'Use Balance card' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Make it yours' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Name the template' })).toBeVisible();
  await look(page, 'bp-1-name');

  await page.getByRole('textbox', { name: /^Name/ }).fill(name);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Logo and colour' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).waitFor();
  await look(page, 'bp-2-look');
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByRole('heading', { name: 'Check and create' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Name' }).getByText(name)).toBeVisible();
  await look(page, 'bp-3-review');
  await page.getByRole('button', { name: 'Create template' }).click();
  await page.waitForURL((u) => /^\/admin\/o\/[^/]+\/templates\/[0-9a-f-]+$/.test(u.pathname));
  await expect(page.getByText('From Balance card')).toBeVisible();
});
