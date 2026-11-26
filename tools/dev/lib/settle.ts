import type { Page } from '@playwright/test';

/**
 * Runs in the page: true once no finite animation or transition is still running. Endless ones
 * (skeleton shimmer, buddy idle) never end and are ignored. The sweep sets `reducedMotion: 'reduce'`;
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

/** Runs in the page: two frames so a just-opened sheet has started its animation, then every finite one's `finished`, capped at 2 s. */
export async function finishAnimations(): Promise<void> {
  // Self-contained: Playwright serialises this function into the page.
  const frames = (n: number) =>
    new Promise<void>((done) => {
      const step = (left: number): void =>
        left === 0 ? done() : void requestAnimationFrame(() => step(left - 1));
      step(n);
    });
  await frames(2);
  const finite = document
    .getAnimations()
    .filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY);
  await Promise.race([
    Promise.allSettled(finite.map((a) => a.finished)),
    new Promise((done) => setTimeout(done, 2_000)),
  ]);
  await frames(2);
}

/** Waits for animations to finish, then two frames, so a capture never catches a half-faded or half-slid sheet. */
export async function settle(page: Page, timeout = 5_000): Promise<void> {
  // A sheet that never settles is still worth a capture: note it and shoot anyway.
  await page
    .evaluate(finishAnimations)
    .then(() => page.waitForFunction(noFiniteAnimationRunning, undefined, { timeout }))
    .catch((e: unknown) => console.warn(`settle: still animating after ${timeout} ms`, e));
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
