import { expect, type Page, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

// iPhone 15: 393x852 @3x. Chromium with the same viewport and touch emulation.
test.use({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
});

const USER_EMAIL = 'user@example.test'; // the mock Pocket ID "user" account

let portalPassId = '';
let adminPassTitle = '';
test.beforeAll(async () => {
  const api = await apiAs('admin');
  adminPassTitle = `Mobile ${uid('M')}`;
  // Verified email of the signed-in OIDC user, so the pass is owned immediately.
  const pass = await createPass(api, readSeed().org.id, {
    holder: adminPassTitle,
    email: USER_EMAIL,
  });
  portalPassId = pass.id;
  await api.dispose();
});

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });

    async function shot(page: Page, name: string, testInfo: import('@playwright/test').TestInfo) {
      await page.waitForFunction(() => [...document.images].every((img) => img.complete));
      const path = testInfo.outputPath(`${name}-${theme}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`${name}-${theme}`, { path, contentType: 'image/png' });
    }

    test.describe('portal', () => {
      test.use({ storageState: 'e2e/.auth/user.json' });

      test('home', async ({ page }, testInfo) => {
        await page.goto('/');
        await expect(page.getByRole('link', { name: adminPassTitle, exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Refresh' }).first()).toBeVisible();
        await expectNoHorizontalScroll(page);
        expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(
          theme === 'dark',
        );
        await shot(page, 'portal-home', testInfo);
      });

      test('pass detail', async ({ page }, testInfo) => {
        await page.goto(`/passes/${portalPassId}`);
        await expect(page.getByRole('link', { name: 'Add to Apple Wallet' })).toBeVisible();
        await expectNoHorizontalScroll(page);
        await shot(page, 'portal-pass', testInfo);
      });
    });

    test.describe('admin', () => {
      test.use({ storageState: 'e2e/.auth/admin.json' });

      test('passes list', async ({ page }, testInfo) => {
        await page.goto('/admin/passes');
        await expect(page.getByRole('heading', { name: 'Passes', level: 1 })).toBeVisible();
        await expect(page.getByText(adminPassTitle).first()).toBeVisible();
        await expectNoHorizontalScroll(page);
        await shot(page, 'admin-passes', testInfo);
      });
    });
  });
}
