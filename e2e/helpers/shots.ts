import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';

/** Set D12_SHOTS (or SHOTS_DIR) to a folder to take every width and theme of a state; unset, a no-op. */
const DIR = process.env.D12_SHOTS ?? process.env.SHOTS_DIR;

const VIEWS = [
  [1440, 900],
  [834, 1112],
  [390, 844],
] as const;

/** `view`: also the 1440 window as the reader sees it (a sticky column scrolls inside it, which a full-page shot cannot show). */
export async function shots(page: Page, name: string, view = false) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  const before = page.viewportSize();
  for (const [width, height] of VIEWS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      await capture(page, `${DIR}/${name}-${width}-${scheme}.png`, height);
      if (view && width === 1440)
        await page.screenshot({ path: `${DIR}/${name}-1440-view-${scheme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (before) await page.setViewportSize(before);
}

/** One settled picture at the current width: the window grows to the page's height so a viewport-fixed bar sits at the foot, as a reader sees it. */
export async function capture(
  page: Page,
  path: string,
  height = page.viewportSize()?.height ?? 900,
) {
  const width = page.viewportSize()?.width ?? 1440;
  await settled(page);
  const full = await page.evaluate(() => document.documentElement.scrollHeight);
  if (full > height) {
    await page.setViewportSize({ width, height: Math.min(full, 8000) });
    await settled(page);
  }
  await page.screenshot({ path });
  if (full > height) await page.setViewportSize({ width, height });
}

/** Two frames, then every running animation and transition (a drawer re-seated by the resize fades in) has finished. */
async function settled(page: Page) {
  await page.evaluate(async () => {
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    await frame();
    await frame();
    for (let i = 0; i < 40; i++) {
      const running = document.getAnimations().filter((a) => a.playState === 'running');
      if (running.length === 0) break;
      await Promise.allSettled(running.map((a) => a.finished));
      await frame();
    }
  });
}

export const shoot = shots;
