import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import type { OrgMembership } from '../src/shared/contracts/org-membership.ts';
import { apiAs } from './helpers/api.ts';

// Set PERSONAL_SHOTS to a folder to save 2 widths x 2 themes per screen.
const SHOTS = process.env.PERSONAL_SHOTS;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
] as const;

async function sweep(page: Page, url: string, name: string, ready: () => Promise<void>) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(url);
      await ready();
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: `${SHOTS}/${name}-${size.name}-${scheme}.png` });
      }
      const axe = await new AxeBuilder({ page }).analyze();
      expect(
        axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
      ).toEqual([]);
    }
  }
}

test.describe('personal orgs are private', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });

  test('the platform list leaves them out; the owner still opens their own', async ({ page }) => {
    const api = await apiAs('admin');
    let personalId: string;
    try {
      const mine = await api.get<{ items: OrgMembership[] }>('/api/v1/orgs/memberships/me');
      const personal = mine.items.find((m) => m.personal);
      expect(personal).toBeDefined();
      personalId = personal?.orgId ?? '';
      const list = await api.get<{ items: { id: string; personal: boolean }[] }>(
        '/api/v1/orgs?limit=200',
      );
      expect(list.items.some((o) => o.id === personalId || o.personal)).toBe(false);
      const own = await api.get<{ plan?: unknown; personal: boolean }>(
        `/api/v1/orgs/${personalId}`,
      );
      expect(own.personal).toBe(true);
    } finally {
      await api.dispose();
    }

    await sweep(page, '/admin/platform/orgs', 'platform-orgs', async () => {
      await expect(page.getByRole('heading', { name: 'Organizations', level: 1 })).toBeVisible();
      await expect(page.getByRole('table')).toBeVisible();
      await expect(page.getByRole('table').getByText('Personal', { exact: true })).toHaveCount(0);
    });
    await sweep(
      page,
      `/admin/o/${encodeURIComponent(personalId)}/settings`,
      'personal-settings',
      async () => {
        await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
      },
    );
  });
});
