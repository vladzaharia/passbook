import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import {
  type Api,
  apiAs,
  BASE,
  createPass,
  requireActiveTemplateRelease,
  uid,
} from './helpers/api.ts';
import { MAC_SAFARI } from './helpers/devices.ts';
import { logoPng } from './helpers/png.ts';
import { templateFromBlueprint } from './helpers/releases.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.setTimeout(180_000);

const SHOTS = process.env.O10_SHOTS;
const WIDTHS = [1440, 834, 390] as const;

/** Full-page shots at three widths in both themes when O10_SHOTS names a folder. */
async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}/${name}-${width}-${theme}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 720 });
}

async function newOrg(api: Api, prefix: string) {
  const slug = uid(prefix).toLowerCase();
  return api.send<{ id: string; slug: string; name: string }>('POST', '/api/v1/orgs', {
    slug,
    name: `Setup ${slug}`,
    addMe: true,
  });
}

const brandUrl = (orgId: string) => `/admin/o/${encodeURIComponent(orgId)}/brand`;
const redLogo = (w: number, h: number) => ({
  name: 'logo.png',
  mimeType: 'image/png',
  buffer: logoPng(w, h, [180, 35, 44]),
});

test('a new org adds a logo, a palette and support, and reaches Ready', async ({ page }) => {
  const api = await apiAs('admin');
  const org = await newOrg(api, 'rd');
  await api.dispose();

  await page.goto(brandUrl(org.id));
  await expect(page.getByRole('heading', { name: 'Brand and channels', level: 1 })).toBeVisible();
  await expect(page.getByText('3 to do').first()).toBeVisible();
  await shoot(page, 'o10-1-new-org');

  const brand = page.getByRole('region', { name: 'Brand', exact: true });
  const file = (slot: string) => brand.locator(`[data-asset-slot="${slot}"] input[type=file]`);
  await file('logo').setInputFiles(redLogo(360, 96));
  await expect(brand.getByRole('img', { name: /logo$/ }).first()).toBeVisible();
  await brand.getByRole('group', { name: 'From logo' }).getByRole('button').first().click();
  await expect(brand.getByLabel('Background picker')).not.toHaveValue('');
  await file('icon').setInputFiles(redLogo(114, 114));

  const support = page.getByRole('region', { name: 'Support and email' });
  await support.getByRole('textbox', { name: 'Support email' }).fill('help@acme.test');

  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Support email')).toBeVisible();
  await shoot(page, 'o10-1-review');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByText('No logo. Passes show the placeholder.')).toBeHidden();
  await expect(page.getByText('Pass backs list')).toBeHidden();
  await expect(page.getByText('3 to do')).toHaveCount(0);
  await expect(page.getByText('Ready').or(page.getByText('All set')).first()).toBeVisible();
  await shoot(page, 'o10-1-ready');

  const read = await apiAs('admin');
  const view = await read.get(`/api/v1/orgs/${org.id}/pass-setup`);
  expect(view.checks.filter((c: { level: string }) => c.level !== 'info')).toEqual([]);
  expect(view.brand.support.email.value).toBe('help@acme.test');
  expect(view.brand.passColors.source).toBe('org');
  await read.dispose();
});

test('Get your own ID shows the run, then the managed ID, with the provisioner stubbed', async ({
  page,
}) => {
  const api = await apiAs('admin');
  const org = await newOrg(api, 'id');
  await api.dispose();

  const now = Date.now();
  const identifier = `pass.mobile.passbook.setup${uid('h')
    .replace(/[^a-z0-9]/g, '')
    .slice(-6)}`;
  const run = (state: string, step: string | null) => ({
    id: '0193a1b2-7c00-7000-8000-0000000000d1',
    orgId: org.id,
    kind: 'provision',
    targetType: 'org',
    targetId: org.id,
    state,
    step,
    attempt: 1,
    waitingFor: null,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: state === 'succeeded' ? now : null,
  });
  const identity = {
    id: '0193a1b2-7c00-7000-8000-0000000000d2',
    provider: 'apple',
    orgId: org.id,
    label: 'Managed',
    identifier,
    kind: 'managed',
    status: 'active',
    notBefore: now,
    notAfter: now + 365 * 86_400_000,
    rotation: 'auto',
    nextRotationAt: null,
    issuing: true,
    isDefault: true,
    passCount: 0,
    createdAt: now,
  };
  // Apple's side is the provisioner; the page is driven by the run the Worker reports, so the run is stubbed.
  let phase: 'none' | 'running' | 'done' = 'none';
  await page.route(`**/api/v1/orgs/${org.id}/identities/apple`, (route) => {
    phase = 'running';
    return route.fulfill({ status: 202, json: run('running', 'type') });
  });
  await page.route(`**/api/v1/orgs/${org.id}/pass-setup`, async (route) => {
    const res = await route.fetch();
    const view = await res.json();
    if (route.request().method() === 'GET' && phase !== 'none') {
      view.apple.run = phase === 'running' ? run('running', 'type') : run('succeeded', 'done');
      if (phase === 'done') {
        view.apple.identity = identity;
        view.checks = view.checks.filter((c: { code: string }) => c.code !== 'APPLE_SHARED_ID');
      }
    }
    return route.fulfill({ response: res, json: view });
  });

  await page.goto(brandUrl(org.id));
  // The check opens the Apple row, whose own button starts the run.
  await page.getByRole('button', { name: 'Get your own ID' }).first().click();
  await page
    .locator('[data-channel="apple"]')
    .getByRole('button', { name: 'Get your own ID' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'New managed ID' });
  await expect(dialog).toBeVisible();
  await shoot(page, 'o10-2-dialog');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();

  const steps = page.getByRole('list', { name: 'Setup steps' });
  await expect(steps).toBeVisible();
  await expect(steps.getByText('Create the pass type')).toBeVisible();
  await shoot(page, 'o10-2-running');

  phase = 'done';
  await page.reload();
  const apple = page.locator('[data-channel="apple"]');
  await apple.getByRole('button', { expanded: false }).first().click();
  await expect(apple.getByText(identifier)).toBeVisible();
  await expect(page.getByText("Apple passes sign with PassBook's shared ID.")).toBeHidden();
  await shoot(page, 'o10-2-managed');
});

