import { expect, type Page, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';
import { frame, seedByImport, shoot, THEMES, WIDTHS } from './helpers/issuing.ts';
import { readSeed } from './helpers/seed.ts';

// The issuing redesign's journeys, end to end. 30-import, 40-bulk-run and 41-change-run cover
// the mechanics (fix in place, bulk runs, change from a selection); these follow the three
// stories the redesign promised, and look at each at 3 widths and 2 themes.
test.use({ storageState: 'e2e/.auth/admin.json' });

const COUNT = 1240;
// Three unknown plans in 40 rows: the matcher maps a column by its values from 90% fit.
const ROWS = 40;
const importUrl = (orgId: string) => `/admin/passes/import?orgId=${encodeURIComponent(orgId)}`;

/** A shot at every width in both themes, then back to the working frame. */
async function sweep(page: Page, name: string): Promise<void> {
  for (const theme of THEMES)
    for (const width of WIDTHS) {
      await frame(page, width, theme);
      await shoot(page, name, width, theme);
    }
  await frame(page, 1440, 'light');
}

async function chooseTemplate(page: Page, orgId: string, name: string): Promise<void> {
  await page.goto(importUrl(orgId));
  await page.getByRole('combobox', { name: 'Template' }).click();
  await page.getByRole('option', { name }).click();
}

const tile = (page: Page, label: string, n: number) =>
  expect(page.getByRole('button', { name: new RegExp(`^${n}\\s*${label}`) })).toBeVisible();

test.beforeEach(async ({ page }) => frame(page, 1440, 'light'));

test('the sample CSV imports with 0 errors', async ({ page }, testInfo) => {
  const { org, template } = readSeed();
  await chooseTemplate(page, org.id, template.name);

  // The sample is the template's own: download it from the screen, then feed it back in.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download sample CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('sample.csv');
  const path = testInfo.outputPath('sample.csv');
  await download.saveAs(path);
  await page.locator('input[type=file]').setInputFiles(path);
  await expect(page.getByText(/1 row · \d+ columns/)).toBeVisible();
  await sweep(page, 'sample-1-source');
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Every column finds its field, and nothing is left to answer.
  await expect(page.getByRole('heading', { name: 'Match the columns' })).toBeVisible();
  await expect(page.getByText('All fields ready')).toBeVisible();
  await expect(page.getByText(/(\d+) of \1 columns used/)).toBeVisible();
  await sweep(page, 'sample-2-match');

  await page.getByRole('button', { name: /^Check/ }).click();
  await tile(page, 'New', 1);
  await tile(page, 'Needs a fix', 0);
  await expect(page.getByRole('table', { name: 'Problems' })).toHaveCount(0);
  await sweep(page, 'sample-3-check');

  await page.getByRole('button', { name: 'Import 1', exact: true }).click();
  await expect(page.getByText('1 done')).toBeVisible({ timeout: 60_000 });
  await sweep(page, 'sample-4-done');
});

test('the export: fix 3 rows, issue, undo', async ({ page }) => {
  const admin = await apiAs('admin');
  const { org, template } = readSeed();
  const tag = uid('EXP').toUpperCase();
  // A gym's export: its own column names, a name in two columns, US dates, a plan it calls Gold.
  const plans = ['standard', 'PLUS', 'Pro', 'Plus', 'standard', 'pro'];
  const first = ['Kai', 'Ana', 'Lee'];
  const last = ['Osei', 'Ruiz', 'Park'];
  const rows = Array.from({ length: ROWS }, (_, i) =>
    [
      `${tag.toLowerCase()}-${i}@example.test`,
      first[i % 3],
      last[i % 3],
      `${tag}-${2000 + i}`,
      [5, 9, 14].includes(i) ? 'Gold' : plans[i % plans.length],
      `${String((i % 12) + 1).padStart(2, '0')}/${String(13 + (i % 15)).padStart(2, '0')}/2030`,
      `L${i}`,
    ].join(','),
  );
  const csv = ['Email,First name,Last name,Member #,Membership,Expires,Locker', ...rows].join('\n');

  await chooseTemplate(page, org.id, template.name);
  await page.locator('input[type=file]').setInputFiles({
    name: 'members-export.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await expect(page.getByText(`${ROWS} rows · 7 columns`)).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // The matcher reads the export: a name join, Member # for the ID, the dates, the plan by value.
  await expect(page.getByRole('heading', { name: 'Match the columns' })).toBeVisible();
  await expect(page.getByText(/6 of 7 columns used/)).toBeVisible();
  await expect(page.getByText('Locker')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Option for Gold' })).toHaveText('Choose');
  await expect(page.getByText('1 value left; those rows will need a fix')).toBeVisible();
  await sweep(page, 'export-1-match');
  await page.getByRole('button', { name: /^Check/ }).click();

  // Three rows hold a plan the template does not have.
  await tile(page, 'New', ROWS - 3);
  await tile(page, 'Needs a fix', 3);
  await sweep(page, 'export-2-fix');
  // On a phone the Fix button sits inside the screen, not beyond a sideways scroll.
  await frame(page, 390, 'light');
  const firstFix = page.getByRole('button', { name: 'Fix Membership on row 7' });
  await firstFix.scrollIntoViewIfNeeded();
  await expect(firstFix).toBeInViewport({ ratio: 1 });
  await frame(page, 1440, 'light');
  for (const row of [7, 11, 16]) {
    await page.getByRole('button', { name: `Fix Membership on row ${row}` }).click();
    await page.getByRole('combobox', { name: new RegExp(`^Fix Membership on row ${row}`) }).click();
    await page.getByRole('option', { name: 'Plus' }).click();
  }
  await tile(page, 'New', ROWS);
  await tile(page, 'Needs a fix', 0);
  await sweep(page, 'export-3-fixed');

  // Issue with the email held, so the undo window is open.
  await page.getByRole('switch', { name: 'Email new holders' }).click();
  await page.getByRole('button', { name: `Create ${ROWS} passes`, exact: true }).click();
  await expect(page.getByText(`${ROWS} done`)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(new RegExp(`until ${ROWS} emails go out`))).toBeVisible();
  await sweep(page, 'export-4-issued');
  const ids = async () =>
    (await admin.get<{ items: { id: string }[] }>(`/api/v1/passes?orgId=${org.id}&q=${tag}`)).items;
  const issued = await ids();
  expect(issued).toHaveLength(ROWS);
  const removed = async (id: string) =>
    (await admin.get<{ removedAt: number | null }>(`/api/v1/passes/${id}`)).removedAt !== null;
  expect(await removed(issued[0]?.id as string)).toBe(false);

  // Undo takes all of them back out.
  await page.getByRole('button', { name: 'Undo import', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Undo import' }).click();
  await expect(page.getByText('Import undone')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(new RegExp(`Removed ${ROWS}`))).toBeVisible();
  // Nothing is left to change or to report on.
  await expect(page.getByRole('link', { name: 'Change these' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download results' })).toHaveCount(0);
  await expect(page.getByText('Created', { exact: true })).toHaveCount(0);
  await sweep(page, 'export-5-undone');
  for (const pass of [issued[0], issued.at(-1)])
    expect(await removed(pass?.id as string)).toBe(true);
  await admin.dispose();
});

test(`Change ${COUNT} passes, then undo`, async ({ browser }) => {
  test.setTimeout(600_000);
  const admin = await apiAs('admin');
  const { org, template } = readSeed();
  const { importId, prefix } = await seedByImport(admin, org.id, template.id, COUNT, {
    tier: 'Standard',
  });
  const tierOf = async (n: number) => {
    const list = await admin.get<{ items: { id: string }[] }>(
      `/api/v1/passes?orgId=${org.id}&q=${prefix}-${String(n).padStart(5, '0')}`,
    );
    const id = list.items[0]?.id as string;
    return (await admin.get<{ personalization: { tier?: string } }>(`/api/v1/passes/${id}`))
      .personalization.tier;
  };
  expect(await tierOf(0)).toBe('Standard');
  expect(await tierOf(COUNT - 1)).toBe('Standard');

  // The page opens after the seed: a browser left idle that long is not worth keeping.
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const page = await context.newPage();
  await frame(page, 1440, 'light');
  // From the import's results: Change these.
  await page.goto(`/admin/o/${org.id}/passes/import/${importId}`);
  await page.getByRole('link', { name: 'Change these' }).click();
  await expect(page).toHaveURL(/\/passes\/change/);
  await expect(page.getByText('1,240 passes of this import')).toBeVisible();

  await page.getByRole('button', { name: 'Add a field' }).click();
  await page.getByRole('combobox', { name: 'Field' }).click();
  await page.getByRole('option', { name: 'Tier' }).click();
  await page.getByRole('combobox', { name: 'Value' }).click();
  await page.getByRole('option', { name: 'Pro' }).click();
  await sweep(page, 'change-1-fields');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Notify holders' })).not.toBeChecked();
  await sweep(page, 'change-2-holders');
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(page.getByText('Will change')).toBeVisible();
  await sweep(page, 'change-3-review');
  await page.getByRole('button', { name: 'Change 1,240 passes' }).click();
  await expect(page.getByText('1,240 changed')).toBeVisible({ timeout: 300_000 });
  await sweep(page, 'change-4-done');
  // On a phone the undo note keeps a readable line of its own above the button.
  await frame(page, 390, 'light');
  const note = await page
    .getByText(/Restores silently/)
    .first()
    .boundingBox();
  expect(note?.width ?? 0).toBeGreaterThan(200);
  await frame(page, 1440, 'light');
  expect(await tierOf(0)).toBe('Pro');
  expect(await tierOf(COUNT - 1)).toBe('Pro');

  await page.getByRole('button', { name: 'Undo change' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Undo change' }).click();
  await expect(page.getByText(/Restored 1,240\./)).toBeVisible({ timeout: 300_000 });
  // The undo result stands alone: the change's own counters are gone.
  await expect(page.getByText('Already set')).toHaveCount(0);
  await sweep(page, 'change-5-undone');
  expect(await tierOf(0)).toBe('Standard');
  expect(await tierOf(COUNT - 1)).toBe('Standard');
  await context.close();
  await admin.dispose();
});
