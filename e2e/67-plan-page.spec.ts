import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';
import { shoot } from './helpers/shots.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.setTimeout(120_000);

async function newOrg(preset: string, overrides: Record<string, { value: number }> = {}) {
  const api = await apiAs('admin');
  const slug = uid('plan67').toLowerCase();
  const org = await api.send<{ id: string }>('POST', '/api/v1/orgs', {
    slug,
    name: `Plan ${slug}`,
    addMe: true,
    preset,
  });
  if (Object.keys(overrides).length > 0) {
    const url = `/api/v1/platform/orgs/${org.id}/entitlements`;
    const state = await api.get<{ revision: number }>(url);
    await api.send('PUT', url, { expectedRevision: state.revision, preset, overrides });
  }
  await api.dispose();
  return org.id;
}

const contrast = async (page: import('@playwright/test').Page) => {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
};

test('Overview carries no plan card, and Plan lists limits, features and the footer', async ({
  page,
}) => {
  const id = await newOrg('standard');
  await page.goto(`/admin/o/${id}`);
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'First pass' })).toBeVisible();
  await expect(page.getByText('Powered by PassBook')).toHaveCount(0);
  await shoot(page, 'overview-normal');

  await page.getByRole('link', { name: 'Plan', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/o/${id}/plan$`));
  await expect(page.getByRole('heading', { name: 'Standard' })).toBeVisible();
  const limits = page.getByRole('region', { name: 'Limits' });
  await expect(limits.getByText('0 of 5,000')).toBeVisible();
  const features = page.getByRole('region', { name: 'Features' });
  await expect(features.getByText('Google Wallet')).toBeVisible();
  await shoot(page, 'plan-standard');
  expect(await contrast(page)).toEqual([]);
});

test('Overview names a limit at 80% or more and links to Plan', async ({ page }) => {
  const id = await newOrg('trial', { members: { value: 1 } });
  await page.goto(`/admin/o/${id}`);
  const notice = page.getByText('Members: 1 of 1');
  await expect(notice).toBeVisible();
  await shoot(page, 'overview-at-limit');
  await page.getByRole('main').getByRole('link', { name: 'Plan', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/o/${id}/plan$`));
  await expect(page.getByRole('region', { name: 'Limits' }).getByText('1 of 1')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Features' }).getByText('Google Wallet'),
  ).toHaveCount(0);
  await shoot(page, 'plan-trial-at-limit');
});
