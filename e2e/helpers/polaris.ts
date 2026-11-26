import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type APIRequestContext, expect, type Page, request } from '@playwright/test';
import { e2eOrigin, e2ePorts } from '../../tools/lib/e2e-ports.ts';
import type { Api } from './api.ts';
import { apiFrom } from './api.ts';
import { runMinuteCron } from './cron.ts';

/** The mock Polaris ID shares the mock OIDC server (test/mock-oidc/admin-api.ts). */
const POLARIS = `http://localhost:${e2ePorts.oidc}`;
/** The origin the binding pins and the signup link points at (test/idp-e2e/wrangler.jsonc). */
export const POLARIS_ORIGIN = 'https://polaris.e2e.test';

/** A control of the mock Polaris ID: play the owner, or the person following a signup link. */
export async function polaris<T = Record<string, unknown>>(
  control: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${POLARIS}/__polaris/${control}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`polaris ${control} -> ${res.status}`);
  return (await res.json()) as T;
}

/** The groups Polaris ID says one account holds, by name. */
export async function polarisGroups(sub: string): Promise<string[]> {
  const state = await polaris<{ user: { groups: string[] } | null }>('state', { sub });
  return state.user?.groups ?? [];
}

/** Waits for the minute cron's drain to settle `check`; each round runs the cron once, as the clock would. */
export async function drainUntil(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    await runMinuteCron();
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Polaris ID did not settle: ${what}`);
    await delay(1_000);
  }
}

/** A new secret from a delivered invitation email: `m_` for a member, `p_` for a platform one. */
export async function nextInvite(
  before: Set<string>,
  prefix: 'm_' | 'p_',
  timeoutMs = 20_000,
): Promise<string> {
  const root = '.wrangler/tmp/email';
  const deadline = Date.now() + timeoutMs;
  const pattern = new RegExp(`/invite#(${prefix}[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])`);
  while (Date.now() < deadline) {
    const files = readdirSync(root, { withFileTypes: true }).flatMap((d) => {
      const dir = join(root, d.name, 'email-text');
      try {
        return readdirSync(dir).map((f) => join(dir, f));
      } catch {
        return [];
      }
    });
    for (const file of files.filter((f) => !before.has(f))) {
      const token = pattern.exec(readFileSync(file, 'utf8'))?.[1];
      if (token) return token;
    }
    await delay(200);
  }
  throw new Error('no invitation email arrived');
}

/** Points the app's sign-in link at one mock Polaris ID account (the app sends no login_hint). */
export async function signInLinkAs(page: Page, sub: string) {
  await page.route('**/auth/oidc/start*', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const target = response.headers().location;
    if (!target) return route.fulfill({ response });
    const location = new URL(target);
    location.searchParams.set('login_hint', sub);
    return route.fulfill({
      response,
      headers: { ...response.headers(), location: location.toString() },
    });
  });
}

/** A request context signed in as one Polaris ID account, by the same redirects a browser follows. */
export async function apiSignedInAs(sub: string, next = '/'): Promise<Api> {
  const ctx: APIRequestContext = await request.newContext({ baseURL: e2eOrigin });
  const start = await ctx.get(`/auth/oidc/start?next=${encodeURIComponent(next)}`, {
    maxRedirects: 0,
  });
  const authorize = new URL(start.headers().location ?? '');
  authorize.searchParams.set('login_hint', sub);
  const approved = await ctx.get(authorize.toString(), { maxRedirects: 0 });
  const back = await ctx.get(approved.headers().location ?? '');
  expect(back.ok()).toBe(true);
  return apiFrom(ctx);
}

interface OperationView {
  id: string;
  status: string;
  error?: { code: string } | null;
}

/** Follows an operation to its end through the public API, nudging the minute cron the way the clock would. */
export async function finishOperation(api: Api, id: string): Promise<OperationView> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const op = await api.get<OperationView>(`/api/v1/operations/${id}`);
    if (['succeeded', 'failed', 'canceled'].includes(op.status)) return op;
    if (Date.now() > deadline) throw new Error(`operation ${id} still ${op.status}`);
    await runMinuteCron();
    await delay(500);
  }
}

// Starts as now: a rerun on a reused server may have spent the minute a moment ago.
let lastSnapshot = Date.now();
/** The binding allows one group read sweep a minute (its `snapshot` budget): waits for the window before a Check now. */
export async function snapshotWindow(): Promise<void> {
  const wait = lastSnapshot + 62_000 - Date.now();
  if (wait > 0) await delay(wait);
  lastSnapshot = Date.now();
}
