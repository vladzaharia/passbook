import { execFileSync } from 'node:child_process';
import { expect, type Page, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';
import { cloneMemberBarcode } from './helpers/member-barcode.ts';
import { pairScanner } from './helpers/pair.ts';
import { publishTemplateVersion } from './helpers/releases.ts';
import { readSeed } from './helpers/seed.ts';

test.use({ storageState: 'e2e/.auth/admin.json' });

/** The server flags a person whose PIN it sees shared (worker tests cover how); here the flag is set directly. */
function flag(id: string) {
  execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'passbook-platform',
      '--local',
      '--persist-to',
      '.wrangler/e2e-state',
      '--command',
      `UPDATE scan_staff SET pin_reset_required = 1 WHERE id = '${id}'`,
    ],
    { stdio: 'pipe' },
  );
}

const keys = async (page: Page, digits: string) => {
  for (const digit of digits) await page.getByRole('button', { name: digit, exact: true }).click();
};

test('a flagged PIN: name sign-in, a server PIN shown and typed back, then PIN-only works and the old PIN misses', async ({
  browser,
}) => {
  const api = await apiAs('admin');
  const orgId = readSeed().org.id;
  const template = await cloneMemberBarcode(api, orgId, uid('Reset template'));
  await publishTemplateVersion(api, orgId, template.id, template.versions[0].version);
  const name = uid('Reset Door');
  const made = await api.send('POST', '/api/v1/scan-staff', { orgId, name, role: 'door' });
  const oldPin: string = made.pin;
  const staffId: string = made.staff.id;
  flag(staffId);
  const scanner = async () => {
    const created = await api.send('POST', '/api/v1/scanners', {
      orgId,
      name: uid('Reset door'),
      kind: 'device',
      accepts: { templateIds: [template.id] },
      timeZone: 'UTC',
      settings: { reader: 'barcode', staffSignIn: true },
    });
    const context = await browser.newContext({
      reducedMotion: 'reduce',
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await pairScanner(page, created.pairing.code);
    return { context, page };
  };
  const contexts: Awaited<ReturnType<typeof scanner>>['context'][] = [];
  try {
    // Name and the flagged PIN sign in, then the new PIN is asked for before anything else.
    const first = await scanner();
    contexts.push(first.context);
    await first.page.getByRole('button', { name: 'Not you? Pick your name' }).click();
    await first.page.getByRole('combobox', { name: 'Staff member' }).click();
    await first.page.getByRole('option', { name }).click();
    await first.page.getByLabel('PIN').fill(oldPin);
    await first.page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(first.page.getByRole('heading', { name: 'New PIN' })).toBeVisible();
    await first.page.getByRole('button', { name: 'Get new PIN' }).click();
    const shown = first.page.getByTestId('new-pin');
    await expect(shown).toBeVisible();
    const newPin = (await shown.textContent())?.trim() ?? '';
    expect(newPin).toMatch(/^\d{6}$/);
    expect(newPin).not.toBe(oldPin);
    await first.page.getByRole('button', { name: 'I remember it' }).click();
    await keys(first.page, newPin);
    await expect(first.page.getByRole('heading', { name: 'New PIN' })).toBeHidden();
    await expect(first.page.getByTestId('scan-start')).toBeVisible();

    // The new PIN alone signs in on another device; the old one is a plain miss.
    const second = await scanner();
    contexts.push(second.context);
    await keys(second.page, oldPin);
    await expect(second.page.getByText(/Wrong PIN/)).toBeVisible();
    await keys(second.page, newPin);
    await expect(second.page.getByTestId('scan-start')).toBeVisible();
  } finally {
    for (const context of contexts) await context.close();
  }
});
