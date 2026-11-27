import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';
import { useBlueprintWizard } from './helpers/blueprint-wizard.ts';
import { logoPng } from './helpers/png.ts';
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
  await expect(dialog.getByRole('region', { name: 'Plan' }).getByText('Premium')).toBeVisible();
  await look(page, 'org-3-review');
  await dialog.getByRole('button', { name: 'Create organization' }).click();
  await page.waitForURL((u) => /\/admin\/platform\/orgs\/[0-9a-f-]+$/.test(u.pathname));

  // The chosen plan is the one the org was saved on.
  const orgId = new URL(page.url()).pathname.split('/').pop();
  const admin = await apiAs('admin');
  try {
    const plan = await admin.get<{ preset: string }>(`/api/v1/platform/orgs/${orgId}/entitlements`);
    expect(plan.preset).toBe('premium');
  } finally {
    await admin.dispose();
  }
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
  // A colour on the Look step reaches Review; the org's own brand is left alone.
  await page.getByLabel('Custom colour').fill('#0f766e');
  // Stamps and currency show only where the blueprint offers them.
  const currency = page.getByRole('combobox', { name: 'Currency' });
  if (await currency.isVisible()) {
    await currency.click();
    await page.getByRole('option').last().click();
  }
  const forAll = page.getByRole('switch', { name: 'Use for all passes' });
  if (await forAll.isVisible()) {
    if ((await forAll.getAttribute('aria-checked')) === 'true') await forAll.click();
    await expect(forAll).not.toBeChecked();
  }
  await look(page, 'bp-2-look');
  await page.getByRole('button', { name: /^(Next|Review)$/ }).click();

  await expect(page.getByRole('heading', { name: 'Check and create' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Name' }).getByText(name)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Look' }).getByText('#0f766e')).toBeVisible();
  await look(page, 'bp-3-review');
  await page.getByRole('button', { name: 'Create template' }).click();
  await page.waitForURL((u) => /^\/admin\/o\/[^/]+\/templates\/[0-9a-f-]+$/.test(u.pathname));
  await expect(page.getByText('From Balance card')).toBeVisible();
});

test('Use blueprint: logo, Edit from Review, Open designer', async ({ page }) => {
  const seed = readSeed();
  const name = `Wizard logo ${uid('l')}`;
  await page.goto(`/admin/blueprints?orgId=${encodeURIComponent(seed.org.id)}`);
  await page.getByRole('button', { name: 'Use Balance card' }).click();
  await expect(page.getByRole('heading', { name: 'Name the template' })).toBeVisible();
  await page.getByRole('textbox', { name: /^Name/ }).fill(name);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Logo and colour' })).toBeVisible();

  await page.locator('input[type=file]').setInputFiles({
    name: 'brand.png',
    mimeType: 'image/png',
    buffer: logoPng(256, 256, [15, 118, 110]),
  });
  await expect(page.getByRole('button', { name: 'Remove logo' })).toBeVisible();
  // Nothing reaches the org's brand when the switch is off, so Review says so.
  const forAll = page.getByRole('switch', { name: 'Use for all passes' });
  if ((await forAll.isVisible()) && (await forAll.getAttribute('aria-checked')) === 'true')
    await forAll.click();
  await page.getByRole('button', { name: /^(Next|Review)$/ }).click();

  await expect(page.getByRole('heading', { name: 'Check and create' })).toBeVisible();
  const lookSection = page.getByRole('region', { name: 'Look' });
  await expect(lookSection.getByText('brand.png')).toBeVisible();
  await expect(page.getByText("Your choices here won't carry over to the designer.")).toBeVisible();

  // Edit from Review goes back to the step; Open designer carries the name.
  await page.getByRole('button', { name: 'Edit name' }).click();
  await expect(page.getByRole('heading', { name: 'Name the template' })).toBeVisible();
  await page.getByRole('textbox', { name: /^Name/ }).fill(`${name} 2`);
  await page.getByRole('button', { name: 'Open designer' }).click();
  await page.waitForURL((u) => /\/templates\/new$/.test(u.pathname));
});

test('Use blueprint: the shared helper makes the template', async ({ page }) => {
  const seed = readSeed();
  await page.goto(`/admin/blueprints?orgId=${encodeURIComponent(seed.org.id)}`);
  await page.getByRole('button', { name: 'Use Balance card' }).click();
  await useBlueprintWizard(page, `Wizard helper ${uid('h')}`);
  await page.waitForURL((u) => /^\/admin\/o\/[^/]+\/templates\/[0-9a-f-]+$/.test(u.pathname));
});
