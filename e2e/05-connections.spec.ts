import { expect, test } from '@playwright/test';
import { apiAs, GENERIC, requireActiveTemplateRelease, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.setTimeout(120_000);

/** ADMIN_SYNC_BUCKET_MS in tools/e2e-server.ts. */
const SYNC_BUCKET_MS = 2_000;

test('demo connection: create, test, sync creates passes, resync updates them', async ({
  page,
}) => {
  const seed = readSeed();
  const api = await apiAs('admin');
  const release = await requireActiveTemplateRelease(api, seed.org.id, GENERIC, 'live');
  const name = `E2E Demo ${uid('c')}`;
  const domain = `${uid('d')}.example.test`;

  await page.goto('/admin/connections/new');
  await page.getByRole('combobox', { name: /^Organization filter/ }).click();
  await page.getByRole('option', { name: seed.org.name }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('orgId')).toBe(seed.org.id);
  await page.getByText('Demo', { exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByLabel(/^Name/).fill(name);
  await page.getByLabel('Members', { exact: true }).fill('3');
  await page.getByLabel('Holder domain', { exact: true }).fill(domain);
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByRole('combobox', { name: 'Template', exact: true }).click();
  await page.getByRole('option', { name: 'PassBook · Generic' }).click();
  const mappings: [string, string][] = [
    ['Name *', '/memberName'],
    ['ID *', '/memberId'],
    ['Points', '/points'],
  ];
  for (const [i, [field, from]] of mappings.entries()) {
    await page.getByRole('button', { name: 'Add mapping' }).click();
    const row = page.getByRole('list', { name: 'Mappings' }).getByRole('listitem').nth(i);
    await row.getByRole('combobox', { name: 'Source field' }).click();
    await page.getByRole('option', { name: from, exact: true }).click();
    await row.getByRole('combobox', { name: 'Template field' }).click();
    await page.getByRole('option', { name: field, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByLabel('Holder email', { exact: true }).fill('/email');
  await page.getByRole('checkbox', { name: 'Create passes for new records' }).check();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL((url) => /^\/admin\/connections\/[0-9a-f-]+$/.test(url.pathname));
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('orgId')).toBe(seed.org.id);
  const connectionId = new URL(page.url()).pathname.split('/').pop() as string;

  // The Created callout repeats Test and Sync now beside the page's own; both run the same action.
  await expect(page.getByText('Connection created', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Test', exact: true }).first().click();
  await expect(page.getByRole('status').filter({ hasText: 'Test passed' })).toContainText(
    '3 demo records',
  );

  const syncResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/connections/${connectionId}/sync`) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sync now' }).first().click();
  const firstRun = (await (await syncResponse).json()) as { workflowInstanceId: string };
  const firstBucket = Number(firstRun.workflowInstanceId.split('-').at(-1));
  expect(Number.isSafeInteger(firstBucket)).toBe(true);
  const passList = `/api/v1/passes?orgId=${encodeURIComponent(seed.org.id)}&connectionId=${encodeURIComponent(connectionId)}`;
  await expect
    .poll(async () => (await api.get(passList)).items.length, {
      timeout: 60_000,
    })
    .toBe(3);

  // The run shows in the runs list and health reads healthy.
  await expect(async () => {
    await page.reload();
    await expect(
      page.getByRole('row', { name: /Sync now.*Changed.*3 seen, 3 changed/i }),
    ).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByText('Paused after repeated failures')).toBeVisible();
  await expect(page.getByText('Healthy', { exact: true })).toBeVisible();

  const passes = (await api.get(passList)).items;
  for (const pass of passes) {
    expect(pass).toMatchObject({
      orgId: seed.org.id,
      templateId: GENERIC,
      templateVersion: release.version,
      mode: 'live',
    });
  }
  expect(passes.map((p: { holderEmail: string }) => p.holderEmail).sort()).toEqual(
    ['m-001', 'm-002', 'm-003'].map((r) => `${r}@${domain}`),
  );

  // Upstream changes: second sync updates the same passes instead of creating more.
  await api.send('PATCH', `/api/v1/connections/${connectionId}`, {
    config: { count: 3, holderDomain: domain, revision: 1 },
  });
  // Admin syncs in the same bucket share one workflow instance (by design): wait for the next one.
  await expect.poll(() => Math.floor(Date.now() / SYNC_BUCKET_MS) > firstBucket).toBe(true);
  const resyncResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/connections/${connectionId}/sync`) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sync now' }).first().click();
  const nextRun = (await (await resyncResponse).json()) as { workflowInstanceId: string };
  expect(nextRun.workflowInstanceId).not.toBe(firstRun.workflowInstanceId);
  await expect
    .poll(
      async () => {
        const list = (await api.get(passList)).items;
        return list.every((p: { version: number }) => p.version >= 2) ? list.length : -1;
      },
      { timeout: 60_000 },
    )
    .toBe(3);
  await api.dispose();
});
