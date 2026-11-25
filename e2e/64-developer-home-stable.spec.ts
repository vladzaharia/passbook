import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { shots } from './helpers/shots.ts';

/** Records the header's auth text, the hero's box and every layout shift from the first frame. */
const RECORDER = `(() => {
  const t0 = performance.now();
  const log = (window.__rec = { auth: [], hero: [], shifts: [] });
  const authText = () => {
    const a = document.querySelector('[data-island="account"]');
    if (!a) return null;
    if (getComputedStyle(a).visibility === 'hidden') return '';
    return (a.textContent || '').trim() || (a.querySelector('button') ? 'avatar' : '') ;
  };
  const sample = () => {
    const a = authText();
    if (a !== null && log.auth[log.auth.length - 1]?.v !== a) log.auth.push({ v: a, t: Math.round(performance.now() - t0) });
    const h = document.querySelector('.hero h1');
    if (h) {
      const hd = document.querySelector('[data-menubar]');
      const r = h.getBoundingClientRect();
      const hb = hd ? Math.round(hd.getBoundingClientRect().height) : 0;
      const ey = document.querySelector('.hero .eyebrow');
      const eb = ey ? Math.round(ey.getBoundingClientRect().top + scrollY) : 0;
      const box = ['hd' + hb, 'ey' + eb, Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)].join(',');
      if (log.hero[log.hero.length - 1]?.v !== box) log.hero.push({ v: box, t: Math.round(performance.now() - t0) });
    } else if (log.hero[log.hero.length - 1]?.v !== 'gone') log.hero.push({ v: 'gone', t: Math.round(performance.now() - t0) });
  };
  const tick = () => { sample(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (!e.hadRecentInput) log.shifts.push({ v: e.value, t: Math.round(e.startTime), n: (e.sources || []).map((s) => s.node && (s.node.className || s.node.nodeName)) });
  }).observe({ type: 'layout-shift', buffered: true });
})();`;

interface Rec {
  auth: { v: string; t: number }[];
  hero: { v: string; t: number }[];
  shifts: { v: number; t: number; n: string[] }[];
}

async function record(page: Page): Promise<Rec> {
  await page.addInitScript(RECORDER);
  await page.goto('/developers');
  await expect(page.locator('.hero h1')).toBeVisible();
  // Long enough for the session, the sandbox and the workbench to resolve and the islands to mount.
  await page.waitForTimeout(3000);
  return page.evaluate(() => (window as unknown as { __rec: Rec }).__rec);
}

const states = (rec: Rec) => rec.auth.map((a) => a.v).filter((v) => v !== '');

/** Serious and critical findings, in both themes. */
async function axeClean(page: Page) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id),
    ).toEqual([]);
  }
}

const shiftTotal = (rec: Rec) => rec.shifts.reduce((sum, s) => sum + s.v, 0);

test.describe('signed in', () => {
  test.use({ storageState: 'e2e/.auth/developer.json' });

  test('the landing stays, the header settles once, the hero does not move', async ({ page }) => {
    const rec = await record(page);
    // The hero is one box from the first frame to the last, and is still there.
    expect(rec.hero).toHaveLength(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.locator('.hero h1')).toBeVisible();
    await expect(page.locator('.tiles')).toBeVisible();
    // The workbench took the sandbox card's place under the hero.
    await expect(page.locator('#workbench .wb')).toBeVisible();
    await expect(page.locator('#workbench').getByRole('link', { name: 'Sign in' })).toHaveCount(0);
    // No Sign in anywhere on the page, and the workbench card holds its one buddy.
    await expect(page.locator('main').getByText('Sign in')).toHaveCount(0);
    await expect(page.locator('[data-buddy]')).toHaveCount(1);
    // The header shows nothing, then the avatar: one change, never Sign in on the way.
    expect(states(rec)).toEqual(['avatar']);
    expect(shiftTotal(rec)).toBeLessThan(0.02);
    await shots(page, 'home-signed-in');
    await axeClean(page);
  });
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the same page, Sign in settles once and nothing moves', async ({ page }) => {
    const rec = await record(page);
    expect(rec.hero).toHaveLength(1);
    expect(states(rec)).toEqual(['Sign in']);
    await expect(page.locator('#workbench').getByRole('link', { name: 'Sign in' })).toBeVisible();
    expect(shiftTotal(rec)).toBeLessThan(0.02);
    // The hero's code fits its box, at the desktop and the tablet width.
    for (const width of [1440, 820]) {
      await page.setViewportSize({ width, height: 900 });
      const fit = await page
        .locator('.hero pre')
        .evaluateAll((els) => els.map((e) => e.scrollWidth - e.clientWidth));
      expect(fit.length).toBeGreaterThan(0);
      expect(fit.every((d) => d === 0)).toBe(true);
    }
    await expect(page.locator('[data-buddy]')).toHaveCount(1);
    await shots(page, 'home-signed-out');
    await axeClean(page);
  });
});
