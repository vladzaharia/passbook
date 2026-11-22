import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { apiAs, BASE, createPass, uid } from './helpers/api.ts';
import { ANDROID_CHROME } from './helpers/devices.ts';
import { signInHolder } from './helpers/holder.ts';
import { modalOpen } from './helpers/holder-agents.ts';
import { readSeed } from './helpers/seed.ts';

// SHOTS=<dir> also writes the screens (390, 820, 1440 × light, dark) for a visual check.
const SHOTS = process.env.SHOTS;
const SIZES = [
  ['390', { width: 390, height: 844 }],
  ['820', { width: 820, height: 1180 }],
  ['1440', { width: 1440, height: 900 }],
] as const;

async function shoot(page: Page, name: string, theme: string, fullPage = true) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // An open sheet stays as it is: one shot at the current width, no resize under it.
  const modal = await modalOpen(page);
  for (const [label, size] of modal ? SIZES.slice(0, 1) : SIZES) {
    if (!modal) await page.setViewportSize(size);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/${name}-${label}-${theme}.png`, fullPage });
  }
  if (!modal) await page.setViewportSize({ width: 390, height: 844 });
}

test('save to this phone: save, sheet, door view offline, remove', async ({ browser }) => {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const pass = await createPass(admin, orgId, { holder: `Saver ${uid('S')}` });
  const detail = await admin.get(`/api/v1/passes/${pass.id}`);
  const pagePath = new URL(detail.publicUrl, BASE).pathname;
  const token = pagePath.split('/')[2] as string;

  for (const theme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({
      userAgent: ANDROID_CHROME,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      reducedMotion: 'reduce',
    });
    await ctx.addCookies([{ name: 'wallet-theme', value: theme, url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(pagePath);
    const save = page.getByRole('link', { name: 'Save to this phone' }).first();
    await expect(save).toBeVisible();
    await expect(page.getByText('On this phone')).toBeHidden();
    await shoot(page, 'pass-lead', theme);

    await save.click();
    const sheet = page.getByRole('dialog', { name: 'Add to Home screen' });
    await expect(sheet).toBeVisible();
    await shoot(page, 'pass-sheet', theme, false);
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByText('On this phone · Works offline')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove from this phone' })).toBeVisible();
    await shoot(page, 'pass-saved', theme);

    // One cache: the token string is nowhere in Cache Storage, in a name, a key or a saved body.
    const stored = await page.evaluate(async () => {
      const out: string[] = [];
      for (const name of await caches.keys()) {
        out.push(name);
        const cache = await caches.open(name);
        for (const req of await cache.keys()) {
          out.push(req.url);
          out.push((await (await cache.match(req))?.text()) ?? '');
          out.push([...((await cache.match(req))?.headers.entries() ?? [])].join(' '));
        }
      }
      return out;
    });
    expect(stored.length).toBe(4);
    for (const s of stored) expect(s).not.toContain(token);
    const regs = await page.evaluate(async () =>
      (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname),
    );
    expect(regs).toEqual([`${pagePath}/barcode`]);

    await page.getByRole('link', { name: 'Show at the door' }).first().click();
    await expect(page).toHaveURL(`${BASE}${pagePath}/barcode`);
    await expect(page.getByText('Works offline')).toBeVisible();
    await expect(page.locator('figure svg')).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      'rgb(255, 255, 255)',
    );
    // No manifest: the shortcut opens the saved door view in the browser.
    await expect(page.locator('link[rel=manifest]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to pass' })).toHaveAttribute('href', './');
    await shoot(page, 'door', theme);

    // The worker answers the door view with no network.
    await page.reload();
    await ctx.setOffline(true);
    await page.reload();
    await expect(page.locator('figure svg')).toBeVisible();
    await ctx.setOffline(false);

    await page.goto(pagePath);
    await page.getByRole('button', { name: 'Remove from this phone' }).click();
    await expect(page.getByRole('link', { name: 'Save to this phone' }).first()).toBeVisible();
    expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0);
    await ctx.close();
  }
  await admin.dispose();
});

test('the portal saves the same door view, and an ended pass page drops the copy', async ({
  browser,
}) => {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const email = `${uid('holder')}@example.test`;
  const pass = await createPass(admin, orgId, { holder: `Portal ${uid('S')}`, email });
  const detail = await admin.get(`/api/v1/passes/${pass.id}`);
  const pagePath = new URL(detail.publicUrl, BASE).pathname;
  const ctx = await browser.newContext({
    userAgent: ANDROID_CHROME,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  await signInHolder(page, email);
  await page.goto(`/passes/${pass.id}`);
  // Before the save script wires the host, the lead is a plain link to the door view: wait for it.
  await expect(page.locator('[data-save-phone][data-save-ready]').first()).toBeAttached();
  await page.getByRole('link', { name: 'Save to this phone' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Add to Home screen' });
  await expect(sheet).toBeVisible();
  await shoot(page, 'portal-sheet', 'light', false);
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('On this phone · Works offline')).toBeVisible();
  await shoot(page, 'portal-saved', 'light');
  await ctx.addCookies([{ name: 'wallet-theme', value: 'dark', url: BASE }]);
  await page.goto(`/passes/${pass.id}`);
  await page.getByRole('button', { name: 'Remove from this phone' }).click();
  await page.getByRole('link', { name: 'Save to this phone' }).first().click();
  await expect(sheet).toBeVisible();
  await shoot(page, 'portal-sheet', 'dark', false);
  await sheet.getByRole('button', { name: 'Done' }).click();
  await shoot(page, 'portal-saved', 'dark');
  const regs = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname),
  );
  expect(regs).toEqual([`${pagePath}/barcode`]);

  // Voiding the pass: its /p page, opened on this device, drops the saved copy.
  await admin.send('POST', `/api/v1/passes/${pass.id}/void`, { reason: 'test' });
  await page.goto(pagePath);
  await expect(page.getByText('This pass was voided', { exact: false })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).length)).toBe(0);
  await shoot(page, 'ended', 'dark');
  await ctx.close();
  await admin.dispose();
});

test('the home-screen sheet sits at the bottom of a phone and centres from 640', async ({
  browser,
}) => {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const pass = await createPass(admin, orgId, { holder: `Sheet ${uid('S')}` });
  const detail = await admin.get(`/api/v1/passes/${pass.id}`);
  const pagePath = new URL(detail.publicUrl, BASE).pathname;
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    const ctx = await browser.newContext({
      userAgent: ANDROID_CHROME,
      viewport: { width, height },
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    await page.goto(pagePath);
    await page.getByRole('link', { name: 'Save to this phone' }).first().click();
    const box = await page.getByRole('dialog', { name: 'Add to Home screen' }).boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    if (width < 640) expect(Math.round(box.y + box.height)).toBe(height);
    else expect(Math.abs(box.y + box.height / 2 - height / 2)).toBeLessThan(2);
    await ctx.close();
  }
  await admin.dispose();
});
