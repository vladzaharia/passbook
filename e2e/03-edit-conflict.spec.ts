import { expect, test } from '@playwright/test';
import { apiAs, createPass } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

test('second editor gets 412, keeps the draft, and can merge', async ({ browser }) => {
  const api = await apiAs('admin');
  const pass = await createPass(api, readSeed().org.id, { holder: 'Conflict Original' });
  const url = `/admin/passes/${pass.id}`;

  const ctxA = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const ctxB = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await a.goto(url);
  await b.goto(url);
  await expect(a.getByLabel('Name')).toHaveValue('Conflict Original');
  await expect(b.getByLabel('Name')).toHaveValue('Conflict Original');

  // B saves first.
  await b.getByLabel('Name').fill('Saved by B');
  await b.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(b.getByText('Saved', { exact: true }).first()).toBeVisible();

  // A edits another field from the stale baseline; its save is rejected, draft kept.
  await a.getByLabel('Points').fill('77');
  const rejected = a.waitForResponse(
    (r) => r.url().includes(`/api/v1/passes/${pass.id}`) && r.request().method() === 'PATCH',
  );
  await a.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await rejected).status()).toBe(412);
  await expect(a.getByText('This pass changed since you opened it')).toBeVisible();
  await expect(a.getByLabel('Points')).toHaveValue('77');

  // Merge keeps A's edit on top of B's saved change, and the save then succeeds.
  await a.getByRole('button', { name: 'Merge my edits' }).click();
  await expect(a.getByLabel('Name')).toHaveValue('Saved by B');
  await expect(a.getByLabel('Points')).toHaveValue('77');
  await a.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(a.getByRole('button', { name: 'Save', exact: true })).toBeHidden();

  const final = await api.get(`/api/v1/passes/${pass.id}`);
  expect(final.personalization).toMatchObject({ holder: 'Saved by B', points: 77 });

  // Reload path: C edits, B saves again, A's reload drops its draft for the server state.
  await a.getByLabel('Points').fill('5');
  await b.reload();
  // Typing before the reloaded form has its data loses the edit when the data lands.
  await expect(b.getByLabel('Points')).toHaveValue('77');
  await b.getByLabel('Name').fill('Saved by B again');
  await b.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(b.getByText('Saved', { exact: true }).first()).toBeVisible();
  await a.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(a.getByRole('button', { name: 'Reload' })).toBeVisible();
  await a.getByRole('button', { name: 'Reload' }).click();
  await expect(a.getByLabel('Name')).toHaveValue('Saved by B again');
  await expect(a.getByLabel('Points')).toHaveValue('77');

  await ctxA.close();
  await ctxB.close();
  await api.dispose();
});

test('unsaved changes block navigation until confirmed', async ({ page }) => {
  const api = await apiAs('admin');
  const pass = await createPass(api, readSeed().org.id, { holder: 'Guard Original' });
  await page.goto(`/admin/passes/${pass.id}`);
  await page.getByLabel('Name').fill('Guard Edited');

  await page.getByRole('link', { name: 'Passes', exact: true }).first().click();
  const dialog = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/passes/${pass.id}`));
  await expect(page.getByLabel('Name')).toHaveValue('Guard Edited');

  await page.getByRole('link', { name: 'Passes', exact: true }).first().click();
  await dialog.getByRole('button', { name: 'Discard' }).click();
  await expect(page).toHaveURL(/\/admin\/passes(\?.*)?$/);
  await api.dispose();
});
