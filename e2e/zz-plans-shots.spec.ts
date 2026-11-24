import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

const OUT = process.env.PLANS_SHOTS ?? '.wrangler/agent-logs/plans-shots';
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '834', width: 834, height: 1180 },
  { name: '390', width: 390, height: 844 },
] as const;

async function axe(page: Page, label: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = r.violations.map(
    (v) =>
      `${v.id}[${v.impact}] ${v.nodes
        .slice(0, 3)
        .map((n) => `${n.target.join(' ')} :: ${n.failureSummary?.split('\n')[1] ?? ''}`)
        .join(' | ')}`,
  );
  console.log(`AXE ${label}: ${bad.length ? bad.join(' || ') : 'clean'}`);
}

async function shoot(page: Page, name: string, setup: () => Promise<void>, full = true) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const s of SIZES) {
      await page.setViewportSize({ width: s.width, height: s.height });
      await setup();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/${name}-${s.name}-${scheme}.png`, fullPage: full });
      if (s.name === '390' || s.name === '1440') await axe(page, `${name}-${s.name}-${scheme}`);
    }
  }
}

test.use({ storageState: 'e2e/.auth/admin.json' });
test.setTimeout(300_000);

test('plan shots', async ({ page }) => {
  const api = await apiAs('admin');
  const name = uid('Plans');
  const org = await api.send<{ id: string }>('POST', '/api/v1/orgs', {
    name,
    slug: name.toLowerCase(),
    preset: 'standard',
  });
  const url = `/admin/platform/orgs/${org.id}?tab=features`;
  const open = async () => {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Plan', level: 2 })).toBeVisible();
  };
  await shoot(page, 'features-rest', open);
  await shoot(
    page,
    'features-pick',
    async () => {
      await open();
      await page
        .getByRole('radio', { name: 'Premium' })
        .check({ force: true })
        .catch(async () => {
          await page.locator('label', { hasText: 'Premium' }).first().click();
        });
      await expect(page.getByRole('button', { name: 'Apply Premium' })).toBeVisible();
    },
    false,
  );
  await shoot(
    page,
    'features-compare',
    async () => {
      await open();
      await page.getByRole('button', { name: 'Compare' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
    false,
  );
  await shoot(
    page,
    'features-popover',
    async () => {
      await open();
      await page.getByRole('button', { name: 'Where PassBook shows on Standard' }).click();
      await expect(page.getByText('Where holders see PassBook')).toBeVisible();
    },
    false,
  );
  await shoot(
    page,
    'create-org',
    async () => {
      await page.goto('/admin/orgs');
      await page.getByRole('button', { name: 'New organization' }).click();
      await expect(page.getByRole('radio', { name: 'Premium' })).toBeVisible();
    },
    false,
  );
  const empty = uid('Noplan');
  const org2 = await api.send<{ id: string }>('POST', '/api/v1/orgs', {
    name: empty,
    slug: empty.toLowerCase(),
  });
  const real = await api.get<Record<string, unknown>>(
    `/api/v1/platform/orgs/${org2.id}/entitlements`,
  );
  await page.route(`**/api/v1/platform/orgs/${org2.id}/entitlements`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            ...real,
            preset: null,
            presetLabel: null,
            revision: 0,
            updatedAt: null,
            items: [],
          },
        })
      : route.continue(),
  );
  await shoot(page, 'features-empty', async () => {
    await page.goto(`/admin/platform/orgs/${org2.id}?tab=features`);
    await expect(page.getByText('No features set')).toBeVisible();
  });
  await page.unroute(`**/api/v1/platform/orgs/${org2.id}/entitlements`);
  const seedOrg = readSeed().org.id;
  await shoot(page, 'brand', async () => {
    await page.goto(`/admin/o/${seedOrg}/brand`);
    await expect(page.getByRole('heading', { name: 'Brand and channels', level: 1 })).toBeVisible();
  });
  const read = await api.get<{ revision: number }>(`/api/v1/platform/orgs/${seedOrg}/entitlements`);
  await api.send('PUT', `/api/v1/platform/orgs/${seedOrg}/entitlements`, {
    expectedRevision: read.revision,
    preset: 'standard',
    overrides: {},
  });
  await shoot(page, 'org-overview', async () => {
    await page.goto(`/admin/o/${seedOrg}`);
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Standard' })).toBeVisible();
  });
  await shoot(
    page,
    'orgs-list',
    async () => {
      await page.goto('/admin/orgs');
      await expect(page.getByRole('heading', { name: 'Organizations', level: 1 })).toBeVisible();
      await page.waitForTimeout(300);
    },
    false,
  );
  await api.dispose();
});