test('blocking Mobile shows the counts and stops the /p code', async ({ page, browser }) => {
  const api = await apiAs('admin');
  const org = await newOrg(api, 'bm');
  const template = await templateFromBlueprint(api, org.id, 'Gym pass');
  const pass = await createPass(api, org.id, {
    templateId: template.id,
    holder: 'Maya Chen',
    release: await requireActiveTemplateRelease(api, org.id, template.id, 'live'),
  });
  const detail = await api.get(`/api/v1/passes/${pass.id}`);
  const code = `${new URL(detail.publicUrl, BASE).pathname}/barcode`;
  await api.dispose();

  const anon = await browser.newContext({ userAgent: MAC_SAFARI });
  expect((await anon.request.get(code)).status()).toBe(200);

  await page.goto(brandUrl(org.id));
  const mobile = page.locator('[data-channel="mobile"]');
  await mobile.getByRole('switch', { name: 'Mobile allowed' }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Mobile stops for 1 template · 1 pass\./)).toBeVisible();
  await expect(dialog.getByText('Copies keep working.')).toBeVisible();
  await shoot(page, 'o10-3-block-review');
  await dialog.getByRole('button', { name: 'Block and save' }).click();
  await expect(dialog).toBeHidden();
  await expect(mobile).toContainText('Blocked');
  await shoot(page, 'o10-3-blocked');

  expect((await anon.request.get(code)).status()).toBe(404);
  await anon.close();
});

test('a template opts out of Mobile and the org page counts it', async ({ page }) => {
  const api = await apiAs('admin');
  const org = await newOrg(api, 'to');
  await templateFromBlueprint(api, org.id, 'Keeps Mobile');
  const out = await templateFromBlueprint(api, org.id, 'Opts out');
  await api.dispose();

  await page.goto(
    `/admin/o/${encodeURIComponent(org.id)}/templates/${encodeURIComponent(out.id)}?tab=channels`,
  );
  const mobile = page.getByRole('radiogroup', { name: 'Mobile' });
  await mobile.getByRole('radio', { name: 'Off' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Save channels?' });
  if (await confirm.isVisible().catch(() => false))
    await confirm.getByRole('button', { name: 'Save' }).click();
  await expect(mobile.getByRole('radio', { name: 'Off' })).toBeChecked();
  await shoot(page, 'o10-4-template-channels');

  await page.goto(brandUrl(org.id));
  await expect(page.locator('[data-channel="mobile"]')).toContainText('On for 1 of 2 templates');
  await shoot(page, 'o10-4-org-counts');
});

test('a new pass fixes a missing logo in place', async ({ page }) => {
  const api = await apiAs('admin');
  const org = await newOrg(api, 'fx');
  await templateFromBlueprint(api, org.id, 'Gym pass');
  await api.dispose();

  await page.goto(`/admin/o/${encodeURIComponent(org.id)}/passes/new`);
  await page.getByText('Gym pass', { exact: true }).first().click();
  await shoot(page, 'o10-5-new-pass');
  const next = page.getByRole('button', { name: 'Next' });
  await next.click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Maya Chen');
  await page.getByRole('textbox', { name: 'ID', exact: true }).fill(uid('ID').toUpperCase());
  await next.click();
  await page.getByLabel('Holder email').fill('maya@example.test');
  await next.click();
  await expect(page.getByText('Uses the placeholder logo.')).toBeVisible();
  await shoot(page, 'o10-5-review-warning');
  await page.getByRole('button', { name: 'Add logo' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Add logo' });
  await sheet.locator('input[type=file]').setInputFiles(redLogo(360, 96));
  await shoot(page, 'o10-5-sheet');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  // The row leaves once the pass's warnings are read again; the icon and support rows stay.
  await expect(page.getByText('Uses the placeholder logo.')).toBeHidden();
  await expect(page.getByText('Uses the placeholder icon.')).toBeVisible();
  await shoot(page, 'o10-5-fixed');
  const read = await apiAs('admin');
  const view = await read.get(`/api/v1/orgs/${org.id}/pass-setup`);
  expect(view.brand.logo.source).toBe('org');
  await read.dispose();
});
