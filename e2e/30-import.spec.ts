import { expect, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

// Points is a hidden input since PS-19: the integer column is Guests left (0 to 99).
const HEAD = 'Name,MemberId,Tier,Guests,Email,Ref';
const row = (ref: string, name: string, guests: string) =>
  `${name},${ref}-M,Plus,${guests},${ref.toLowerCase()}@example.test,${ref}`;

test('import a sheet: fix the error file, commit, re-import as unchanged, remove what it created', async ({
  page,
}) => {
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
    await page.getByRole('button', { name: 'Check file' }).click();
    await expect(page).toHaveURL(/\/admin\/o\/[^/]+\/passes\/import\/[^/?]+/);
  };

  // 1. A file with a bad row: map the columns, check, and download the error file.
  await start([HEAD, ...good, bad].join('\n'));
  await expect(page.getByText('Match columns')).toBeVisible();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.getByText('2 to create · 0 to update · 0 unchanged · 1 error')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Problems' })).toContainText('Guests');
  const [errors] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download rows with errors' }).click(),
  ]);
  const text = (await (await errors.createReadStream()).toArray()).join('');
  expect(text).toContain('Problem');
  expect(text).toContain(refs[2] as string);

  // 2. Fix it and upload again: the saved mapping runs the check at once.
  await start([HEAD, ...good, row(refs[2] as string, 'Cy', '30')].join('\n'));
  await expect(page.getByText('3 to create · 0 to update · 0 unchanged · 0 errors')).toBeVisible();
  const first = page.url();

  // 3. Commit with email.
  await page.getByRole('button', { name: /^(Create|Update) \d+/ }).click();
  await page.getByRole('switch', { name: 'Email new holders' }).click();
  await page.getByRole('button', { name: 'Create 3', exact: true }).click();
  await expect(page.getByText('All rows done.')).toBeVisible({ timeout: 60_000 });
  const created = await admin.get<{ items: { id: string }[] }>(
    `/api/v1/passes?orgId=${org.id}&q=${encodeURIComponent(refs[0] as string)}`,
  );
  expect(created.items).toHaveLength(1);

  // 4. The same file again changes nothing.
  await start([HEAD, ...good, row(refs[2] as string, 'Cy', '30')].join('\n'));
  await expect(page.getByText('0 to create · 0 to update · 3 unchanged · 0 errors')).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Create|Update) \d+/ })).toBeDisabled();

  // 5. Results of the first run: download, then remove what it created.
  await page.goto(first);
  await expect(page.getByRole('heading', { name: 'Results' })).toBeVisible();
  const [results] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download results' }).click(),
  ]);
  expect((await (await results.createReadStream()).toArray()).join('')).toContain(
    refs[1] as string,
  );
  await page.getByRole('button', { name: 'Remove created passes' }).click();
  await page
    .getByRole('alertdialog', { name: 'Remove created passes?' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.getByText('3 passes removed')).toBeVisible();
  const detail = await admin.get<{ removedAt: number | null }>(
    `/api/v1/passes/${created.items[0]?.id}`,
  );
  expect(detail.removedAt).not.toBeNull();

  await admin.dispose();
});
