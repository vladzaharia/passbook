import { beforeAll, expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/fake-auth.ts';
import { createApp } from '../app.ts';
import { setupApi } from '../modules/webhooks/api-test-fixtures.ts';
import { isPublicHandler } from './openapi.ts';

// Scoping a router's guards to its own routes must not leave a route open that leaned on another
// router's wildcard guard. Every non-public route refuses an anonymous request, and a signed-in
// person with no role anywhere is refused on the platform-only prefixes.
const PREFIXES = [
  '/api/v1/platform',
  '/api/v1/users',
  '/api/v1/orgs',
  '/api/v1/workbench',
  '/api/v1/scan',
  '/api/v1/idp',
];
// Own credential in the route itself (signed link, invitation token, pairing code): refused for another reason.
const OWN_CREDENTIAL = [
  'GET /api/v1/org-exports/:exportId/download',
  'GET /api/v1/orgs/invitations/accept',
  'POST /api/v1/orgs/invitations/accept',
  'POST /api/v1/orgs/invitations/preview',
];

type Row = { key: string; method: string; path: string };

function inventory(): Row[] {
  const routes = createApp({ stores: fakeAuth().stores }).routes;
  const seen = new Map<string, Row & { open: boolean }>();
  for (const r of routes) {
    if (r.method === 'ALL' || !PREFIXES.some((p) => r.path.startsWith(p))) continue;
    const key = `${r.method} ${r.path}`;
    const prev = seen.get(key);
    seen.set(key, {
      key,
      method: r.method,
      path: r.path,
      open: (prev?.open ?? false) || isPublicHandler(r.handler),
    });
  }
  return [...seen.values()].filter((r) => !r.open && !OWN_CREDENTIAL.includes(r.key));
}

const sample = (path: string) =>
  path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?/g, 'x').replace(/\*/g, 'x');
const GUARDED = new Set([401, 403]);

let api: Awaited<ReturnType<typeof setupApi>>;
beforeAll(async () => {
  api = await setupApi();
});

it('has routes to check', () => {
  expect(inventory().length).toBeGreaterThan(150);
});

it('refuses an anonymous request on every non-public route', async () => {
  const open: string[] = [];
  for (const r of inventory()) {
    const res = await api.call(r.method, sample(r.path), r.method === 'GET' ? undefined : {});
    if (!GUARDED.has(res.status)) open.push(`${r.key} -> ${res.status}`);
  }
  expect(open).toEqual([]);
});

it('refuses a signed-in person with no role on the platform-only routes', async () => {
  const person = await api.outsider();
  const open: string[] = [];
  for (const r of inventory()) {
    if (!/^\/api\/v1\/(platform|idp)\b/.test(r.path)) continue;
    const res = await api.call(
      r.method,
      sample(r.path),
      r.method === 'GET' ? undefined : {},
      person,
    );
    if (!GUARDED.has(res.status)) open.push(`${r.key} -> ${res.status}`);
  }
  expect(open).toEqual([]);
});
