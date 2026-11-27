import { beforeAll, expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/fake-auth.ts';
import { createApp } from '../app.ts';
import { setupApi } from '../modules/webhooks/api-test-fixtures.ts';
import { isPublicHandler } from './openapi.ts';

// Scoping a router's guards to its own routes must not leave a route open that leaned on another
// router's wildcard guard. Every non-public route under every /api/v1 prefix refuses an anonymous
// request and a key with no scopes; a signed-in person with no role anywhere is refused on the
// platform-only prefixes; a read_only member and an admin of another org are refused on the
// org-scoped routes.
// Own credential in the route itself (signed link, invitation token, pairing code): refused for another reason.
const OWN_CREDENTIAL = [
  'GET /api/v1/org-exports/:exportId/download',
  'GET /api/v1/orgs/invitations/accept',
  'POST /api/v1/orgs/invitations/accept',
  'POST /api/v1/orgs/invitations/preview',
];
// Answer anyone: the session probe and the API document.
const ANYONE = ['GET /api/v1/session', 'GET /api/v1/openapi.json', 'GET /api/v1/docs'];
// A key may read itself, and the scanner pairing routes take a pairing code, not a key.
const KEY_OK = [
  'GET /api/v1/api-keys/me',
  'POST /api/v1/scan/pair/preview',
  'POST /api/v1/scan/pair',
  'POST /api/v1/scan/unpair',
];

type Row = { key: string; method: string; path: string };

function inventory(): Row[] {
  const routes = createApp({ stores: fakeAuth().stores }).routes;
  const seen = new Map<string, Row & { open: boolean }>();
  for (const r of routes) {
    if (r.method === 'ALL' || !r.path.startsWith('/api/v1/')) continue;
    const key = `${r.method} ${r.path}`;
    const prev = seen.get(key);
    seen.set(key, {
      key,
      method: r.method,
      path: r.path,
      open: (prev?.open ?? false) || isPublicHandler(r.handler),
    });
  }
  return [...seen.values()].filter(
    (r) => !r.open && !OWN_CREDENTIAL.includes(r.key) && !ANYONE.includes(r.key),
  );
}

const sample = (path: string) =>
  path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?/g, 'x').replace(/\*/g, 'x');
const GUARDED = new Set([401, 403]);
const REFUSED = new Set([401, 403, 404, 422]);
// The org in the path: `:orgId`, or `:id` straight after /orgs.
const inOrg = (path: string, orgId: string) =>
  sample(path.replace(/\/orgs\/:id(?=\/|$)/, '/orgs/:orgId').replace(/:orgId/g, orgId));
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const orgRoutes = () => inventory().filter((r) => /^\/api\/v1\/orgs\/:(orgId|id)\b/.test(r.path));

let api: Awaited<ReturnType<typeof setupApi>>;
beforeAll(async () => {
  api = await setupApi();
});

it('has routes to check', () => {
  expect(inventory().length).toBeGreaterThan(400);
  expect(new Set(inventory().map((r) => r.path.split('/')[3])).size).toBeGreaterThan(40);
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

it('refuses a key with no scopes on every non-public route', async () => {
  const key = await api.key({ scopes: [] });
  const open: string[] = [];
  for (const r of inventory().filter((x) => !KEY_OK.includes(x.key))) {
    const res = await api.call(r.method, sample(r.path), r.method === 'GET' ? undefined : {}, key);
    if (!GUARDED.has(res.status)) open.push(`${r.key} -> ${res.status}`);
  }
  expect(open).toEqual([]);
});

it('refuses a read_only member on every org write route', async () => {
  const reader = await api.member(['read_only']);
  const open: string[] = [];
  for (const r of orgRoutes().filter((x) => WRITES.has(x.method))) {
    const res = await api.call(r.method, inOrg(r.path, api.rig.orgId), {}, reader);
    if (!REFUSED.has(res.status)) open.push(`${r.key} -> ${res.status}`);
  }
  expect(open).toEqual([]);
});

it('refuses an admin of another org on every org route', async () => {
  const other = await api.otherOrg();
  const stranger = await api.member(['org_admin'], { orgId: other });
  const open: string[] = [];
  for (const r of orgRoutes()) {
    const res = await api.call(
      r.method,
      inOrg(r.path, api.rig.orgId),
      r.method === 'GET' ? undefined : {},
      stranger,
    );
    if (!REFUSED.has(res.status)) open.push(`${r.key} -> ${res.status}`);
  }
  expect(open).toEqual([]);
});

// The prefixes whose unknown paths answered an anonymous caller 401 before routers scoped their
// guards (a 404 would let anyone list which routes exist). GET only for the last five: their
// unknown POST was already a 404.
const UNKNOWN_401 = [
  '/api/v1/me',
  '/api/v1/orgs',
  '/api/v1/brand',
  '/api/v1/templates',
  '/api/v1/template-reviews',
  '/api/v1/passes',
  '/api/v1/pass-imports',
  '/api/v1/bundles',
  '/api/v1/join-links',
  '/api/v1/test-inbox',
  '/api/v1/broadcasts',
  '/api/v1/message-rules',
  '/api/v1/holders',
  '/api/v1/offboard',
  '/api/v1/delivery',
  '/api/v1/connections',
  '/api/v1/connectors',
  '/api/v1/webhook-endpoints',
  '/api/v1/events',
  '/api/v1/api-keys',
  '/api/v1/api-keys/me',
  '/api/v1/settings',
  '/api/v1/metrics',
  '/api/v1/scanners',
  '/api/v1/scan-setups',
  '/api/v1/scanning-sessions',
  '/api/v1/scan-events',
  '/api/v1/scan-staff',
  '/api/v1/scan-zones',
  '/api/v1/scans',
  '/api/v1/roll-calls',
];
const UNKNOWN_401_GET = [
  '/api/v1/request-logs',
  '/api/v1/operations',
  '/api/v1/identities',
  '/api/v1/identity-runs',
  '/api/v1/users',
];

it('answers an anonymous request to an unknown path under an auth-required prefix with 401', async () => {
  const wrong: string[] = [];
  for (const prefix of [...UNKNOWN_401, ...UNKNOWN_401_GET]) {
    const get = await api.call('GET', `${prefix}/no-such-route-zz`);
    if (get.status !== 401) wrong.push(`GET ${prefix} -> ${get.status}`);
    if (UNKNOWN_401_GET.includes(prefix)) continue;
    const post = await api.call('POST', `${prefix}/no-such-route-zz`, {});
    if (post.status !== 401) wrong.push(`POST ${prefix} -> ${post.status}`);
  }
  expect(wrong).toEqual([]);
});
