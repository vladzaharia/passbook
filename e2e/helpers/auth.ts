import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { e2eOrigin } from '../../tools/lib/e2e-ports.ts';

export type Role =
  | 'admin'
  | 'user'
  | 'reviewer'
  | 'nobody'
  | 'loner'
  | 'builder'
  | 'developer'
  | 'onboard';

/** Mock Pocket ID subjects (see test/mock-oidc/server.ts). */
const SUBJECT: Record<Role, string> = {
  admin: 'e2e-admin',
  user: 'e2e-user',
  reviewer: 'e2e-reviewer',
  nobody: 'e2e-nobody',
  loner: 'e2e-loner',
  builder: 'e2e-builder',
  developer: 'e2e-developer',
  onboard: 'e2e-onboard',
};

export const stateFile = (role: Role) => `e2e/.auth/${role}.json`;

/**
 * Starts the real OIDC flow. The app sends no login_hint, so the test adds one to the redirect
 * towards the mock provider to pick which mock account signs in. `extra` is query text before `next`,
 * such as `prompt=login&max_age=0&` for a step-up.
 */
export async function startOidcAs(page: Page, role: Role, next = '/', extra = '') {
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
        await page.goto(`/auth/oidc/start?${extra}next=${encodeURIComponent(next)}`);
        return !(await page.content()).includes('Too many requests');
      },
      { intervals: [8_000], timeout: 70_000 },
    )
    .toBe(true);
}

export async function signInAs(page: Page, role: Role, next = '/') {
  await startOidcAs(page, role, next);
  // /admin opens a scope (/admin/platform or /admin/o/<org>) rather than staying put.
  const landed = (path: string) =>
    path === next || (next === '/admin' && /^\/admin\/(platform|o\/[^/]+)(\/|$)/.test(path));
  await page.waitForURL((u) => u.origin === e2eOrigin && landed(u.pathname));
}

export async function saveState(page: Page, role: Role) {
  mkdirSync(dirname(stateFile(role)), { recursive: true });
  await page.context().storageState({ path: stateFile(role) });
}

/** Signs the admin in again just now, for actions that need a recent sign-in. A new sign-in ends the old session, so the stored state follows. */
export async function stepUpAdmin(page: Page) {
  await startOidcAs(page, 'admin', '/admin', 'prompt=login&max_age=0&');
  await page.waitForURL(/\/admin/);
  await saveState(page, 'admin');
}
