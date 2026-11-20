import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { apiAs, uid } from './helpers/api.ts';

// Set MT3_SHOTS to a folder to save the visual sweep: 3 widths x 2 themes per screen.
const SHOTS = process.env.MT3_SHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '820', width: 820, height: 1180 },
  { name: '390', width: 390, height: 844 },
] as const;

async function sweep(
  page: Page,
  url: string,
  name: string,
  ready: () => Promise<void>,
  fullPage = true,
) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(url);
      await ready();
      await page.screenshot({ path: `${SHOTS}/${name}-${size.name}-${scheme}.png`, fullPage });
    }
  }
}

test.describe('org features', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });
  test.describe.configure({ mode: 'serial' });

  test('a platform admin previews a preset, applies it, overrides a feature; audit records both', async ({
    page,
  }) => {
    const api = await apiAs('admin');
    const name = uid('Features');
    const org = await api.send<{ id: string }>('POST', '/api/v1/orgs', {
      name,
      slug: name.toLowerCase(),
      preset: 'legacy',
    });
    const url = `/admin/platform/orgs/${org.id}?tab=features`;
    const label = (text: string) => page.locator('label', { hasText: text }).first();
    const pick = async (preset: string) => {
      await label(preset).click();
      await expect(page.getByText(`${preset} instead of Legacy`)).toBeVisible();
    };
    const openForm = async () => {
      await page.getByRole('button', { name: 'Override Webhooks' }).click();
      await expect(page.getByRole('dialog', { name: 'Override Webhooks' })).toBeVisible();
    };
    try {
      await page.goto(url);
      await expect(page.getByRole('heading', { name: 'Preset', level: 2 })).toBeVisible();
      await expect(page.getByRole('radio', { name: /Legacy/ })).toBeChecked();
      const ready = async () => {
        await expect(page.getByRole('heading', { name: 'API and apps', level: 2 })).toBeVisible();
      };
      await sweep(page, url, 'features-default', ready);
      await sweep(page, url, 'features-pick', async () => {
        await ready();
        await pick('Trial');
      });
      await sweep(
        page,
        url,
        'features-confirm',
        async () => {
          await ready();
          await pick('Trial');
          await page.getByRole('button', { name: 'Apply Trial' }).click();
          await expect(page.getByRole('alertdialog')).toBeVisible();
          await page.waitForTimeout(300);
        },
        false,
      );

      // Apply Trial from the UI: nothing is saved until the confirm.
      await page.goto(url);
      await pick('Trial');
      await page.getByRole('button', { name: 'Apply Trial' }).click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Apply', exact: true })
        .click();
      await expect(page.getByRole('radio', { name: /Trial/ })).toBeChecked();
      await expect(page.getByText('Trial instead of')).toHaveCount(0);

      // One override with a note and an expiry, written through the API.
      const read = () =>
        api.get<{ revision: number }>(`/api/v1/platform/orgs/${org.id}/entitlements`);
      await api.send('PUT', `/api/v1/platform/orgs/${org.id}/entitlements`, {
        expectedRevision: (await read()).revision,
        preset: 'trial',
        overrides: {
          'api.keys': {
            value: 5,
            note: 'Pilot with Northwind',
            expiresAt: Date.now() + 30 * 86_400_000,
          },
        },
      });
      await sweep(
        page,
        url,
        'features-override-form',
        async () => {
          await ready();
          await openForm();
          await page.getByRole('radio', { name: 'On' }).click();
          await page.getByLabel('Note').fill('Pilot with Northwind, two weeks');
          await page.waitForTimeout(300);
        },
        false,
      );

      // Override Webhooks from the UI.
      await page.goto(url);
      await openForm();
      await page.getByRole('radio', { name: 'On' }).click();
      await page.getByLabel('Note').fill('Pilot with Northwind');
      await page.getByRole('button', { name: 'Continue' }).click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm.getByText('Changes 1 feature: 1 turns on.')).toBeVisible();
      await sweep(
        page,
        url,
        'features-override-confirm',
        async () => {
          await ready();
          await openForm();
          await page.getByRole('radio', { name: 'On' }).click();
          await page.getByRole('button', { name: 'Continue' }).click();
          await expect(page.getByRole('alertdialog')).toBeVisible();
          await page.waitForTimeout(300);
        },
        false,
      );
      await page.goto(url);
      await openForm();
      await page.getByRole('radio', { name: 'On' }).click();
      await page.getByLabel('Note').fill('Pilot with Northwind');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Override' }).click();
      await expect(page.locator('[data-row-id="webhooks"]').getByText('Override')).toBeVisible();

      await sweep(page, url, 'features-overridden', ready);

      // The platform audit shows what changed in the feature names.
      const audit = `/admin/platform/audit?filterOrgId=${org.id}`;
      await page.goto(audit);
      await expect(
        page.getByRole('button', { name: /Organization features changed/ }).first(),
      ).toBeVisible();
      await sweep(
        page,
        audit,
        'features-audit',
        async () => {
          await page
            .getByRole('button', { name: /Organization features changed/ })
            .first()
            .click();
          await expect(page.getByRole('heading', { name: 'What changed' })).toBeVisible();
          await page.waitForTimeout(400);
        },
        false,
      );

      // The page's other tab is unchanged.
      const overview = `/admin/platform/orgs/${org.id}`;
      await sweep(page, overview, 'features-overview', async () => {
        await expect(page.getByRole('tab', { name: 'Overview', selected: true })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Overview', level: 2 })).toBeVisible();
      });
    } finally {
      await api.dispose();
    }
  });
});
