import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { apiAs, createPass } from './helpers/api.ts';
import { readSeed } from './helpers/seed.ts';
import { stubTurnstile } from './helpers/turnstile.ts';

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes
        .slice(0, 4)
        .map((n) => `${n.target.join(' ')} :: ${n.failureSummary?.split('\n')[1] ?? ''}`),
    }));
}

const settle = async (page: Page, ready: () => Promise<void>) => {
  await ready();
  // Images (pass art) finish loading so contrast and alt checks see the final page.
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
};

test.describe('admin', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });
  let passId = '';
  test.beforeAll(async () => {
    const api = await apiAs('admin');
    passId = (await createPass(api, readSeed().org.id, { email: 'a11y@example.test' })).id;
    await api.dispose();
  });

  const pages: [string, () => string, RegExp][] = [
    ['overview', () => '/admin', /Overview/],
    ['passes list', () => '/admin/passes', /Passes/],
    ['pass detail', () => `/admin/passes/${passId}`, /Member|Name|Holder/],
    ['templates', () => '/admin/templates', /Templates/],
    ['connections', () => '/admin/connections', /Connections/],
    ['status', () => '/admin/status', /Status/],
    ['settings', () => '/admin/settings', /Settings/],
    ['audit', () => '/admin/audit', /Audit/],
    ['users', () => '/admin/users', /Users/],
    ['orgs', () => '/admin/orgs', /Orgs|Organizations/],
    ['identities', () => '/admin/identities', /Apple identities/],
    ['api keys', () => '/admin/api-keys', /API keys/],
  ];
  for (const scheme of ['light', 'dark'] as const) {
    for (const [name, path, heading] of pages) {
      test(`${name} has no serious or critical violations (${scheme})`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(path());
        await settle(page, () => expect(page.getByText(heading).first()).toBeVisible());
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
  }
});

test.describe('portal', () => {
  test.use({ storageState: 'e2e/.auth/user.json' });
  test('portal home has no serious or critical violations', async ({ page }) => {
    await page.goto('/');
    await settle(page, () =>
      expect(page.getByRole('heading', { name: 'My passes' })).toBeVisible(),
    );
    expect(await seriousViolations(page)).toEqual([]);
  });
});

test('login has no serious or critical violations', async ({ page }) => {
  await stubTurnstile(page);
  await page.goto('/login');
  await settle(page, () => expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible());
  expect(await seriousViolations(page)).toEqual([]);
});
