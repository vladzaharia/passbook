import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { apiAs, createPass, requireActiveTemplateRelease, uid } from './helpers/api.ts';
import { templateFromBlueprint } from './helpers/releases.ts';
import { createOrgWithRoles } from './helpers/seed.ts';

const SHOTS = process.env.SHOTS_DIR;
const VIEWS = [
  [1440, 900],
  [820, 1100],
  [390, 844],
] as const;

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const [width, height] of VIEWS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      await page.screenshot({ path: `${SHOTS}/${name}-${width}-${scheme}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function serious(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

test.describe('All organizations passes', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });

  test('lists passes of two organizations, read-only, and opens a row in its own organization', async ({
    page,
  }) => {
    const api = await apiAs('admin');
    const made: { org: { id: string; name: string }; holder: string; id: string }[] = [];
    try {
      for (const label of ['All north', 'All harbor']) {
        const slug = uid(label.replace(' ', '-')).toLowerCase();
        const org = await createOrgWithRoles(api, { slug, name: `${label} ${slug}` });
        const template = await templateFromBlueprint(api, org.id, `${label} card`);
        const holder = uid(`${label} holder`);
        const pass = await createPass(api, org.id, {
          holder,
          release: await requireActiveTemplateRelease(api, org.id, template.id),
        });
        made.push({ org, holder, id: pass.id });
      }
    } finally {
      await api.dispose();
    }
    const [first, second] = made;
    if (!first || !second) throw new Error('Expected two organizations');

    const requests: URL[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === '/api/v1/passes') requests.push(url);
    });

    // The scope switcher offers All organizations.
    await page.goto(`/admin/o/${encodeURIComponent(first.org.id)}/passes`);
    await expect(page.getByRole('heading', { name: 'Passes', level: 1 })).toBeVisible();
    await page.getByRole('combobox', { name: /^Scope:/ }).click();
    await expect(page.getByRole('option', { name: 'All organizations' })).toBeVisible();
    expect(await serious(page)).toEqual([]);
    await page.getByRole('option', { name: 'All organizations' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/all/passes');

    // Both organizations' passes, each with its organization chip.
    const rowOf = (holder: string) => page.getByRole('row').filter({ hasText: holder });
    await expect(rowOf(first.holder)).toBeVisible();
    await expect(rowOf(second.holder)).toBeVisible();
    await expect(rowOf(first.holder)).toContainText(first.org.name);
    await expect(rowOf(second.holder)).toContainText(second.org.name);
    expect(requests.some((url) => url.searchParams.get('orgId') === 'all')).toBe(true);

    // Nothing to select, bulk-run or create here.
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    for (const name of ['New pass', 'Import', 'Photos']) {
      await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole('region', { name: 'Selection' })).toHaveCount(0);
    expect(await serious(page)).toEqual([]);
    await shoot(page, 'all-list');

    // Narrow to one organization.
    await page.getByRole('button', { name: /^Organization:/ }).click();
    await page.getByRole('checkbox', { name: new RegExp(second.org.name) }).click();
    await expect(rowOf(first.holder)).toHaveCount(0);
    await expect(rowOf(second.holder)).toBeVisible();
    expect(requests.some((url) => url.searchParams.get('orgIds') === second.org.id)).toBe(true);
    await page.keyboard.press('Escape');

    // A row opens the pass in its own organization; the crumb returns to the filtered All list.
    await page.getByRole('link', { name: second.holder }).click();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(`/admin/o/${encodeURIComponent(second.org.id)}/passes/${second.id}`);
    await expect(page.getByRole('heading', { name: second.holder, level: 1 })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Passes' })
      .click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/all/passes');
    expect(new URL(page.url()).searchParams.get('orgIds')).toBe(second.org.id);
    await expect(rowOf(second.holder)).toBeVisible();
  });

  test('keeps the Organization filter inside the viewport with many organizations', async ({
    page,
  }) => {
    const api = await apiAs('admin');
    let last = '';
    try {
      for (let n = 0; n < 24; n++) {
        const slug = uid('many').toLowerCase();
        last = `Many ${slug}`;
        const org = await createOrgWithRoles(api, { slug, name: last });
        if (n > 0) continue;
        const template = await templateFromBlueprint(api, org.id, 'Many card');
        await createPass(api, org.id, {
          holder: uid('Many holder'),
          release: await requireActiveTemplateRelease(api, org.id, template.id),
        });
      }
    } finally {
      await api.dispose();
    }
    for (const [width, height] of [
      [390, 844],
      [820, 1100],
      [1280, 720],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/admin/all/passes');
      await page.getByRole('button', { name: /^Organization:/ }).click();
      const panel = page.getByRole('dialog');
      await expect(panel).toBeVisible();
      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      if (!box) return;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      // The last choice scrolls into reach inside the panel and can be picked.
      await page.getByRole('checkbox', { name: new RegExp(last) }).click();
      await expect(page.getByRole('checkbox', { name: new RegExp(last) })).toBeChecked();
      await page.keyboard.press('Escape');
    }
  });
});
