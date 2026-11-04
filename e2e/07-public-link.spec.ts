import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { MAC_SAFARI } from './helpers/devices.ts';
import { readPkpass } from './helpers/pkpass.ts';
import { readSeed } from './helpers/seed.ts';

test('public link works without sign-in and dies when rotated', async ({ browser }) => {
  const admin = await apiAs('admin');
  const holder = `Public ${uid('P')}`;
  const pass = await createPass(admin, readSeed().org.id, { holder });
  const detail = await admin.get(`/api/v1/passes/${pass.id}`);
  const publicPath = new URL(detail.publicUrl, 'http://localhost:5173').pathname;

  // Anonymous visitor on a Mac (the badge shows beside the QR): no cookies at all.
  const anon = await browser.newContext({ userAgent: MAC_SAFARI });
  const page = await anon.newPage();
  const response = await page.goto(publicPath);
  expect(response?.status()).toBe(200);
  await expect(page.locator('main').getByText(holder).first()).toBeVisible();
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');

  const link = page.getByRole('link', { name: 'Add to Apple Wallet' });
  const href = await link.getAttribute('href');
  expect(href).toContain('pass.pkpass');
  const downloadPromise = page.waitForEvent('download');
  await link.click();
  const download = await downloadPromise;
  const { names, passJson } = await readPkpass(download);
  expect(names).toEqual(expect.arrayContaining(['pass.json', 'manifest.json', 'signature']));
  expect(passJson.passTypeIdentifier).toBe('pass.im.plrs.wallet');
  const raw = await anon.request.get(href as string);
  expect(raw.headers()['content-type']).toContain('application/vnd.apple.pkpass');

  // Admin rotates the link from the UI.
  const adminCtx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const adminPage = await adminCtx.newPage();
  await adminPage.goto(`/admin/passes/${pass.id}`);
  await adminPage.getByRole('button', { name: 'More' }).click();
  await adminPage.getByRole('menuitem', { name: 'Rotate link' }).click();
  await adminPage.getByRole('alertdialog').getByRole('button', { name: 'Rotate' }).click();
  await expect(adminPage.getByText('Link rotated')).toBeVisible();

  const stale = await anon.request.get(publicPath);
  expect(stale.status()).toBe(404);
  expect((await anon.request.get(href as string)).status()).toBe(404);
  await page.goto(publicPath);
  await expect(page.getByRole('heading', { name: 'Link expired' })).toBeVisible();

  // The new link serves the pass.
  const fresh = await admin.get(`/api/v1/passes/${pass.id}`);
  expect(fresh.publicUrl).not.toBe(detail.publicUrl);
  const ok = await anon.request.get(new URL(fresh.publicUrl, 'http://localhost:5173').pathname);
  expect(ok.status()).toBe(200);

  await anon.close();
  await adminCtx.close();
  await admin.dispose();
});
