import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/fake-auth.ts';
import { createApp } from '../app.ts';
import type { AppEnv } from './env.ts';
import { platformKeyOf, stepUpOf } from './sign-in-guard.ts';

const ORIGIN = 'https://wallet.test';
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

/** Every route that declares `{ platform }`, once: these are guarded by the declaration alone, no router `requireAdmin`. */
function platformRoutes() {
  const fake = fakeAuth(ORIGIN);
  const app = createApp({ stores: fake.stores });
  const seen = new Set<string>();
  const found: { method: string; path: string; stepUp: boolean }[] = [];
  for (const r of app.routes) {
    if (!platformKeyOf(r.handler)) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const decl = stepUpOf(r.handler);
    found.push({ method: r.method, path: r.path, stepUp: !!decl && !decl.conditional });
  }
  return { app, fake, found };
}

async function send(
  app: ReturnType<typeof createApp>,
  route: { method: string; path: string },
  headers: Record<string, string>,
) {
  const url = `${ORIGIN}${route.path.replace(/:[A-Za-z0-9_]+/g, 'x')}`;
  const init: RequestInit = {
    method: route.method,
    headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
  };
  if (!['GET', 'HEAD', 'DELETE'].includes(route.method)) init.body = '{}';
  const res = await app.fetch(new Request(url, init), env as AppEnv, ctx);
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  return { status: res.status, code: body.code };
}

const CONVERTED = [
  'GET /api/v1/status',
  'POST /api/v1/status/incidents',
  'GET /api/v1/users',
  'GET /api/v1/users/:id/passes',
  'POST /api/v1/users/:id/emails',
  'GET /api/v1/orgs',
  'POST /api/v1/orgs/:id/status',
  'DELETE /api/v1/orgs/:id',
  'GET /api/v1/metrics/platform/overview',
  'POST /api/v1/identities/:id/rotate',
  'PUT /api/v1/platform/wallet-credentials',
  'POST /api/v1/platform/wallet-credentials/:id/rotate-key',
  'GET /api/v1/platform/retention/receipts',
  'GET /api/v1/platform/closed-orgs',
];

it('answers a signed-in non-admin 403 FORBIDDEN on every platform route', async () => {
  const { app, fake, found } = platformRoutes();
  const names = found.map((r) => `${r.method} ${r.path}`);
  for (const route of CONVERTED) expect(names, route).toContain(route);
  const headers = fake.user();
  const wrong: string[] = [];
  for (const route of found) {
    const res = await send(app, route, headers);
    if (!(res.status === 403 && res.code === 'FORBIDDEN'))
      wrong.push(`${route.method} ${route.path}: ${res.status} ${res.code}`);
  }
  expect(wrong).toEqual([]);
}, 120_000);

it('answers an admin whose sign-in is stale 403 STEP_UP_REQUIRED where a step-up always applies', async () => {
  const { app, fake, found } = platformRoutes();
  const asked = found.filter((r) => r.stepUp);
  const names = asked.map((r) => `${r.method} ${r.path}`);
  for (const route of [
    'POST /api/v1/users/:id/emails',
    'POST /api/v1/identities',
    'POST /api/v1/identities/:id/rotate',
    'PUT /api/v1/identities/:id/push-key',
    'POST /api/v1/platform/wallet-credentials/:id/rotate-key',
  ])
    expect(names, route).toContain(route);
  const stale = fake.session({
    userId: 'admin-1',
    roles: ['admin', 'user'],
    authTime: null,
  });
  const wrong: string[] = [];
  for (const route of asked) {
    const res = await send(app, route, stale);
    if (!(res.status === 403 && res.code === 'STEP_UP_REQUIRED'))
      wrong.push(`${route.method} ${route.path}: ${res.status} ${res.code}`);
  }
  expect(wrong).toEqual([]);
}, 120_000);
