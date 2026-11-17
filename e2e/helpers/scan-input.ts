import type { Page } from '@playwright/test';

/**
 * A keyboard-wedge reader: the whole code and Enter dispatched in one page task. The detector
 * (src/web/scan/input/wedge-detector.ts) accepts a burst only when keys arrive within 80 ms of each
 * other, so typing through Playwright's keyboard (one CDP round trip per key) turns into human
 * typing whenever the machine is busy. Keys go to the focused element, as a real reader's do.
 */
export async function hardwareCode(page: Page, value: string) {
  await page.evaluate((code) => {
    const target = document.activeElement ?? document.body;
    const press = (key: string, keyCode: string, shiftKey: boolean) =>
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          code: keyCode,
          shiftKey,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    for (const ch of code) {
      if (/[A-Za-z]/.test(ch)) press(ch, `Key${ch.toUpperCase()}`, ch !== ch.toLowerCase());
      else if (/[0-9]/.test(ch)) press(ch, `Digit${ch}`, false);
      else if (ch === '-') press(ch, 'Minus', false);
      else throw new Error(`hardwareCode: no US key for ${JSON.stringify(ch)}`);
    }
    press('Enter', 'Enter', false);
  }, value);
}

/**
 * Makes a paired scanner read its session now instead of at the next 10 s poll (a background page
 * does not poll at all), and returns once the page holds a session that `applied` accepts.
 */
export async function refreshScannerSession(
  page: Page,
  applied: (session: { scanner: { settings: Record<string, unknown> } }) => boolean = () => true,
) {
  const fresh = page.waitForResponse(async (r) => {
    if (!r.url().includes('/api/v1/scan/session') || r.request().method() !== 'GET') return false;
    if (!r.ok()) return false;
    return applied(await r.json());
  });
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await fresh;
  // Two frames: the response has been rendered, so the next key reaches the new configuration.
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}
