import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { type Api, apiAs, uid } from './helpers/api.ts';
import { logoPng } from './helpers/png.ts';
import { createOrgWithRoles } from './helpers/seed.ts';
import { shots } from './helpers/shots.ts';
import { requireE2eRelease } from './helpers/wallets.ts';

// CW8b: the designer's Wallets tab against the e2e release. Needs playwright.wallets.config.ts.
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

type Org = { id: string };
let admin: Api;
let org: Org;
let templateId = '';

/** The Store card with its balance tagged, so Samsung's title and balance read the same field. */
async function storeCard() {
  const made = await admin.send<{ id: string; versions: { version: string }[] }>(
    'POST',
    `/api/v1/templates/${encodeURIComponent('baked:starter-store-card')}/use`,
    { orgId: org.id, name: `Wallets ${uid('d')}` },
  );
  const v = await admin.get<{
    passJson: { storeCard: { primaryFields: Record<string, unknown>[] } };
    manifest: Record<string, unknown>;
    assets: { name: string; sha1: string }[];
  }>(`/api/v1/templates/${made.id}/versions/${made.versions[0]?.version}?orgId=${org.id}`);
  const passJson = structuredClone(v.passJson);
  const balance = passJson.storeCard.primaryFields[0];
  if (balance) balance.semantics = { balance: { amount: '25', currencyCode: 'USD' } };
  await admin.send('POST', `/api/v1/templates/${made.id}/versions?orgId=${org.id}`, {
    passJson,
    manifest: v.manifest,
    assets: v.assets.map(({ name, sha1 }) => ({ name, sha1 })),
  });
  return made.id;
}

/** Both wallets are open for this org: a template-level off is the one the tab keeps. */
async function openChannels(page: Page, off: ('google' | 'samsung')[] = []) {
  await page.route(`**/api/v1/templates/${templateId}/channels?*`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const wallet of ['google', 'samsung'] as const)
      body.effective[wallet] = off.includes(wallet)
        ? { on: false, source: 'template', reason: 'template_off' }
        : { on: true, source: 'template' };
    await route.fulfill({ response, json: body });
  });
}

const design = (query = '') =>
  `/admin/o/${encodeURIComponent(org.id)}/templates/${encodeURIComponent(templateId)}/design${query}`;
const rail = (page: Page) => page.getByRole('radiogroup', { name: 'Wallet' });
const report = (page: Page, wallet: 'Google' | 'Samsung') =>
  page.getByRole('region', { name: `${wallet} Wallet report` });
const section = (page: Page, name: string | RegExp) =>
  page.getByRole('button', { name, exact: typeof name === 'string' });

test.beforeAll(async () => {
  admin = await apiAs('admin');
  await requireE2eRelease(admin);
  org = await createOrgWithRoles(admin, {
    slug: uid('wd').toLowerCase(),
    name: 'Wallets designer',
  });
  templateId = await storeCard();
});

test('Wallets: suggestions, type, required, art, save and reload', async ({ page }) => {
  await openChannels(page);
  await page.goto(design('?mode=wallets&wallet=samsung'));
  await expect(page.getByRole('radio', { name: 'Wallets' })).toBeChecked();
  await expect(rail(page).getByRole('radio', { name: /^Samsung Wallet/ })).toBeChecked();
  await expect(page).toHaveURL(/mode=wallets&wallet=samsung/);
  await expect(report(page, 'Samsung')).toBeVisible();
  await shots(page, 'wallets-suggestions');

  // A title that shows twice suggests the organization name; nothing is written until Use.
  const use = page.getByRole('button', { name: /^Use Organization name for Title/ });
  await expect(use).toBeVisible();
  await use.click();
  await expect(use).toBeHidden();
  await expect(page.getByRole('button', { name: /^Title source: Empty/ })).toBeVisible();

  // Google first: its tile, then back to Samsung.
  await rail(page)
    .getByRole('radio', { name: /^Google Wallet/ })
    .click();
  await expect(report(page, 'Google')).toBeVisible();
  await shots(page, 'wallets-google-ready');
  await section(page, /^Google images/).click();
  await shots(page, 'wallets-images');
  await rail(page)
    .getByRole('radio', { name: /^Samsung Wallet/ })
    .click();

  // Samsung to Ticket: the type falls back, shown as a difference.
  await section(page, /^Samsung type/).click();
  await shots(page, 'wallets-type-grid');
  await page.getByRole('radio', { name: /^Ticket/ }).check({ force: true });
  await expect(report(page, 'Samsung')).toContainText('Compiled as loyalty');

  // Requiring the type blocks it; the fix removes the requirement.
  await section(page, /^Required/).click();
  await page.getByRole('combobox', { name: /Require…/ }).click();
  await page.getByRole('option', { name: 'Wallet type' }).click();
  await expect(report(page, 'Samsung')).toContainText('Samsung Wallet cannot show this pass.');
  await expect(page.getByText('No preview while blocked.')).toBeVisible();
  await shots(page, 'wallets-blocked');
  await page.getByRole('button', { name: "Don't require Wallet type" }).first().click();
  await expect(report(page, 'Samsung')).not.toContainText('cannot show this pass');

  // Art: a Samsung logo with the size check; a file that is too big for the rule is refused.
  await section(page, /^Samsung images/).click();
  const logo = page.locator('[data-target="wallets-images:samsung:logo"]');
  await logo.locator('input[type=file]').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: readFileSync('templates/starter-store-card/wallets/google/logo.png'),
  });
  await expect(logo).toContainText('wallets/samsung/logo.png');

  await section(page, /^Samsung fields/).click();
  await shots(page, 'wallets-fields');

  // Save, then reload: the saved manifest carries exactly what the tab wrote.
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByText(/^Saved v/)).toBeVisible();
  const detail = await admin.get<{ versions: { version: string }[] }>(
    `/api/v1/templates/${templateId}?orgId=${org.id}`,
  );
  const latest = await admin.get<{ manifest: { wallets: Record<string, unknown> } }>(
    `/api/v1/templates/${templateId}/versions/${detail.versions[0]?.version}?orgId=${org.id}`,
  );
  expect(latest.manifest.wallets).toMatchObject({
    roles: { title: false },
    samsung: { type: 'ticket', images: { logo: 'wallets/samsung/logo.png' } },
  });
  expect(JSON.stringify(latest.manifest.wallets)).not.toContain('required');
  await page.reload();
  await expect(rail(page).getByRole('radio', { name: /^Samsung Wallet, Ticket/ })).toBeVisible();
});

