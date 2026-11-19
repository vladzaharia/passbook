import type { Page } from '@playwright/test';

/**
 * Runs in the page: true once no finite animation or transition is still running. Endless ones
 * (skeleton shimmer, buddy idle) never end and are ignored. Reduced motion needs no special case:
 * its 150 ms fades are animations like any other.
 */
export function noFiniteAnimationRunning(): boolean {
  return document
    .getAnimations()
    .every(
      (a) =>
        a.playState !== 'running' ||
        a.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY,
    );
}

/** Waits for animations to finish, then one frame, so a capture never catches a half-faded sheet. */
export async function settle(page: Page, timeout = 5_000): Promise<void> {
  // A sheet that never settles is still worth a capture: note it and shoot anyway.
  await page
    .waitForFunction(noFiniteAnimationRunning, undefined, { timeout })
    .catch((e: unknown) => console.warn(`settle: still animating after ${timeout} ms`, e));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
}

/** A settled full-page screenshot; a dropped capture (page still repainting) is retried once. */
export async function settledShot(page: Page, path: string): Promise<void> {
  await settle(page);
  try {
    await page.screenshot({ path, fullPage: true });
  } catch {
    await settle(page);
    await page.screenshot({ path, fullPage: true });
  }
}
