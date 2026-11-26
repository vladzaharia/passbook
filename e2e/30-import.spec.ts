import { expect, type Page, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

// Points is a hidden input since PS-19: the integer column is Guests left (0 to 99).
const HEAD = 'Name,MemberId,Tier,Guests,Email,Ref';
const row = (ref: string, name: string, guests: string) =>
  `${name},${ref}-M,Plus,${guests},${ref.toLowerCase()}@example.test,${ref}`;

test('import a sheet: fix in place, commit, re-import as unchanged, undo', async ({ page }) => {
  const admin = await apiAs('admin');
  const { org, template } = readSeed();
  const refs = [uid('IMP'), uid('IMP'), uid('IMP')].map((r) => r.toUpperCase());
  const good = [row(refs[0] as string, 'Ana', '10'), row(refs[1] as string, 'Ben', '20')];
  const bad = row(refs[2] as string, 'Cy', 'many');
  const upload = (csv: string) =>
    page.locator('input[type=file]').setInputFiles({
      name: 'people.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
  const start = async (csv: string) => {
    await page.goto(`/admin/passes/import?orgId=${encodeURIComponent(org.id)}`);
    await page.getByRole('combobox', { name: 'Template' }).click();
    await page.getByRole('option', { name: template.name }).click();
    await upload(csv);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/o\/[^/]+\/passes\/import\/[^/?]+/);
    await expect(page.getByRole('heading', { name: 'Match the columns' })).toBeVisible();
  };
  const check = () => page.getByRole('button', { name: /^Check/ }).click();
  const tile = (label: string, n: number) =>
    expect(page.getByRole('button', { name: new RegExp(`^${n}\\s*${label}`) })).toBeVisible();

  // 1. A file with a bad row: match the columns, check, download the error file, fix it in place.
  await start([HEAD, ...good, bad].join('\n'));
  await check();
  await tile('New', 2);
  await tile('Needs a fix', 1);
  await expect(page.getByRole('table', { name: 'Problems' })).toContainText('Guests');
  await expect(page.getByRole('table', { name: 'Problems' })).toContainText('many');
  const [errors] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download rows with errors' }).click(),
  ]);
  const text = (await (await errors.createReadStream()).toArray()).join('');
  expect(text).toContain('Problem');
  expect(text).toContain(refs[2] as string);
  await page.getByRole('button', { name: 'Fix Guests on row 4' }).click();
  await page.getByRole('textbox', { name: 'Fix Guests on row 4' }).fill('30');
  await page.keyboard.press('Enter');
  await tile('New', 3);
  await tile('Needs a fix', 0);
  const first = page.url();

  // 2. Commit with the email held for the default five minutes; the run card counts what it did.
  await page.getByRole('switch', { name: 'Email new holders' }).click();
  await page.getByRole('button', { name: 'Create 3 passes', exact: true }).click();
  await expect(page.getByText('3 done')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/until 3 emails go out/)).toBeVisible();
  const created = await admin.get<{ items: { id: string }[] }>(
    `/api/v1/passes?orgId=${org.id}&q=${encodeURIComponent(refs[0] as string)}`,
  );
  expect(created.items).toHaveLength(1);

  // 3. The same file again changes nothing.
  await start([HEAD, ...good, row(refs[2] as string, 'Cy', '30')].join('\n'));
  await check();
  await tile('Same', 3);
  await expect(page.getByRole('button', { name: /^(Create|Update) \d+/ })).toBeDisabled();

  // 4. Results of the first run: download, then undo what it created.
  await page.goto(first);
  await expect(page.getByRole('button', { name: 'Download results' })).toBeVisible();
  const [results] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download results' }).click(),
  ]);
  expect((await (await results.createReadStream()).toArray()).join('')).toContain(
    refs[1] as string,
  );
  await page.getByRole('button', { name: 'Undo import' }).click();
  await page
    .getByRole('alertdialog', { name: 'Undo this import?' })
    .getByRole('button', { name: 'Undo import' })
    .click();
  await expect(page.getByText(/Removed 3 · Restored 0 · 3 emails cancelled/)).toBeVisible();
  const detail = await admin.get<{ removedAt: number | null }>(
    `/api/v1/passes/${created.items[0]?.id}`,
  );
  expect(detail.removedAt).not.toBeNull();

  await admin.dispose();
});

async function importSample(page: Page) {
  const { org, template } = readSeed();
  await page.goto(`/admin/passes/import?orgId=${encodeURIComponent(org.id)}`);
  await page.getByRole('combobox', { name: 'Template' }).click();
  await page.getByRole('option', { name: template.name }).click();
  const [sample] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download sample CSV' }).click(),
  ]);
  const text = (await (await sample.createReadStream()).toArray()).join('');
  await page.locator('input[type=file]').setInputFiles({
    name: 'sample.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(text),
  });
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Match the columns' })).toBeVisible();
}

test('the template sample file maps in full', async ({ page }) => {
  await importSample(page);
  await expect(page.getByText('All fields ready')).toBeVisible();
});

test('the template sample file checks with no errors', async ({ page }) => {
  await importSample(page);
  await page.getByRole('button', { name: /^Check/ }).click();
  await expect(page.getByRole('button', { name: /^1\s*New/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^0\s*Needs a fix/ })).toBeVisible();
});

test('an unreadable choice shows the cell as written in Needs a fix', async ({ page }) => {
  const { org, template } = readSeed();
  const ref = uid('ENM').toUpperCase();
  await page.goto(`/admin/passes/import?orgId=${encodeURIComponent(org.id)}`);
  await page.getByRole('combobox', { name: 'Template' }).click();
  await page.getByRole('option', { name: template.name }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'tier.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from([HEAD, row(ref, 'Kai', '3').replace(',Plus,', ',Gold,')].join('\n')),
  });
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Match the columns' })).toBeVisible();
  await page.getByRole('button', { name: /^Check/ }).click();
  await expect(page.getByRole('table', { name: 'Problems' })).toContainText('Gold');
});
