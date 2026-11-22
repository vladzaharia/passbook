import type { Page } from '@playwright/test';

/** Set D12_SHOTS to a folder to take every width and theme of a state; unset, a no-op. */
const DIR = process.env.D12_SHOTS;

const VIEWS = [
  [1440, 900],
  [834, 1112],
  [390, 844],
] as const;

export async function shots(page: Page, name: string) {
  if (!DIR) return;
  const before = page.viewportSize();
  for (const [width, height] of VIEWS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${DIR}/${name}-${width}-${scheme}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (before) await page.setViewportSize(before);
}
