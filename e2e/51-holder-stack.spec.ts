import { expect, type Page, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { signInHolder } from './helpers/holder.ts';
import { shoot, withAgent } from './helpers/holder-agents.ts';
import { readSeed } from './helpers/seed.ts';

// H6: My passes as a stack: the front pass, peeks, the Test and Voided and expired groups, and
// master-detail from 768 up.

interface Fixture {
  email: string;
  names: { newest: string; older: string; test: string; voided: string; expired: string };
  ids: { newest: string; older: string; test: string; voided: string; expired: string };
}

/** A holder with two live passes (newest last), a test pass, a voided one and an expired one. */
async function holderWithPasses(): Promise<Fixture> {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const email = `${uid('stack')}@example.test`;
  const name = (k: string) => `${k} ${uid('N')}`;
  const names = {
    older: name('Older'),
    newest: name('Newest'),
    test: name('Trial'),
    voided: name('Voided'),
    expired: name('Expired'),
  };
  const make = (holder: string, extra: Parameters<typeof createPass>[2] = {}) =>
    createPass(admin, orgId, { holder, email, ...extra });
  const older = await make(names.older);
  const test_ = await make(names.test, { mode: 'test' });
  const voided = await make(names.voided);
  await admin.send('POST', `/api/v1/passes/${voided.id}/void`, { reason: 'e2e' });
  const expired = await make(names.expired, { input: { expirationDate: '2020-01-01T00:00:00Z' } });
  const newest = await make(names.newest);
  await admin.dispose();
  return {
    email,
    names,
    ids: {
      older: older.id,
      newest: newest.id,
      test: test_.id,
      voided: voided.id,
      expired: expired.id,
    },
  };
}

const stack = (page: Page) => page.getByRole('list', { name: 'Passes', exact: true });

test('My passes groups live, test and ended passes, and fronts the newest live pass', async ({
  playwright,
}) => {
  const f = await holderWithPasses();
  await withAgent(playwright, 'android', async (page) => {
    await signInHolder(page, f.email);
    // The front pass is the newest live one; the older live pass peeks behind it.
    await expect(page.locator('.wl-stack-front')).toContainText(f.names.newest);
    // The code is drawn as the pass appears, not after a first paint of an empty box.
    await expect(page.locator('.wl-stack-front svg.pc-barcode-svg')).toBeVisible({
      timeout: 3_000,
    });
    await expect(page.locator('.pc-barcode-pending')).toHaveCount(0);
    await expect(stack(page).getByRole('link', { name: f.names.older })).toBeVisible();
    // Test passes sit in their own group with a count, never among the live ones.
    const test = page.locator('[data-group=test]');
    await expect(test).toContainText('Test');
    await expect(test.getByRole('link', { name: f.names.test })).toBeVisible();
    await expect(stack(page).getByRole('link', { name: f.names.test })).toHaveCount(0);
    // Voided and expired passes are closed under one summary.
    const ended = page.locator('[data-group=ended] details');
    await expect(ended.locator('summary')).toContainText('Voided and expired');
    await expect(ended.locator('summary')).toContainText('2');
    await expect(ended.getByRole('link', { name: f.names.voided })).toBeHidden();
    await shoot(page, 'portal-stack');
    await ended.locator('summary').click();
    await expect(ended.getByRole('link', { name: f.names.voided })).toBeVisible();
    await expect(ended.getByRole('link', { name: f.names.expired })).toBeVisible();
    await shoot(page, 'portal-stack-ended-open');
  });
});

test('tapping a peek brings that pass forward, and the front opens the pass', async ({
  playwright,
}) => {
  const f = await holderWithPasses();
  await withAgent(playwright, 'android', async (page) => {
    await signInHolder(page, f.email);
    await expect(page.locator('.wl-stack-front')).toContainText(f.names.newest);
    await stack(page).getByRole('link', { name: f.names.older }).click();
    await expect(page.locator('.wl-stack-front')).toContainText(f.names.older);
    await expect(page).toHaveURL((u) => u.pathname === '/');
    await expect(stack(page).getByRole('link', { name: f.names.newest })).toBeVisible();
    await page.getByRole('link', { name: f.names.older, exact: true }).first().press('Enter');
    await page.waitForURL((u) => u.pathname === `/passes/${f.ids.older}`);
  });
});

test('six passes take under two screens at 390 wide', async ({ playwright }) => {
  const admin = await apiAs('admin');
  const email = `${uid('six')}@example.test`;
  for (let i = 0; i < 6; i++)
    await createPass(admin, readSeed().org.id, { holder: `Six ${i} ${uid('S')}`, email });
  await admin.dispose();
  await withAgent(playwright, 'android', async (page) => {
    await signInHolder(page, email);
    await expect(stack(page).locator('.wl-peek')).toHaveCount(5);
    // Each peek keeps its 68 px strip: the next one covers only the 10 px overlap.
    for (const width of [390, 834]) {
      await page.setViewportSize({ width, height: 900 });
      const tops = await page
        .locator('.wl-stack-peek')
        .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
      for (let i = 1; i < tops.length; i++) {
        expect((tops[i] ?? 0) - (tops[i - 1] ?? 0)).toBeGreaterThanOrEqual(58);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const { height } = page.viewportSize() ?? { height: 0 };
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(total).toBeLessThan(height * 2);
    await shoot(page, 'portal-six');
  });
});

for (const theme of ['light', 'dark'] as const) {
  test(`from 768 the stack sits beside the selected pass (${theme})`, async ({ playwright }) => {
    const f = await holderWithPasses();
    await withAgent(
      playwright,
      'windows',
      async (page) => {
        await signInHolder(page, f.email);
        await page.goto(`/passes/${f.ids.older}`);
        const detail = page.getByRole('heading', { level: 1, name: 'Membership' });
        await expect(detail).toBeVisible({ timeout: 15_000 });
        const side = await stack(page).first().boundingBox();
        const main = await detail.boundingBox();
        expect(side && main && side.x + side.width <= main.x + 1).toBe(true);
        // The selected pass is the stack's front; the other live pass peeks.
        await expect(page.locator('.wl-stack-front')).toContainText(f.names.older);
        await expect(stack(page).getByRole('link', { name: f.names.newest })).toBeVisible();
        await shoot(page, 'portal-detail', theme);
      },
      { theme, viewport: { width: 1440, height: 900 } },
    );
  });
}
