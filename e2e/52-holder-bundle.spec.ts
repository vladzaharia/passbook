import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { pathOf, shoot, withAgent } from './helpers/holder-agents.ts';
import { readSeed } from './helpers/seed.ts';

// H7: /b on the shared stack, rendered statically, and H7b: each member saves to the phone.

async function bundleOf(mode: 'live' | 'test' = 'live') {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const make = (k: string) => createPass(admin, orgId, { holder: `${k} ${uid('B')}`, mode });
  const first = await make('First');
  const second = await make('Second');
  const gone = await make('Gone');
  if (mode === 'live')
    await admin.send('POST', `/api/v1/passes/${gone.id}/void`, { reason: 'e2e' });
  const bundle = await admin.send(
    'POST',
    '/api/v1/bundles',
    { orgId, passIds: [first.id, second.id, gone.id], name: `Trip ${uid('T')}` },
    { 'x-passbook-mode': mode },
  );
  await admin.dispose();
  return { path: pathOf(bundle.url), name: bundle.name as string, first, second, gone };
}

test('iPhone Safari: one "All passes" badge, one count line, voided peek named', async ({
  playwright,
}) => {
  const b = await bundleOf();
  await withAgent(playwright, 'iphone', async (page) => {
    await page.goto(b.path);
    await expect(page.getByRole('heading', { level: 1, name: b.name })).toBeVisible();
    const all = page.locator('a[href$="/passes.pkpasses"]').filter({ hasText: 'All passes (2)' });
    await expect(all).toHaveCount(1);
    await expect(all).toHaveAttribute('href', `${b.path}/passes.pkpasses`);
    // The count says only what is not live; the badge already says 2.
    await expect(page.getByText('1 voided', { exact: true })).toBeVisible();
    await expect(page.getByText(/^3 passes/)).toHaveCount(0);
    // No second badge per pass, and no Android way here.
    await expect(page.locator('a[href$="/pass.pkpass"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Show at the door' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Gone .*Voided/ })).toBeVisible();
    await shoot(page, 'bundle-iphone');
  });
});

test('Android Chrome: no Apple badge, every live member shows at the door, peeks are links', async ({
  playwright,
}) => {
  const b = await bundleOf();
  await withAgent(playwright, 'android', async (page) => {
    await page.goto(b.path);
    await expect(page.getByText('1 voided', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /^All passes/ })).toHaveCount(0);
    await expect(page.getByText('For Apple Wallet, open this page on an iPhone.')).toBeVisible();
    // Every live member shows at the door from its own row; the voided one has none.
    const doors = page.getByRole('link', { name: /^Show at the door/ });
    await expect(doors).toHaveCount(2);
    for (const pass of [b.first, b.second]) {
      await expect(doors.and(page.locator(`a[href$="/${pass.id}/barcode"]`))).toHaveCount(1);
    }
    await expect(page.getByRole('link', { name: /^Show at the door, Second / })).toBeVisible();
    // The folded details read as a disclosure: a chevron before the label.
    const chevron = await page
      .locator('.bd-more > summary')
      .evaluate((e) => getComputedStyle(e, '::before').content);
    expect(chevron).not.toBe('none');
    // A peek is the card's top 68 px, so a wrapped org name reads whole.
    expect(
      await page
        .locator('.wl-peek')
        .first()
        .evaluate((e) => e.getBoundingClientRect().height),
    ).toBe(68);
    // Static page: peeks follow their href with no script.
    await shoot(page, 'bundle-android');
    await page
      .getByRole('link', { name: /^Second / })
      .first()
      .click();
    await page.waitForURL(new RegExp(`^.*${b.path}/${b.second.id}$`));
    await expect(page.getByRole('link', { name: 'All passes' })).toHaveAttribute('href', b.path);
  });
});

test('a bundle member saves to the phone and shows at the door offline', async ({ playwright }) => {
  const b = await bundleOf();
  await withAgent(playwright, 'android', async (page, ctx) => {
    await page.goto(`${b.path}/${b.first.id}`);
    await page.getByRole('link', { name: 'Save to this phone' }).first().click();
    const sheet = page.getByRole('dialog', { name: 'Add to Home screen' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('On this phone · Works offline')).toBeVisible();
    await shoot(page, 'bundle-member-saved');
    const regs = await page.evaluate(async () =>
      (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname),
    );
    expect(regs).toEqual([`${b.path}/${b.first.id}/barcode`]);
    await page.getByRole('link', { name: 'Show at the door' }).first().click();
    await page.waitForURL(`**${b.path}/${b.first.id}/barcode`);
    await page.reload();
    await ctx.setOffline(true);
    await page.reload();
    await expect(page.locator('figure svg')).toBeVisible();
    await ctx.setOffline(false);
  });
});

test('Windows Chrome leads with the QR for the whole bundle', async ({ playwright }) => {
  const b = await bundleOf();
  await withAgent(playwright, 'windows', async (page) => {
    await page.goto(b.path);
    await expect(page.getByText('Scan with your iPhone camera.')).toBeVisible();
    await expect(page.locator('a[href$="/pass.pkpass"]')).toHaveCount(0);
    await shoot(page, 'bundle-windows');
  });
});

for (const theme of ['light', 'dark'] as const) {
  test(`a test bundle carries its ribbon (${theme})`, async ({ playwright }) => {
    const b = await bundleOf('test');
    await withAgent(
      playwright,
      'mac',
      async (page) => {
        await page.goto(b.path);
        await expect(
          page.getByText('Test bundle. It is not real and will be deleted.'),
        ).toBeVisible();
        await shoot(page, 'bundle-test', theme);
      },
      { theme },
    );
  });
}
