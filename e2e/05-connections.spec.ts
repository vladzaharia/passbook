import { expect, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.setTimeout(120_000);

const SYNC_BUCKET_MS = 30_000;

test('demo connection: create, test, sync creates passes, resync updates them', async ({
  page,
}) => {
  const seed = readSeed();
  const name = `E2E Demo ${uid('c')}`;
  const domain = `${uid('d')}.example.test`;

  await page.goto('/admin/connections/new');
  await page.getByRole('combobox', { name: 'Organization', exact: true }).click();
  await page.getByRole('option', { name: seed.org.name }).click();
  await page.getByRole('radio', { name: /Demo/ }).check();
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByLabel(/^Name/).fill(name);
  await page.getByLabel('Count', { exact: true }).fill('3');
  await page.getByLabel('Holder Domain', { exact: true }).fill(domain);
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByRole('combobox', { name: 'Template', exact: true }).click();
  await page.getByRole('option', { name: 'Wallet · Generic' }).click();
  const mappings: [string, string][] = [
    ['holder', '/memberName'],
    ['memberId', '/memberId'],
    ['points', '/points'],
  ];
  for (const [i, [input, from]] of mappings.entries()) {
    await page.getByRole('button', { name: 'Add mapping' }).click();
    const group = page.getByRole('group', { name: `Mapping ${i + 1}` });
    await group.getByLabel('Template input').fill(input);
    await group.getByLabel('Upstream pointer').fill(from);
  }
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByLabel('Holder email field').fill('/email');
  await page.getByRole('switch', { name: 'Create passes for new records' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Create connection' }).click();
  await page.waitForURL(/\/admin\/connections\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const connectionId = page.url().split('/').pop() as string;

  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Test passed' })).toContainText(
    '3 demo records',
  );

  const firstBucket = Math.floor(Date.now() / SYNC_BUCKET_MS);
  await page.getByRole('button', { name: 'Sync now' }).click();
  const api = await apiAs('admin');
  await expect
    .poll(
      async () => (await api.get(`/api/v1/passes?connectionId=${connectionId}`)).items.length,
      { timeout: 60_000 },
    )
    .toBe(3);

  // The run shows in the runs list and health reads healthy.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('row', { name: /admin changed 3 seen, 3 changed/ })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByText('Failures in a row')).toBeVisible();
  await expect(page.getByText('Healthy', { exact: true })).toBeVisible();

  const passes = (await api.get(`/api/v1/passes?connectionId=${connectionId}`)).items;
  expect(passes.map((p: { holderEmail: string }) => p.holderEmail).sort()).toEqual(
    ['m-001', 'm-002', 'm-003'].map((r) => `${r}@${domain}`),
  );

  // Upstream changes: second sync updates the same passes instead of creating more.
  await api.send('PATCH', `/api/v1/connections/${connectionId}`, {
    config: { count: 3, holderDomain: domain, revision: 1 },
  });
  // Admin syncs in the same 30 s bucket share one workflow instance (by design), so wait it out.
  const wait = (firstBucket + 1) * SYNC_BUCKET_MS - Date.now();
  if (wait > 0) await page.waitForTimeout(wait + 500);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect
    .poll(
      async () => {
        const list = (await api.get(`/api/v1/passes?connectionId=${connectionId}`)).items;
        return list.every((p: { version: number }) => p.version >= 2) ? list.length : -1;
      },
      { timeout: 60_000 },
    )
    .toBe(3);
  await api.dispose();
});
