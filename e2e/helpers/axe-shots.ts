import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** SHOTS_DIR names the folder for the shots; unset, only axe and the overflow check run. */
const DIR = process.env.SHOTS_DIR;
const VIEWS = [
  [1440, 900],
  [834, 1112],
  [390, 844],
] as const;

/**
 * Every width and theme of a state: a shot of the state as set (when SHOTS_DIR is), then nothing serious or
 * critical from axe and no sideways scroll. Returns the number of shots taken.
 */
export async function axeShots(page: Page, name: string): Promise<number> {
  if (DIR) mkdirSync(DIR, { recursive: true });
  const before = page.viewportSize();
  let taken = 0;
  for (const [width, height] of VIEWS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      // The dialog's entrance and the QR's sweep are over before axe reads contrast.
      await page.waitForTimeout(1600);
      if (DIR) {
        await page.screenshot({ path: `${DIR}/${name}-${width}-${scheme}.png` });
        taken++;
      }
      const found = (
        await new AxeBuilder({ page }).disableRules(['label-content-name-mismatch']).analyze()
      ).violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
      expect(
        found.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
        `${name} ${width} ${scheme}`,
      ).toEqual([]);
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(sideways, `${name} ${width}`).toBeLessThanOrEqual(0);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (before) await page.setViewportSize(before);
  return taken;
}