test('Wallets: a too-small logo is refused, a template-level off stays open', async ({ page }) => {
  await openChannels(page, ['samsung']);
  await page.goto(design('?mode=wallets&wallet=google'));
  await section(page, /^Google images/).click();
  const logo = page.locator('[data-target="wallets-images:google:logo"]');
  await logo.locator('input[type=file]').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: logoPng(120, 120, [20, 90, 200]),
  });
  await expect(logo).toContainText('minimum');
  await shots(page, 'wallets-small-logo');
  const samsung = rail(page).getByRole('radio', { name: /^Samsung Wallet/ });
  await expect(samsung).toContainText('Off for this template.');
  await samsung.click();
  await expect(report(page, 'Samsung')).toContainText('off for this template');
  await shots(page, 'wallets-off-template');
});

test('Pass mode panes use the shared report and open the tab', async ({ page }) => {
  await openChannels(page);
  await page.goto(design());
  await page.getByRole('radio', { name: 'Samsung', exact: true }).click();
  await expect(page.getByTestId('samsung-report')).toBeVisible();
  await shots(page, 'wallets-pass-pane');
  // The phone width in the shots remounts the stage: pick the pane again.
  await page.getByRole('radio', { name: 'Samsung', exact: true }).click();
  await page.getByRole('button', { name: 'Edit in Wallets' }).click();
  await expect(page.getByRole('radio', { name: 'Wallets' })).toBeChecked();
  await expect(rail(page).getByRole('radio', { name: /^Samsung Wallet/ })).toBeChecked();
});

test('The import report shows both wallets and opens the tab', async ({ page }) => {
  const zip = await (
    await admin.ctx.get(
      `/api/v1/templates/${encodeURIComponent(templateId)}/package?orgId=${org.id}`,
    )
  ).body();
  const name = `Wallets import ${uid('i')}`;
  await page.goto(`/admin/templates/upload?orgId=${encodeURIComponent(org.id)}`);
  await page.getByRole('combobox', { name: 'Organization', exact: true }).click();
  await page.getByRole('option', { name: 'Wallets designer' }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.locator('input[type=file]').setInputFiles({
    name: 'package.zip',
    mimeType: 'application/zip',
    buffer: zip,
  });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible({ timeout: 60_000 });
  const uploads = await admin.get<{ items: { uploadId: string }[] }>(
    `/api/v1/templates/uploads?orgId=${org.id}&limit=5`,
  );
  const id = uploads.items[0]?.uploadId ?? '';
  await page.goto(`/admin/o/${encodeURIComponent(org.id)}/templates/upload?upload=${id}`);
  const wallets = page.getByRole('region', { name: 'Wallet reports' });
  await expect(wallets.getByTestId('google-report')).toBeVisible();
  await expect(wallets.getByTestId('samsung-report')).toBeVisible();
  await shots(page, 'wallets-import-report');
  await wallets.getByRole('link', { name: 'Edit in designer' }).last().click();
  await expect(page).toHaveURL(/mode=wallets&wallet=samsung/);
  await expect(page.getByRole('radio', { name: 'Wallets' })).toBeChecked();
});

test('axe finds nothing serious on the tab at 1440 and 834, light and dark', async ({ page }) => {
  await openChannels(page);
  await page.goto(design('?mode=wallets&wallet=samsung'));
  await expect(report(page, 'Samsung')).toBeVisible();
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
  for (const [width, height] of [
    [1440, 900],
    [834, 1112],
  ] as const)
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const serious = results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
      expect(serious, `${width} ${scheme}`).toEqual([]);
    }
});
