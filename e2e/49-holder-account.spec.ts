import { expect, test } from '@playwright/test';
import { apiAs, createPass, uid } from './helpers/api.ts';
import { signInHolder } from './helpers/holder.ts';
import { shoot, withAgent } from './helpers/holder-agents.ts';
import { readSeed } from './helpers/seed.ts';

// H9: one account page for a holder, and the portal's ended pass page (H4 in the portal).

async function holder() {
  const admin = await apiAs('admin');
  const email = `${uid('acct')}@example.test`;
  const pass = await createPass(admin, readSeed().org.id, { holder: `Acct ${uid('A')}`, email });
  return { admin, email, pass };
}

for (const theme of ['light', 'dark'] as const) {
  test(`the account page names the sign-in method and keeps the only email (${theme})`, async ({
    playwright,
  }) => {
    const h = await holder();
    await h.admin.dispose();
    await withAgent(
      playwright,
      'android',
      async (page) => {
        await signInHolder(page, h.email);
        await page.goto('/account');
        await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
        await expect(page.getByText('Email link', { exact: true })).toBeVisible();
        await expect(page.getByText('Primary', { exact: true })).toBeVisible();
        // With one email there is nothing to remove it for: the page says what to do first.
        await expect(page.getByText('Add another email first.')).toBeVisible();
        await expect(page.getByRole('button', { name: /^Remove/ })).toBeDisabled();
        await expect(page.getByText('This device')).toBeVisible();
        await shoot(page, 'account', theme);
      },
      { theme },
    );
  });
}

test('an ended pass in My passes shows the ended card, not a live card', async ({ playwright }) => {
  const h = await holder();
  await h.admin.send('POST', `/api/v1/passes/${h.pass.id}/void`, { reason: 'e2e' });
  await h.admin.dispose();
  for (const theme of ['light', 'dark'] as const) {
    await withAgent(
      playwright,
      'android',
      async (page) => {
        await signInHolder(page, h.email);
        await page.goto(`/passes/${h.pass.id}`);
        await expect(page.getByText(/^This pass was voided on /)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole('link', { name: 'Save to this phone' })).toHaveCount(0);
        await shoot(page, 'portal-ended', theme);
      },
      { theme },
    );
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`save to this phone: lead, sheet and saved states on the pass page (${theme})`, async ({
    playwright,
  }) => {
    const h = await holder();
    const detail = await h.admin.get(`/api/v1/passes/${h.pass.id}`);
    await h.admin.dispose();
    const path = new URL(detail.publicUrl, 'http://x.invalid').pathname;
    await withAgent(
      playwright,
      'android',
      async (page) => {
        await page.goto(path);
        await shoot(page, 'save-lead', theme);
        await page.getByRole('link', { name: 'Save to this phone' }).first().click();
        const sheet = page.getByRole('dialog', { name: 'Add to Home screen' });
        await expect(sheet).toBeVisible();
        await shoot(page, 'save-sheet', theme);
        await sheet.getByRole('button', { name: 'Done' }).click();
        await expect(page.getByText('On this phone · Works offline')).toBeVisible();
        await shoot(page, 'save-saved', theme);
      },
      { theme },
    );
  });
}
