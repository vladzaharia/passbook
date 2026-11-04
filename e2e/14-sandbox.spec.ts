import { expect, test } from '@playwright/test';
import { apiAs, GENERIC, uid } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

test('Test mode marks a test pass, keeps its email in the Test inbox and out of live lists', async ({
  page,
}) => {
  const admin = await apiAs('admin');
  const orgId = readSeed().org.id;
  const name = `Sandbox ${uid('S')}`;
  const to = `${uid('sandbox').toLowerCase()}@example.test`;
  const search = `/admin/passes?q=${encodeURIComponent(name)}`;

  await page.goto('/admin/passes');
  const toggle = page.getByRole('switch', { name: 'Test mode' });
  await toggle.click();
  await expect(toggle).toBeChecked();
  const band = page.getByRole('status').filter({ hasText: 'Test mode' });
  await expect(band).toBeVisible();

  const pass = await admin.send(
    'POST',
    '/api/v1/passes',
    {
      orgId,
      templateId: GENERIC,
      input: { holder: name, memberId: uid('ID').toUpperCase() },
      holderEmail: to,
      sendEmail: true,
    },
    { 'Idempotency-Key': uid('idem'), 'x-passbook-mode': 'test' },
  );
  expect(pass.mode).toBe('test');

  await page.goto(search);
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: /^Test\. / })).toBeVisible();
  await page.goto(`/admin/passes/${pass.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name);
  await expect(page.locator('main').getByText('Test', { exact: true }).first()).toBeVisible();
  await expect(band).toBeVisible();

  // The queue captures the email shortly after the pass is created.
  await page.goto('/admin/test-inbox');
  const mail = page.getByRole('listitem').filter({ hasText: `To ${to}` });
  await expect
    .poll(
      async () => {
        await page.reload();
        await page.getByRole('heading', { name: 'Test inbox' }).waitFor();
        return mail.count();
      },
      { intervals: [1_000, 2_000], timeout: 30_000 },
    )
    .toBe(1);
  await mail.getByRole('link').click();
  await expect(page.getByTitle('Email preview')).toBeVisible();

  const live = await admin.get(`/api/v1/passes?q=${encodeURIComponent(name)}`);
  expect(live.items).toEqual([]);
  const outbox = await admin.get(`/api/v1/passes/${pass.id}/events?group=delivery`);
  expect(outbox.items.map((e: { kind: string }) => e.kind)).toContain('email.captured');

  await page.goto(search);
  await page.getByRole('switch', { name: 'Test mode' }).click();
  await expect(band).toBeHidden();
  await expect(page.getByText('No passes match')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);

  await admin.dispose();
});
