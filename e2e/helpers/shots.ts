import type { Page } from '@playwright/test';

/** Set D12_SHOTS to a folder to take every width and theme of a state; unset, a no-op. */
const DIR = process.env.D12_SHOTS;

const VIEWS = [
  [1440, 900],
  [834, 1112],
  [390, 844],
] as const;

/** `view`: also the 1440 window as the reader sees it (a sticky column scrolls inside it, which a full-page shot cannot show). */
export async function shots(page: Page, name: string, view = false) {
  if (!DIR) return;
  const before = page.viewportSize();
  for (const [width, height] of VIEWS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      // Two frames after the media or size change, so the screenshot is of the settled layout.
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      await page.screenshot({ path: `${DIR}/${name}-${width}-${scheme}.png`, fullPage: true });
      if (view && width === 1440)
        await page.screenshot({ path: `${DIR}/${name}-1440-view-${scheme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (before) await page.setViewportSize(before);
}
