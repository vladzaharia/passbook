import { expect, test } from '@playwright/test';

/**
 * The assign card keeps to the room above the on-screen keyboard (`--assign-room`). The cap lost
 * to `.scan-result { max-height: 100% }` once; only a real cascade shows it. At tablet widths the
 * card is zoomed 1.3, so the cap is asked for at 1/1.3.
 */
for (const [width, height] of [
  [390, 844],
  [834, 1112],
] as const) {
  test(`the assign card honours --assign-room at ${width}x${height}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height });
    await page.goto('/scan?visual=1&surface=tags&case=assign-pass-pin');
    const card = page.getByTestId('scan-assign');
    await card.waitFor({ timeout: 90_000 });
    const free = await card.evaluate((el) => el.getBoundingClientRect().height);
    expect(free).toBeGreaterThan(260);
    await card.evaluate((el) => (el as HTMLElement).style.setProperty('--assign-room', '200px'));
    // The cap is in screen pixels: at tablet widths it is asked for at 1/1.3 under the 1.3 zoom.
    const capped = await card.evaluate((el) => el.getBoundingClientRect().height);
    expect(capped).toBeLessThanOrEqual(201);
    expect(capped).toBeGreaterThan(150);
  });
}
