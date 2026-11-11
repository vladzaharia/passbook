import { expect, test } from '@playwright/test';
import { scanId } from '../src/web/scan/platform/id.ts';
import { apiAs, createPass, GENERIC, uid } from './helpers/api.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

test('event setup, scanner assignment and scan history undo', async ({ page }) => {
  const api = await apiAs('admin');
  const orgId = readSeed().org.id;
  const name = uid('Door event');
  const template = await api.send('POST', `/api/v1/templates/${GENERIC}/clone`, {
    orgId,
    name: uid('Event template'),
  });
  const release = await publishTemplateVersion(
    api,
    orgId,
    template.id,
    template.versions[0].version,
  );
  const scannerName = uid('Event scanner');
  const pass = await createPass(api, orgId, {
    holder: 'Admin Door Guest',
    templateId: template.id,
    release,
    memberId: uid('ADMINDOOR'),
  });
  try {
    await api.send('POST', '/api/v1/scan-setups', {
      orgId,
      name: scannerName,
      accepts: { templateIds: [template.id] },
      timeZone: 'UTC',
      settings: { reader: 'barcode', direction: 'in' },
    });
    await page.goto(`/admin/scanning?orgId=${orgId}&tab=events`);
    await page.getByRole('button', { name: 'New event', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await page.getByRole('checkbox', { name: template.name, exact: true }).check();
    const opens = new Date(Date.now() - 60_000);
    const closes = new Date(Date.now() + 3_600_000);
    const local = (date: Date) =>
      new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    await page.getByLabel('Scanning opens', { exact: true }).fill(local(opens));
    await page.getByLabel('Scanning closes', { exact: true }).fill(local(closes));
    await page
      .getByRole('textbox', { name: 'Note for staff', exact: true })
      .fill('Check the ticket name.');
    await expect(page.getByText('22/140')).toBeVisible();
    await page.getByRole('button', { name: 'Create event', exact: true }).click();
    await page.getByRole('link', { name, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Readiness' })).toBeVisible();
    await expect(page.getByText('Check the ticket name.')).toBeVisible();
    await page.getByRole('button', { name: 'Assign scanners', exact: true }).click();
    await page.getByRole('checkbox', { name: scannerName, exact: true }).check();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Assign scanners', exact: true })
      .click();
    await expect(page.getByText('0 of 1 scanners paired')).toBeVisible();
    await page.screenshot({ path: 'test-results/scanner-event-admin.png', fullPage: true });
    const outcome = await api.send('POST', '/api/v1/scan/actions', {
      scope: { orgId, timeZone: 'UTC' },
      input: { passId: pass.id, method: 'manual' },
      actionId: 'check_in',
      idempotencyKey: scanId(),
      clientTs: Date.now(),
    });
    expect(outcome.kind).toBe('ok');
    await page.goto(`/admin/scanning?orgId=${orgId}&tab=scans&q=Admin%20Door%20Guest`);
    const row = page.getByRole('row').filter({ hasText: 'Admin Door Guest' });
    await row.getByRole('button').click();
    await expect(page.getByRole('dialog', { name: 'Scan', exact: true })).toContainText(
      'Admin console',
    );
    await page.getByRole('button', { name: 'Undo check-in', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toContainText('The pass can be checked in again.');
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Undo check-in', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const undone = await api.get(
      `/api/v1/scans?orgId=${orgId}&outcome=undone&q=Admin%20Door%20Guest`,
    );
    expect(undone.items.some((r: { id: string }) => r.id === outcome.scanId)).toBe(true);
  } finally {
    await api.dispose();
  }
});
