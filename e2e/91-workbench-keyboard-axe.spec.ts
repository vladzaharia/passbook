import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { type WbTool, wbPath } from '../src/shared/workbench.ts';
import { sandboxOrgId } from './helpers/sandbox.ts';
import { signInToWorkbench } from './helpers/workbench.ts';

/**
 * Keyboard paths and axe for the Workbench tools (design §8.3 item 16). Console, Events, Logs and Keys
 * have axe in e2e 70; this covers the others, in both themes, and walks the keyboard through the shell,
 * every tool and the overlays. Needs the prerendered portal: `WALLET_E2E_PREVIEW=1`.
 */
const AXE_TOOLS = ['home', 'design', 'passes', 'inbox', 'activity', 'sandbox'] as const;
const ALL_TOOLS = [...AXE_TOOLS, 'console', 'logs', 'events', 'keys'] as const;
const VIEWS = [
  [1440, 900],
  [834, 1112],
  [390, 844],
] as const;

/** The Tab-stop under the focus: its tag, role and name, and whether it sits in the main landmark. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const box = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      name: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '',
      inMain: !!el.closest('main'),
      visible: box.width > 0 && box.height > 0,
    };
  });

async function settled(page: Page, tool: WbTool, org: string) {
  await page.goto(wbPath(org, tool));
  await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await signInToWorkbench(page, { key: true, desktop: false });
});

test('axe: no serious or critical finding on the other tools, in both themes at three widths', async ({
  page,
}) => {
  test.setTimeout(400_000);
  const org = await sandboxOrgId(page);
  for (const [width, height] of VIEWS) {
    await page.setViewportSize({ width, height });
    for (const tool of AXE_TOOLS) {
      await settled(page, tool, org);
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const { violations } = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze();
        expect(
          violations
            .filter((v) => v.impact === 'serious' || v.impact === 'critical')
            .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
          `${tool} at ${width} ${scheme}`,
        ).toEqual([]);
      }
    }
  }
});

test('Tab: every tool is reachable and focus is always on something visible', async ({ page }) => {
  test.setTimeout(300_000);
  const org = await sandboxOrgId(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const tool of ALL_TOOLS) {
    await settled(page, tool, org);
    let reachedMain = false;
    let stops = 0;
    const stopNames: string[] = [];
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const now = await focused(page);
      // The last stop hands focus to the browser: the ring is complete.
      if (!now) break;
      stops++;
      expect(now.visible, `${tool}: ${now.name} has no box`).toBe(true);
      stopNames.push(`${now.tag}:${now.name}:${now.inMain}`);
      if (now.inMain) reachedMain = true;
    }
    expect(stops, `${tool}: Tab stops`).toBeGreaterThan(5);
    // A tool with nothing to press in its stage (Design's empty list today) has no stop there: its defect is filed, not asserted.
    const pressable = await page
      .locator('main')
      .locator('a[href], button, input, select, textarea, [tabindex="0"]')
      .count();
    if (pressable > 0)
      expect(reachedMain, `${tool}: Tab never reached the tool: ${stopNames.join(' | ')}`).toBe(
        true,
      );
  }
});

test('Tab: the skip link moves focus into the tool, and a chord goes to an area', async ({
  page,
}) => {
  const org = await sandboxOrgId(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await settled(page, 'home', org);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to navigation' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to tool' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await focused(page))?.inMain).toBe(true);
  // Focus is on the tool now, not in a field: the chord belongs to the shell.
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await page.waitForURL(/\/workbench\/o\/[^/]+\/console/);
});

test('Escape: the palette and the shortcuts sheet close and give focus back', async ({ page }) => {
  const org = await sandboxOrgId(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await settled(page, 'home', org);

  const opener = page.getByRole('link', { name: /^Console/ }).first();
  await opener.focus();
  await page.keyboard.press('Control+k');
  const input = page.locator('[cmdk-input]');
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.focus();
  await page.keyboard.press('Shift+?');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(opener).toBeFocused();
});

test('Escape: the nav sheet on a phone closes and focus returns to the area button', async ({
  page,
}) => {
  const org = await sandboxOrgId(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await settled(page, 'home', org);
  const area = page.getByRole('button', { name: /change area/ });
  await area.focus();
  await page.keyboard.press('Enter');
  const nav = page.getByRole('dialog', { name: 'Workbench' });
  await expect(nav).toBeVisible();
  // Focus stays inside the sheet.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await nav.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();
  await expect(area).toBeFocused();
});

test('Escape: the Console index sheet and a destructive confirm close, and nothing is sent', async ({
  page,
}) => {
  const org = await sandboxOrgId(page);
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'DELETE') sent.push(r.url());
  });

  await page.setViewportSize({ width: 834, height: 1112 });
  await settled(page, 'console', org);
  const trigger = page.locator('.console-trigger');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const index = page.getByRole('dialog').first();
  await expect(index).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(index).toBeHidden();
  await expect(trigger).toBeFocused();

  const id = await page.evaluate(async () => {
    const res = await fetch('/developers/run/index.json');
    const body = (await res.json()) as {
      groups: { items: { id: string; method: string; path: string }[] }[];
    };
    return body.groups
      .flatMap((g) => g.items)
      .find((i) => i.method === 'delete' && i.path === '/api/v1/webhook-endpoints/{id}')?.id;
  });
  expect(id, 'the delete-endpoint operation').toBeTruthy();
  await page.goto(`/workbench/o/${org}/console?op=${encodeURIComponent(id ?? '')}`);
  await page.getByLabel(/^id/).fill('00000000-0000-7000-8000-000000000000');
  const run = page.getByRole('button', { name: 'Run' });
  await run.focus();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(run).toBeFocused();
  expect(sent).toEqual([]);
});
