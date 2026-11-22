import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { AGENTS, ALL_AGENTS, pathOf, shoot, withAgent } from './helpers/holder-agents.ts';
import { readSeed } from './helpers/seed.ts';

// H3: the door view, a white field with the code and its value, on every agent; and what happens
// to a saved copy when the pass is voided.

async function doorOf() {
  const admin = await apiAs('admin');
  const memberId = uid('DOOR').toUpperCase();
  const pass = await createPass(admin, readSeed().org.id, { holder: `Door ${uid('D')}`, memberId });
  const detail = await admin.get(`/api/v1/passes/${pass.id}`);
  return { admin, id: pass.id as string, memberId, page: pathOf(detail.publicUrl) };
}

for (const id of ALL_AGENTS) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${AGENTS[id].label}: the door view is a white field with the code only (${theme})`, async ({
      playwright,
    }) => {
      const door = await doorOf();
      await door.admin.dispose();
      await withAgent(
        playwright,
        id,
        async (page) => {
          await page.goto(`${door.page}/barcode`);
          await expect(page.locator('figure svg')).toBeVisible();
          expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
            'rgb(255, 255, 255)',
          );
          // The credential's text never reaches the page: only the drawn code does.
          await expect(page.locator('body')).not.toContainText(door.memberId);
          await expect(page.getByRole('link', { name: 'Back to pass' })).toBeVisible();
          // Not saved: no offline claim, and nothing else on the page.
          await expect(page.getByText('Works offline')).toBeHidden();
          if (theme === 'light' || id === 'android') await shoot(page, `door-${id}`, theme);
        },
        { theme },
      );
    });
  }
}

test('a saved door view keeps the screen awake where the browser can', async ({ playwright }) => {
  const door = await doorOf();
  await door.admin.dispose();
  await withAgent(playwright, 'android', async (page) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __wake: string[] };
      w.__wake = [];
      Object.defineProperty(navigator, 'wakeLock', {
        value: {
          request: (type: string) => {
            w.__wake.push(type);
            return Promise.resolve({ release() {}, addEventListener() {} });
          },
        },
      });
    });
    await page.goto(door.page);
    await page.getByRole('link', { name: 'Save to this phone' }).first().click();
    await page
      .getByRole('dialog', { name: 'Add to Home screen' })
      .getByRole('button', { name: 'Done' })
      .click();
    await page.getByRole('link', { name: 'Show at the door' }).first().click();
    await expect(page.getByText('Works offline')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __wake: string[] }).__wake))
      .toContain('screen');
  });
});

test('a voided pass drops its saved door view on the next online open', async ({ playwright }) => {
  const door = await doorOf();
  await withAgent(playwright, 'android', async (page, ctx) => {
    await page.goto(door.page);
    await page.getByRole('link', { name: 'Save to this phone' }).first().click();
    await page
      .getByRole('dialog', { name: 'Add to Home screen' })
      .getByRole('button', { name: 'Done' })
      .click();
    await expect(page.getByText('On this phone · Works offline')).toBeVisible();
    await page.goto(`${door.page}/barcode`);
    await expect(page.locator('figure svg')).toBeVisible();

    await door.admin.send('POST', `/api/v1/passes/${door.id}/void`, { reason: 'e2e' });
    await page.goto(`${door.page}/barcode`);
    await expect(page.locator('figure svg')).toBeHidden();
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).length)).toBe(0);
    // Offline now there is nothing to show: the voided code does not come back from a cache.
    await ctx.setOffline(true);
    await page.goto(`${door.page}/barcode`).catch(() => undefined);
    await expect(page.locator('figure svg')).toBeHidden();
    await ctx.setOffline(false);
  });
  await door.admin.dispose();
});

test('a door view for an unknown pass says the barcode is unavailable', async ({ playwright }) => {
  await withAgent(playwright, 'android', async (page) => {
    const res = await page.goto(`/p/${'z'.repeat(43)}/barcode`);
    expect(res?.status()).toBe(404);
    await expect(page.locator('figure svg')).toHaveCount(0);
    await shoot(page, 'door-dead');
  });
});
