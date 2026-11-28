import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { apiAs, createPass } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';

// Set RETUI_SHOTS to a folder to save the visual sweep: 3 widths x 2 themes per screen.
const SHOTS = process.env.RETUI_SHOTS;
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
      await page.screenshot({
        path: `${SHOTS}/${name}-${size.name}-${scheme}.png`,
        fullPage,
      });
    }
  }
}

const receipts = {
  nextCursor: null,
  items: [
    ['scans', 12, 0, 396],
    ['events', 340, 0, 90],
    ['visitors', 4, 4, 90],
  ].map(([cls, deleted, anonymised, policyDays], i) => ({
    id: `r${i}`,
    cls,
    kind: 'sweep',
    ranAt: Date.UTC(2026, 10, 18 - i, 3, 0),
    cutoffAt: Date.UTC(2025, 9, 1),
    policyDays,
    deleted,
    anonymised,
    verified: i !== 2,
  })),
};

test.describe('retention console', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });
  test.describe.configure({ mode: 'serial' });

  test('an org admin places and releases a hold; audit shows both', async ({ page }) => {
    const org = readSeed().org;
    await page.goto(`/admin/o/${org.id}/retention`);
    await expect(page.getByRole('heading', { name: 'Retention', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Place hold' }).click();
    await page.getByLabel(/^Reason/).fill('Regulator inquiry');
    await page.getByRole('dialog').getByRole('button', { name: 'Place hold' }).click();
    await expect(page.getByText('Regulator inquiry')).toBeVisible();
    await expect(page.getByText('A legal hold is active.')).toBeVisible();
    await page.getByRole('button', { name: 'Release' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Release' }).click();
    await expect(page.getByText('Released', { exact: true })).toBeVisible();

    await page.goto(`/admin/o/${org.id}/audit`);
    await expect(page.getByRole('button', { name: 'Export' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Legal hold placed' }).first()).toBeVisible();
  });

  test('a setting change opens with old and new values', async ({ page }) => {
    const org = readSeed().org;
    const api = await apiAs('admin');
    try {
      const scope = `org:${org.id}`;
      const current = await api.get<{ configRevision?: number }>(`/api/v1/settings?scope=${scope}`);
      await api.send('PUT', '/api/v1/settings', {
        scope,
        values: { 'retention.scansDays': 300 },
        configRevision: current.configRevision,
      });
    } finally {
      await api.dispose();
    }
    await page.goto(`/admin/o/${org.id}/audit`);
    await page.getByRole('button', { name: 'Settings updated' }).first().click();
    await expect(page.getByRole('heading', { name: 'What changed' })).toBeVisible();
    await expect(page.getByText('Scans', { exact: true })).toBeVisible();
  });

  test('a PassBook hold is read-only for the org; visual sweep', async ({ page }) => {
    const org = readSeed().org;
    const api = await apiAs('admin');
    let holdId = '';
    try {
      await api.send('POST', `/api/v1/platform/orgs/${org.id}/retention/holds`, {
        reason: 'Preservation request',
      });
      const list = await api.get<{ items: { id: string; placedByKind: string }[] }>(
        `/api/v1/platform/orgs/${org.id}/retention/holds`,
      );
      holdId = list.items.find((h) => h.placedByKind === 'platform')?.id ?? '';
      await page.route('**/retention/receipts*', (route) => route.fulfill({ json: receipts }));
      await page.goto(`/admin/o/${org.id}/retention`);
      await expect(page.getByText('PassBook placed this hold')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Release' })).toHaveCount(0);

      const ready = (text: string | RegExp) => async () => {
        await expect(page.getByText(text).first()).toBeVisible();
        await page.waitForTimeout(300);
      };
      await sweep(
        page,
        `/admin/o/${org.id}/retention`,
        'org-retention',
        ready('Retention receipts'),
      );
      await sweep(page, `/admin/o/${org.id}/audit`, 'org-audit', ready('Audit log'));
      await sweep(
        page,
        `/admin/o/${org.id}/audit?entry=1`,
        'org-audit-detail',
        async () => {
          await page
            .getByRole('button', { name: /Settings updated/ })
            .first()
            .click();
          await expect(page.getByRole('heading', { name: 'What changed' })).toBeVisible();
          await page.waitForTimeout(400);
        },
        false,
      );
      await sweep(page, `/admin/platform/orgs/${org.id}`, 'platform-org', ready('Legal holds'));
      await sweep(page, '/admin/platform/audit', 'platform-audit', async () => {
        await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
        await page.waitForTimeout(300);
      });
      await sweep(page, '/admin/platform/settings', 'platform-settings', ready('Policy summary'));
    } finally {
      if (holdId)
        await api.send(
          'POST',
          `/api/v1/platform/orgs/${org.id}/retention/holds/${holdId}/release`,
          {},
        );
      await api.dispose();
    }
  });

  test('the audit export streams the whole log as CSV', async () => {
    const org = readSeed().org;
    const api = await apiAs('admin');
    try {
      const res = await api.ctx.get(`/api/v1/audit/export?orgId=${org.id}`);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('text/csv');
      const text = await res.text();
      expect(text.split('\r\n')[0]).toBe('Time (UTC),Action,Actor,Target,Organization');
      expect(text).toContain('retention.hold.place');
    } finally {
      await api.dispose();
    }
  });

  test('a pass hold is placed and released from the pass page; platform receipts page; sweep', async ({
    page,
  }) => {
    const org = readSeed().org;
    const api = await apiAs('admin');
    try {
      const pass = await createPass(api, org.id, { holder: 'Hold Test' });
      const url = `/admin/o/${org.id}/passes/${pass.id}`;
      await page.goto(url);
      await page.getByRole('button', { name: 'Place hold' }).click();
      await page.getByLabel(/^Reason/).fill('Dispute over this pass');
      await page.getByRole('dialog').getByRole('button', { name: 'Place hold' }).click();
      await expect(page.getByText('On this pass')).toBeVisible();
      await page.waitForTimeout(300);
      await sweep(page, url, 'pass-hold', async () => {
        await expect(page.getByText('On this pass')).toBeVisible();
        await page.waitForTimeout(300);
      });
      await page.route('**/api/v1/platform/retention/receipts*', (route) =>
        route.fulfill({ json: receipts }),
      );
      await sweep(page, '/admin/platform/retention', 'platform-retention', async () => {
        await expect(page.getByText('Visitor passes').first()).toBeVisible();
        await page.waitForTimeout(300);
      });
      await page.goto(url);
      await page.getByRole('button', { name: 'Release' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Release' }).click();
      await expect(page.getByRole('button', { name: 'Place hold' })).toBeVisible();
    } finally {
      await api.dispose();
    }
  });
});
