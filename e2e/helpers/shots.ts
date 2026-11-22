import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';

const DIR = process.env.SHOTS_DIR;
const WIDTHS = [
  { w: 390, h: 844 },
  { w: 834, h: 1112 },
  { w: 1440, h: 900 },
] as const;

/** With SHOTS_DIR set, saves the page at 390, 834 and 1440, light and dark; otherwise does nothing. */
export async function shoot(page: Page, name: string): Promise<void> {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  const before = page.viewportSize();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const { w, h } of WIDTHS) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${DIR}/${name}-${w}-${colorScheme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (before) await page.setViewportSize(before);
}
