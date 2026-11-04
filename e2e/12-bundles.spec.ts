import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { MAC_SAFARI } from './helpers/devices.ts';
import { readSeed } from './helpers/seed.ts';

const pathOf = (url: string) => new URL(url, 'http://localhost:5173').pathname;

test('bundle link serves its passes without sign-in and dies when rotated', async ({ browser }) => {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const a = await createPass(admin, orgId, { holder: `Bundle ${uid('A')}` });
  const b = await createPass(admin, orgId, { holder: `Bundle ${uid('B')}` });
  const name = `Weekend ${uid('W')}`;
  const bundle = await admin.send('POST', '/api/v1/bundles', {
    orgId,
    passIds: [a.id, b.id],
    name,
  });
  const path = pathOf(bundle.url);
  expect(path).toMatch(/^\/b\//);

  const anon = await browser.newContext({ userAgent: MAC_SAFARI });
  const page = await anon.newPage();
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  const all = await anon.request.get(`${path}/passes.pkpasses`);
  expect(all.status()).toBe(200);
  expect(all.headers()['content-type']).toContain('pkpasses');
  const one = await anon.request.get(`${path}/${a.id}/pass.pkpass`);
  expect(one.headers()['content-type']).toContain('application/vnd.apple.pkpass');

  await admin.send('POST', `/api/v1/bundles/${bundle.id}/rotate-link`);
  expect((await anon.request.get(path)).status()).toBe(404);
  expect((await anon.request.get(`${path}/passes.pkpasses`)).status()).toBe(404);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Link expired' })).toBeVisible();

  await anon.close();
  await admin.dispose();
});
