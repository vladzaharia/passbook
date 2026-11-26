/**
 * `{ platform }` routes that sit under a router-level `requireAdmin` (a session guard that runs first and ignores a
 * Bearer header). A key gets 401 there, not PERSON_REQUIRED, and a Bearer header beside an admin cookie falls back to the
 * cookie: PK-6 replaces each router guard with the route's own `{ platform, key? }` declaration and empties this list.
 */
export const REQUIRE_ADMIN_ROUTER_ROUTES: readonly string[] = [
  'GET /api/v1/metrics/platform/developer',
  'GET /api/v1/platform/apple-calls',
  'GET /api/v1/platform/entitlement-presets',
  'GET /api/v1/platform/orgs/:id/entitlements',
  'GET /api/v1/platform/personal-org-labels',
  'PUT /api/v1/platform/entitlement-presets',
  'PUT /api/v1/platform/orgs/:id/entitlements',
];
