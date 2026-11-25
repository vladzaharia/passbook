import { expect, type Page, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';
import { addOrgMember, createOrgWithRoles } from './helpers/seed.ts';

async function openMenu(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  return page.getByRole('menu');
}

test.describe('admin', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });

  test('one account menu across Admin, My passes and Developers, the theme kept', async ({
    page,
  }) => {
    await page.goto('/admin');
    let menu = await openMenu(page);
    await expect(menu.getByRole('menuitem')).toHaveText([
      'My passes',
      'Account',
      'Admin',
      'Developers',
      'Sign out',
    ]);
    await expect(menu.getByRole('menuitem', { name: 'Admin' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await menu.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Developers is another document: a full page load, same bar, same menu, same theme.
    menu = await openMenu(page);
    await menu.getByRole('menuitem', { name: 'Developers' }).click();
    await page.waitForURL((u) => u.pathname === '/developers');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    menu = await openMenu(page);
    await expect(menu.getByRole('menuitem')).toHaveText([
      'My passes',
      'Account',
      'Admin',
      'Developers',
      'Sign out',
    ]);
    await expect(menu.getByRole('menuitem', { name: 'Developers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(menu.getByRole('menuitemradio', { name: 'Dark' })).toBeChecked();

    await menu.getByRole('menuitem', { name: 'Admin' }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/admin'));
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('the bar is the same on a developers reference page', async ({ page }) => {
    await page.goto('/developers/reference/passes');
    const bar = page.locator('[data-menubar]');
    await expect(bar.getByRole('link', { name: /^PassBook/ })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Account menu' })).toBeVisible();
    // No space links in the bar: the account menu switches spaces.
    await expect(bar.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
  });

  test('the developers header fits at every width and the menu sheet carries sections and spaces', async ({
    page,
  }) => {
    const nav = page.getByRole('navigation', { name: 'Sections' });
    for (const [width, inline] of [
      [1440, true],
      [820, false],
      [390, false],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/developers/quickstart');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await expect(nav).toBeVisible({ visible: inline });
      await expect(nav.getByRole('link')).toHaveText(
        inline ? ['Quickstart', 'Guides', 'Reference', 'Playground', 'Workbench'] : [],
      );
    }
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const sheet = page.locator('#dev-menu');
    await expect(sheet.getByRole('link', { name: 'Reference', exact: true })).toBeVisible();
    // The bar's five sections are the chips at the top of the sheet.
    await expect(sheet.locator('.menu-sections').getByRole('link')).toHaveText([
      'Quickstart',
      'Guides',
      'Reference',
      'Playground',
      'Workbench',
    ]);
    const spaces = sheet.locator('[data-menu-spaces]');
    await expect(spaces.getByRole('link', { name: 'Developers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(spaces.getByRole('link', { name: 'Admin' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });
});

test.describe('organization member', () => {
  test.use({ storageState: 'e2e/.auth/user.json' });

  // Admin needs a membership; this test makes its own instead of relying on another spec's.
  let grant: { orgId: string; id: string } | undefined;
  test.beforeAll(async () => {
    const admin = await apiAs('admin');
    const member = await apiAs('user');
    try {
      const slug = uid('menubar-member').toLowerCase();
      const org = await createOrgWithRoles(admin, { slug, name: `Menubar member ${slug}` });
      const membership = await addOrgMember(admin, org.id, member, ['pass_operator']);
      grant = { orgId: org.id, id: membership.id };
    } finally {
      await member.dispose();
      await admin.dispose();
    }
  });
  test.afterAll(async () => {
    if (!grant) return;
    const admin = await apiAs('admin');
    try {
      await admin.send(
        'DELETE',
        `/api/v1/orgs/${encodeURIComponent(grant.orgId)}/memberships/${encodeURIComponent(grant.id)}`,
      );
    } finally {
      await admin.dispose();
    }
  });

  test('an organization member gets Admin, and never Developers without the role', async ({
    page,
  }) => {
    await page.goto('/');
    let menu = await openMenu(page);
    await expect(menu.getByRole('menuitem')).toHaveText([
      'My passes',
      'Account',
      'Admin',
      'Sign out',
    ]);
    await expect(menu.getByRole('menuitem', { name: 'My passes' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.keyboard.press('Escape');
    await page.goto('/developers');
    menu = await openMenu(page);
    await expect(menu.getByRole('menuitem')).toHaveText([
      'My passes',
      'Account',
      'Admin',
      'Sign out',
    ]);
  });
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the developer site offers Sign in in place of the avatar', async ({ page }) => {
    await page.goto('/developers');
    const bar = page.locator('[data-menubar]');
    await expect(bar.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Account menu' })).toHaveCount(0);
  });
});
