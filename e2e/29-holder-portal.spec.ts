import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { signInHolder } from './helpers/holder.ts';
import { readSeed } from './helpers/seed.ts';

test('holder portal: list shows only my passes, detail opens, self-remove drops it from the list', async ({
  page,
}) => {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const email = `${uid('holder')}@example.test`;
  const mine = `Portal ${uid('A')}`;
  const second = `Portal ${uid('B')}`;
  const foreign = `Portal ${uid('F')}`;
  const own = await createPass(admin, orgId, { holder: mine, email });
  await createPass(admin, orgId, { holder: second, email });
  await createPass(admin, orgId, { holder: foreign, email: `${uid('other')}@example.test` });
  const trayStatuses: number[] = [];
  page.on('response', (res) => {
    if (new URL(res.url()).pathname === '/api/v1/operations') trayStatuses.push(res.status());
  });
  try {
    await signInHolder(page, email);
    await expect(page.getByRole('link', { name: mine, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: second, exact: true })).toBeVisible();
    // Positive control above; a pass issued to someone else never lists.
    await expect(page.getByRole('link', { name: foreign, exact: true })).toHaveCount(0);
    // The activity tray lists a holder's own operations: never a 403 on an email-link session.
    await expect.poll(() => trayStatuses.length).toBeGreaterThan(0);
    expect(trayStatuses.filter((s) => s >= 400)).toEqual([]);

    // The tile's name link is the keyboard path (shown on focus); pointers use the card.
    await page.getByRole('link', { name: mine, exact: true }).press('Enter');
    await page.waitForURL((u) => u.pathname === `/passes/${own.id}`);
    // The h1 names what the pass is, never the holder; the holder's name is a field on the card.
    // The route loads its chunk and the pass; on a loaded CI runner that can pass 5 s.
    await expect(page.getByRole('heading', { level: 1, name: 'Membership' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('group', { name: /front$/ })).toContainText(mine);
    // One details, untitled: the back of the pass, never the face's fields again.
    await expect(page.locator('.wl-holder-details').getByText('Terms')).toBeVisible();
    await expect(page.locator('.wl-holder-details')).not.toContainText(mine);

    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Remove from My passes' }).click();
    await page
      .getByRole('alertdialog', { name: 'Remove from my passes?' })
      .getByRole('button', { name: 'Remove' })
      .click();
    await page.waitForURL((u) => u.pathname === '/');
    await expect(page.getByRole('link', { name: second, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: mine, exact: true })).toHaveCount(0);
    const mineNow = await page.evaluate(async () => (await fetch('/api/v1/me/passes')).json());
    expect(mineNow.items.map((p: { id: string }) => p.id)).not.toContain(own.id);
  } finally {
    await admin.dispose();
  }
});
