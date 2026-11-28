import { expect, type Page } from '@playwright/test';
import { sandboxOrgId } from './sandbox.ts';
import { stubTurnstile } from './turnstile.ts';

interface SignInOptions {
  /** Wait for the sandbox and make sure it has a key, which the Workbench token needs. */
  key?: boolean;
  /** Set a 1440x900 viewport after sign-in; the shell's tool area shows from desktop width. */
  desktop?: boolean;
}

/** Signs the builder in through the Workbench quickstart and makes the sandbox if the account has none. */
export async function signInToWorkbench(
  page: Page,
  { key = false, desktop = true }: SignInOptions = {},
) {
  await stubTurnstile(page);
  await page.route('**/auth/oidc/start*', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const target = response.headers().location;
    if (!target) return route.fulfill({ response });
    const location = new URL(target);
    location.searchParams.set('login_hint', 'e2e-builder');
    return route.fulfill({
      response,
      headers: { ...response.headers(), location: location.toString() },
    });
  });
  await page.goto('/workbench/quickstart');
  await page.locator('main').getByRole('link', { name: 'Sign in with Polaris ID' }).click();
  await page.waitForURL((u) => u.pathname === '/workbench/quickstart');
  if (desktop) await page.setViewportSize({ width: 1440, height: 900 });
  const create = page.getByRole('button', { name: 'Create sandbox' });
  // A track already done (an earlier spec's pass) opens on the Done page, with neither.
  await create
    .or(page.getByRole('radio', { name: 'Run here' }))
    .or(page.locator('.qs-done'))
    .waitFor();
  if (await create.isVisible({ timeout: 3000 }).catch(() => false)) {
    await create.click();
    // Specs that go on to use the token keep the long wait; the others keep the repo default.
    await expect(page.locator('.qs-env-v')).toContainText(
      /PASSBOOK_KEY=pbp_test_/,
      key ? { timeout: 90_000 } : undefined,
    );
  }
  if (!key) return;
  await expect.poll(() => sandboxOrgId(page).catch(() => ''), { timeout: 60_000 }).not.toBe('');
  // A sandbox made by an earlier run of this server may have no key yet: the Workbench token needs one.
  await page.evaluate(async () => {
    const me = (await (await fetch('/api/v1/session')).json()) as { csrfToken: string };
    await fetch('/api/v1/developer/sandbox/key', {
      method: 'POST',
      headers: { accept: 'application/json', 'x-csrf-token': me.csrfToken },
    });
  });
}
