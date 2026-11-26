import { expect, type Page, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { signInHolder } from './helpers/holder.ts';
import { readSeed } from './helpers/seed.ts';

const developerAccess = (page: Page) =>
  page.evaluate(async () => {
    const res = await fetch('/api/v1/developer/access');
    return { status: res.status, body: await res.json() };
  });

const menuItems = async (page: Page) => {
  await page.getByRole('button', { name: 'Account menu' }).click();
  return page.getByRole('menu').getByRole('menuitem');
};

test.describe('developer group', () => {
  test.use({ storageState: 'e2e/.auth/developer.json' });

  test('sees Developers and has access', async ({ page }) => {
    await page.goto('/account');
    await expect(await menuItems(page)).toHaveText([
      'My passes',
      'Account',
      'Workbench',
      'Developers',
      'Sign out',
    ]);
    expect(await developerAccess(page)).toEqual({ status: 200, body: { access: 'yes' } });
  });
});

test.describe('plain user', () => {
  test.use({ storageState: 'e2e/.auth/user.json' });

  test('has no Developers and is refused developer routes', async ({ page }) => {
    await page.goto('/account');
    await expect(await menuItems(page)).not.toContainText(['Developers']);
    expect(await developerAccess(page)).toEqual({ status: 200, body: { access: 'none' } });
    const refused = await page.evaluate(async () => {
      const res = await fetch('/api/v1/developer/sandbox');
      return { status: res.status, body: await res.json() };
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('DEVELOPER_ACCESS_REQUIRED');
  });
});

test.describe('email session', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('has no Developers and is told to sign in with Polaris ID', async ({ page }) => {
    const admin = await apiAs('admin');
    const email = `${uid('devrole')}@example.test`;
    try {
      await createPass(admin, readSeed().org.id, { email });
    } finally {
      await admin.dispose();
    }
    await signInHolder(page, email);
    const access = await developerAccess(page);
    expect(access.status).toBe(200);
    expect(access.body.access).toBe('email');
    expect(access.body.signInUrl).toMatch(/^\/auth\/oidc\/start\?next=/);
    await expect(await menuItems(page)).not.toContainText(['Developers']);
  });
});
