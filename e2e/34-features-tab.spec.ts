import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { apiAs, apiFrom, uid } from './helpers/api.ts';
import { saveState, startOidcAs } from './helpers/auth.ts';

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
      await expect(page.getByText(`${preset} instead of Unlimited`).first()).toBeVisible();
    };
    const openForm = async () => {
      await page.getByRole('button', { name: 'Override Webhooks' }).click();
      await expect(page.getByRole('dialog', { name: 'Override Webhooks' })).toBeVisible();
    };
    try {
      await page.goto(url);
      await expect(page.getByRole('heading', { name: 'Plan', level: 2 })).toBeVisible();
      await expect(page.getByRole('radio', { name: 'Unlimited' })).toBeChecked();
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

  test('a platform admin edits a preset: it moves the orgs on it, and the dialog passes axe', async ({
    page,
  }) => {
    // Changing a preset that has orgs on it needs a recent sign-in; a long CI shard's session is stale.
    await startOidcAs(page, 'admin', '/admin', 'prompt=login&max_age=0&');
    await page.waitForURL(/\/admin/);
    await saveState(page, 'admin');
    const api = { ...(await apiFrom(page.context().request)), dispose: async () => {} };
    const name = uid('Presets');
    const org = await api.send<{ id: string }>('POST', '/api/v1/orgs', {
      name,
      slug: name.toLowerCase(),
      preset: 'trial',
    });
    const presetOf = async () =>
      (
        await api.get<{
          presets: { preset: string; revision: number; values: Record<string, unknown> }[];
        }>('/api/v1/platform/entitlement-presets')
      ).presets.find((p) => p.preset === 'trial');
    const before = await presetOf();
    const url = `/admin/platform/orgs/${org.id}?tab=features`;
    try {
      await page.goto(url);
      await page.getByRole('button', { name: 'Edit presets' }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit presets' });
      await expect(dialog.getByRole('combobox', { name: /Feature/ })).toBeVisible();
      await sweep(
        page,
        url,
        'presets-dialog',
        async () => {
          await page.getByRole('button', { name: 'Edit presets' }).click();
          await expect(dialog.getByRole('combobox', { name: /Feature/ })).toBeVisible();
          await page.waitForTimeout(300);
        },
        false,
      );
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const found = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          found.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
          scheme,
        ).toEqual([]);
      }
      await page.goto(url);
      await page.getByRole('button', { name: 'Edit presets' }).click();
      await dialog.getByRole('combobox', { name: /Feature/ }).click();
      await page.getByRole('option', { name: /^Members/ }).click();
      await dialog.getByRole('spinbutton', { name: 'Limit' }).fill('4');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm.getByRole('heading', { name: 'Change Trial?' })).toBeVisible();
      await sweep(
        page,
        url,
        'presets-confirm',
        async () => {
          await page.getByRole('button', { name: 'Edit presets' }).click();
          await dialog.getByRole('combobox', { name: /Feature/ }).click();
          await page.getByRole('option', { name: /^Members/ }).click();
          await dialog.getByRole('spinbutton', { name: 'Limit' }).fill('4');
          await dialog.getByRole('button', { name: 'Continue' }).click();
          await expect(page.getByRole('alertdialog')).toBeVisible();
          await page.waitForTimeout(300);
        },
        false,
      );
      await page.goto(url);
      await page.getByRole('button', { name: 'Edit presets' }).click();
      await dialog.getByRole('combobox', { name: /Feature/ }).click();
      await page.getByRole('option', { name: /^Members/ }).click();
      await dialog.getByRole('spinbutton', { name: 'Limit' }).fill('4');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Change' }).click();
      await expect.poll(async () => (await presetOf())?.values.members).toBe(4);
      const moved = await api.get<{ items: { key: string; value: unknown }[] }>(
        `/api/v1/platform/orgs/${org.id}/entitlements`,
      );
      expect(moved.items.find((i) => i.key === 'members')?.value).toBe(4);
    } finally {
      // The preset is shared with other specs: put it back.
      const now = await presetOf();
      if (now && before && now.values.members !== before.values.members)
        await api.send('PUT', '/api/v1/platform/entitlement-presets', {
          preset: 'trial',
          expectedRevision: now.revision,
          values: { members: before.values.members },
        });
      await api.dispose();
    }
  });

  test('an org with no features row says so and offers one Apply plan action', async ({ page }) => {
    const api = await apiAs('admin');
    try {
      const name = uid('Nofeatures');
      const org = await api.send<{ id: string }>('POST', '/api/v1/orgs', {
        name,
        slug: name.toLowerCase(),
      });
      const real = await api.get<Record<string, unknown>>(
        `/api/v1/platform/orgs/${org.id}/entitlements`,
      );
      // The row cannot be removed through the app (that is the point), so the read is faked.
      const empty = {
        ...real,
        preset: null,
        presetLabel: null,
        revision: 0,
        updatedAt: null,
        items: [],
      };
      await page.route(`**/api/v1/platform/orgs/${org.id}/entitlements`, (route) =>
        route.request().method() === 'GET' ? route.fulfill({ json: empty }) : route.continue(),
      );
      const url = `/admin/platform/orgs/${org.id}?tab=features`;
      await page.goto(url);
      await expect(page.getByText('No features set')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Apply plan' })).toBeDisabled();
      await page.locator('label', { hasText: 'Standard' }).first().click();
      await expect(page.getByRole('button', { name: 'Apply plan' })).toBeEnabled();
      await sweep(page, url, 'features-empty', async () => {
        await expect(page.getByText('No features set')).toBeVisible();
        await page.locator('label', { hasText: 'Standard' }).first().click();
      });
    } finally {
      await api.dispose();
    }
  });
});
