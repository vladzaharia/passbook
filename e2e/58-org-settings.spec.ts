import { expect, test } from '@playwright/test';
import { ORG_WEBSITE_INVALID } from '../src/shared/copy/org-website.ts';
import { readSeed } from './helpers/seed.ts';

test.describe('org settings', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });
  test.describe.configure({ mode: 'serial' });

  test('Website refuses http, saves https normalized, and resets', async ({ page }) => {
    const org = readSeed().org;
    await page.goto(`/admin/o/${org.id}/settings`);
    const website = page.getByLabel('Website');
    await expect(website).toBeVisible();

    await website.fill('http://gym.example');
    await page.getByRole('button', { name: 'Save' }).first().click();
    await expect(page.getByText(ORG_WEBSITE_INVALID)).toBeVisible();

    await website.fill('https://Gym.Example');
    await page.getByRole('button', { name: 'Save' }).first().click();
    await expect(page.getByText(ORG_WEBSITE_INVALID)).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel('Website')).toHaveValue('https://gym.example/');

    await page
      .getByRole('button', { name: /(Use default for|Reset) Website( to default)?/ })
      .click();
    await page.getByRole('button', { name: 'Save' }).first().click();
    await page.reload();
    await expect(page.getByLabel('Website')).toHaveValue('');
  });

  test('another org setting round-trips', async ({ page }) => {
    const org = readSeed().org;
    await page.goto(`/admin/o/${org.id}/settings`);
    const from = page.getByLabel('Email From name');
    await from.fill('Rain City Fit');
    await page.getByRole('button', { name: 'Save' }).first().click();
    await page.reload();
    await expect(page.getByLabel('Email From name')).toHaveValue('Rain City Fit');
    await page.getByLabel('Email From name').fill('');
    await page.getByRole('button', { name: 'Save' }).first().click();
    await page.reload();
    await expect(page.getByLabel('Email From name')).toHaveValue('');
  });
});
