import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, type Page } from '@playwright/test';

export type Role = 'admin' | 'user' | 'reviewer' | 'nobody';

/** Mock Pocket ID subjects (see test/mock-oidc/server.ts). */
const SUBJECT: Record<Role, string> = {
  admin: 'e2e-admin',
  user: 'e2e-user',
  reviewer: 'e2e-reviewer',
  nobody: 'e2e-nobody',
};

export const stateFile = (role: Role) => `e2e/.auth/${role}.json`;

/**
 * Starts the real OIDC flow. The app sends no login_hint, so the test adds one to the redirect
 * towards the mock provider to pick which mock account signs in.
 */
export async function startOidcAs(page: Page, role: Role, next = '/') {
  // Playwright cannot route redirect hops, so rewrite the 302 from /auth/oidc/start instead.
  await page.route('**/auth/oidc/start*', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const target = response.headers().location;
    if (!target) return route.fulfill({ response });
    const location = new URL(target);
    location.searchParams.set('login_hint', SUBJECT[role]);
    return route.fulfill({
      response,
      headers: { ...response.headers(), location: location.toString() },
    });
  });
  // RL_LOGIN allows 10 starts a minute per IP and is enforced locally too. Poll until the window
  // reopens instead of failing when a run's logins bunch up.
  await expect
    .poll(
      async () => {
        await page.goto(`/auth/oidc/start?next=${encodeURIComponent(next)}`);
        return !(await page.content()).includes('Too many requests');
      },
      { intervals: [8_000], timeout: 70_000 },
    )
    .toBe(true);
}

export async function signInAs(page: Page, role: Role, next = '/') {
  await startOidcAs(page, role, next);
  await page.waitForURL((u) => u.origin === 'http://localhost:5173' && u.pathname === next);
}

export async function saveState(page: Page, role: Role) {
  mkdirSync(dirname(stateFile(role)), { recursive: true });
  await page.context().storageState({ path: stateFile(role) });
}
