import type { Page } from '@playwright/test';

/**
 * Replaces Cloudflare's widget script with a stub that immediately returns Cloudflare's published
 * always-pass dummy token. The Worker still verifies it against the always-pass test secret, so
 * the real server-side Turnstile check runs. Nothing else about the login form is faked.
 */
export async function stubTurnstile(page: Page) {
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `window.turnstile = {
        render(el, options) { setTimeout(() => options.callback('XXXX.DUMMY.TOKEN.XXXX'), 0); return 'w1'; },
        reset() {}, remove() {},
      };`,
    }),
  );
}
