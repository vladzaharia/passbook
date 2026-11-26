import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import type { RouterRoute } from 'hono/types';
import { expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/fake-auth.ts';
import { MINTABLE_PLATFORM_SCOPES } from '../../shared/contracts/api-keys.ts';
import type { SignInLevel } from '../../shared/sign-in.ts';
import { createApp } from '../app.ts';
import { isKnownGuard } from './auth.ts';
import { isPublicHandler } from './openapi.ts';
import { declareKeyAccess, enforcesKeyAccess } from './openapi-security.ts';
import { isPlatformKeysOwn, platformKeyOf, signInLevelOf } from './sign-in-guard.ts';

// Every route needs a decision: a guard the inventory recognises (requireCaller from `auth`,
// requireSession, requireAdmin, or a guard declaring key access), `public: true`, or a line below.
// The lists below are exact: a new route fails until it is declared, and a route that gains a
// declaration must leave its list. They may only shrink.

/** Open to anyone on purpose: a capability URL, a provider signature or a sign-in step is the route's own credential. */
const PUBLIC = [
  // The site's Request access form: same origin, honeypot and two rate limits; it only mails PassBook's inbox.
  'POST /access',
  // The site's pages and sitemap: static, public, no data.
  'GET /',
  'GET /door',
  'GET /door/',
  'GET /blueprints',
  'GET /blueprints/',
  'GET /build',
  'GET /build/',
  'GET /access',
  'GET /access/',
  'GET /access/sent',
  'GET /access/sent/',
  'GET /sitemap.xml',
  'GET /api/v1/session',
  'DELETE /wallet/v1/devices/:deviceId/registrations/:passTypeId/:serial',
  'GET /api/v1/docs',
  'GET /api/v1/openapi.json',
  'GET /assets/*',
  'GET /developers/*',
  // A search that found nothing: no identity is sent or kept, only a plain-words term (same origin, rate limited).
  'POST /developers/search-miss',
  'GET /preview/:token',
  'GET /preview/:token/assets/:name',
  'GET /brand/:orgId/:file',
  'GET /scan/sw.js',
  'GET /auth/breakglass',
  'GET /auth/magic',
  'GET /auth/no-access',
  'GET /auth/oidc/callback',
  'GET /auth/oidc/client-metadata.json',
  'GET /auth/oidc/start',
  'GET /b/:token',
  'GET /b/:token/:passId',
  'GET /b/:token/:passId/',
  'GET /b/save.js',
  'GET /b/sw.js',
  'GET /b/:token/:passId/assets/:name',
  'GET /b/:token/:passId/barcode',
  'GET /b/:token/:passId/pass.pkpass',
  'GET /b/:token/:passId/wallet/:provider',
  'GET /b/:token/passes.pkpasses',
  // The bundle's one Google save link: the capability token is the credential, rate limited (RL_PUBLIC), private no-store 302.
  'GET /b/:token/wallet/google',
  'GET /health',
  'GET /j/:token',
  'GET /j/:token/card/:name',
  'GET /p/:token',
  'GET /p/:token/',
  'GET /p/:token/assets/:name',
  'GET /p/:token/barcode',
  'GET /p/:token/pass.pkpass',
  'GET /p/:token/print',
  'GET /p/:token/print/pdf',
  'GET /p/:token/wallet/:provider',
  'GET /p/save.js',
  'GET /p/sw.js',
  'GET /p/wallet/samsung/:offer',
  'GET /t/:slug',
  'GET /w/i/:file',
  'GET /wallet/v1/devices/:deviceId/registrations/:passTypeId',
  'GET /wallet/v1/passes/:passTypeId/:serial',
  'GET /wallet/v1/samsung/cards/:cardId/:refId',
  'POST /auth/breakglass',
  'POST /auth/logout',
  'POST /auth/magic/consume',
  'POST /auth/magic/request',
  'POST /auth/magic/resend',
  'POST /hooks/connections/:id',
  // Polaris ID's SCIM push: a bearer token (a hashed idp_scim_tokens row, or SCIM_BEARER_TOKEN while none is active; constant-time compare) is the credential (modules/idp/scim-auth.ts).
  'DELETE /scim/v2/Groups/:id',
  'DELETE /scim/v2/Users/:id',
  'GET /scim/v2/Groups',
  'GET /scim/v2/Groups/:id',
  'GET /scim/v2/Users',
  'GET /scim/v2/Users/:id',
  'POST /scim/v2/Groups',
  'POST /scim/v2/Users',
  'PUT /scim/v2/Groups/:id',
  'PUT /scim/v2/Users/:id',
  'POST /j/:token',
  'POST /p/:token/print',
  'POST /p/:token/print/drawn',
  'POST /p/:token/print/reprint',
  'POST /p/:token/print/void',
  'POST /p/:token/resend',
  'POST /p/:token/sign-in',
  'POST /wallet/v1/devices/:deviceId/registrations/:passTypeId/:serial',
  'POST /wallet/v1/google/:accountId',
  'POST /wallet/v1/log',
  'POST /wallet/v1/passes/:passTypeId/:serial/personalize',
  'POST /wallet/v1/samsung/cards/:cardId/:refId',
];

/** Scanner principal or pairing code, checked by modules/scan/guard*.ts. */
const SCANNER = [
  'DELETE /api/v1/scan/draft',
  'DELETE /api/v1/scan/passes/:passId/notes/:noteId',
  'DELETE /api/v1/scan/staff',
  'GET /api/v1/scan/activity',
  'GET /api/v1/scan/branding/logo',
  'GET /api/v1/scan/devices',
  'GET /api/v1/scan/live',
  'GET /api/v1/scan/live/inside',
  'GET /api/v1/scan/live/passes/:passId/assets/member.png',
  'GET /api/v1/scan/passes/:passId/assets/:name',
  'GET /api/v1/scan/passes/:passId/history',
  'GET /api/v1/scan/passes/:passId/notes',
  'GET /api/v1/scan/roll-call',
  'GET /api/v1/scan/roll-call/:id',
  'GET /api/v1/scan/roster',
  'GET /api/v1/scan/scans',
  'GET /api/v1/scan/session',
  'GET /api/v1/scan/staff',
  'GET /api/v1/scan/stats',
  'GET /api/v1/scan/summary',
  'GET /api/v1/scan/tag-enrollments/pending',
  'POST /api/v1/scan/actions',
  'POST /api/v1/scan/batch',
  'POST /api/v1/scan/device',
  'POST /api/v1/scan/lookup',
  'POST /api/v1/scan/mark-out',
  'POST /api/v1/scan/overrides',
  'POST /api/v1/scan/overrides/:scanId/note',
  'POST /api/v1/scan/pair',
  'PATCH /api/v1/scan/passes/:passId/notes/:noteId',
  'POST /api/v1/scan/passes/:passId/notes',
  'POST /api/v1/scan/passes/:passId/photo',
  'POST /api/v1/scan/pair/preview',
  'POST /api/v1/scan/resolve',
  'POST /api/v1/scan/roll-call',
  'POST /api/v1/scan/roll-call/:id/end',
  'POST /api/v1/scan/roll-call/:id/marks',
  'POST /api/v1/scan/role',
  'POST /api/v1/scan/scans/:scanId/undo',
  'POST /api/v1/scan/session/open-now',
  'POST /api/v1/scan/sign-out',
  'POST /api/v1/scan/staff',
  'POST /api/v1/scan/staff/pin',
  'POST /api/v1/scan/tag-enrollments/:id/complete',
  'POST /api/v1/scan/tag-enrollments/:id/decline',
  'POST /api/v1/scan/tags/bind',
  'POST /api/v1/scan/tags/bindings/:bindingId/undo',
  'POST /api/v1/scan/tags/inspect',
  'POST /api/v1/scan/unpair',
  'PUT /api/v1/scan/draft',
];

/** Guarded inside the handler or by a dispatching guard this test cannot see; migrate each to `auth`. */
const OWN_GUARD = [
  // A signed link: the signature is the credential (modules/org-lifecycle).
  'GET /api/v1/org-exports/:exportId/download',
  'DELETE /api/v1/identities/:id',
  'DELETE /api/v1/identities/:id/push-key',
  'GET /api/v1/identities',
  'GET /api/v1/identities/:id',
  'GET /api/v1/identities/:id/certificates',
  'GET /api/v1/orgs/invitations/accept',
  'PATCH /api/v1/identities/:id',
  'POST /api/v1/identities',
  'POST /api/v1/identities/:id/apns-check',
  'POST /api/v1/identities/:id/renew',
  'POST /api/v1/identities/:id/rotate',
  'POST /api/v1/orgs/invitations/accept',
  'POST /api/v1/orgs/invitations/preview',
  'PUT /api/v1/identities/:id/push-key',
];

const toRegex = (path: string) =>
  new RegExp(
    `^${path
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\/\*$/, '(?:/.*)?')
      .replace(/\*/g, '.*')
      .replace(/:[A-Za-z0-9_]+/g, '[^/]+')}/?$`,
  );

/** Each route (method and path) with the handlers that cover it: its own middleware, then anything mounted over its path. */
function coverage(
  routes: readonly RouterRoute[] = createApp({ stores: fakeAuth().stores }).routes,
): { key: string; route: RouterRoute; covering: RouterRoute[] }[] {
  const groups = new Map<string, number[]>();
  routes.forEach((r, i) => {
    if (r.method === 'ALL') return;
    const key = `${r.method} ${r.path}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const found: { key: string; route: RouterRoute; covering: RouterRoute[] }[] = [];
  for (const [key, own] of groups) {
    const last = Math.max(...own);
    const route = routes[last];
    if (!route) continue;
    const sample = route.path.replace(/:[A-Za-z0-9_]+/g, 'x');
    const covering = routes.filter(
      (r, i) =>
        i < last &&
        (own.includes(i) ||
          ((r.method === 'ALL' || r.method === route.method) && toRegex(r.path).test(sample))),
    );
    found.push({ key, route, covering });
  }
  return found;
}

/** Routes (method and path) that no recognised guard covers and that are not declared public. */
function undecidedRoutes(routes?: readonly RouterRoute[]): string[] {
  return coverage(routes)
    .filter(
      ({ route, covering }) =>
        !(
          isPublicHandler(route.handler) ||
          covering.some((g) => isKnownGuard(g.handler) || enforcesKeyAccess(g.handler))
        ),
    )
    .map(({ key }) => key)
    .sort();
}

/** The sign-in level of every route a session guard covers; the strictest guard wins. */
function signInLevels(): Record<string, SignInLevel> {
  const levels: Record<string, SignInLevel> = {};
  for (const { key, covering } of coverage()) {
    const own = covering.map((g) => signInLevelOf(g.handler)).filter((l) => l !== undefined);
    if (own.length > 0)
      levels[key] = own.includes('strict') ? 'strict' : own.includes('idp') ? 'idp' : 'any';
  }
  return levels;
}

/** Routes an email-link session may call (holder features). Every other session route needs a strong sign-in. */
const HOLDER_ROUTES = [
  'DELETE /api/v1/me/emails/:email',
  'DELETE /api/v1/me/passes/:id',
  'DELETE /api/v1/me/sessions/:id',
  'GET /api/v1/developer/access',
  'GET /api/v1/me/emails',
  'GET /api/v1/me/pass-removals/:id',
  'GET /api/v1/me/passes',
  'GET /api/v1/me/passes.pkpasses',
  'GET /api/v1/me/passes/:id',
  'GET /api/v1/me/passes/:id/barcode',
  'GET /api/v1/me/sessions',
  'GET /api/v1/orgs/memberships/me',
  'POST /api/v1/me/emails',
  'POST /api/v1/me/emails/:email/primary',
  'POST /api/v1/me/passes/:id/lost-phone',
  'POST /api/v1/me/passes/:id/lost-phone/confirmation',
  'POST /api/v1/me/passes/:id/refresh',
  'POST /api/v1/me/passes/:id/resend',
  'POST /api/v1/me/sessions/revoke-all',
  'POST /api/v1/me/tags/:id/lost',
];

/**
 * Scope routes (`signIn: 'any'`) that also take a key: a session without console access reaches them as
 * own-only, so every handler here must show it only what that person started (`isOwnOnly`).
 */
const OWN_ONLY_ROUTES = ['GET /api/v1/operations', 'GET /api/v1/operations/:id'];
const SIGN_IN_ANY = [...HOLDER_ROUTES, ...OWN_ONLY_ROUTES].sort();

it("has a decision for every route, and only today's undecided ones are listed", () => {
  const listed = new Set([...PUBLIC, ...SCANNER, ...OWN_GUARD]);
  const found = new Set(undecidedRoutes());
  // Names the routes: give each new one `auth` (or `public: true`), or list it above; delete a stale line.
  expect({
    undecided: [...found].filter((route) => !listed.has(route)),
    declaredSinceListed: [...listed].filter((route) => !found.has(route)),
  }).toEqual({ undecided: [], declaredSinceListed: [] });
});

it('leaves no /api/v1 route open except the API document and "who am I"', () => {
  const open = PUBLIC.filter((route) => route.includes(' /api/v1/')).sort();
  expect(open).toEqual(['GET /api/v1/docs', 'GET /api/v1/openapi.json', 'GET /api/v1/session']);
});

it('names a scanner route that only a document-only key declaration covers', () => {
  const noop: MiddlewareHandler = (_c, next) => next();
  const app = new Hono();
  app.use('/api/v1/scan/resolve', declareKeyAccess(noop, { read: [], documentOnly: true }));
  app.post('/api/v1/scan/resolve', (c) => c.text('x'));
  app.post('/api/v1/scan/whatever', (c) => c.text('x'));
  expect(undecidedRoutes(app.routes)).toEqual([
    'POST /api/v1/scan/resolve',
    'POST /api/v1/scan/whatever',
  ]);
});

it('counts a guard that enforces key access as a decision', () => {
  const noop: MiddlewareHandler = (_c, next) => next();
  const app = new Hono();
  app.use('/api/v1/x', declareKeyAccess(noop, { read: ['passes:read'] }));
  app.get('/api/v1/x', (c) => c.text('x'));
  expect(undecidedRoutes(app.routes)).toEqual([]);
});

it('lets an email-link session reach only the holder routes, and deny every other session route by default', () => {
  const levels = signInLevels();
  expect(
    Object.entries(levels)
      .filter(([, level]) => level === 'any')
      .map(([key]) => key)
      .sort(),
  ).toEqual(SIGN_IN_ANY);
  // The console is on that list's complement; sandboxes, Try it, org close and accepting an invitation take no grace.
  for (const route of ['GET /api/v1/orgs', 'GET /api/v1/api-keys'])
    expect(levels[route], route).toBe('idp');
  for (const route of [
    'POST /api/v1/developer/sandbox',
    'DELETE /api/v1/developer/sandbox',
    'POST /api/v1/developer/sandbox/close',
    'POST /api/v1/developer/sandbox/recreate',
    'POST /api/v1/developer/try-token',
    'DELETE /api/v1/developer/try-token',
    'POST /api/v1/orgs/:orgId/close',
  ])
    expect(levels[route], route).toBe('strict');
});

/**
 * How each route a `platform` declaration covers treats a key (`key`, `key.unless` or none), and the scope it names.
 * A route under two platform guards is labelled by the most restrictive (person, then conditional, then key).
 */
function platformKeyRoutes(): {
  modes: Record<'key' | 'conditional' | 'person', string[]>;
  scopes: Set<string>;
} {
  const modes: Record<'key' | 'conditional' | 'person', string[]> = {
    key: [],
    conditional: [],
    person: [],
  };
  const scopes = new Set<string>();
  for (const { key, covering } of coverage()) {
    const decls = covering.map((g) => platformKeyOf(g.handler)).filter((d) => d !== undefined);
    const mode = (['person', 'conditional', 'key'] as const).find((m) =>
      decls.some((d) => d.mode === m),
    );
    if (!mode) continue;
    modes[mode].push(key);
    if (mode !== 'person') for (const d of decls) if (d.mode !== 'person') scopes.add(d.scope);
  }
  for (const list of Object.values(modes)) list.sort();
  return { modes, scopes };
}

/**
 * Every `platform` route has a written decision about keys: here it takes a Platform key, takes one unless the
 * request needs a person (`key: { unless }`), or is person-only (403 PERSON_REQUIRED). The lists are exact, so a new
 * `platform` route fails until it is put on one. Router-level `requireAdmin` routes are not `platform` declarations
 * yet, so they are not here and a Bearer key gets 401 on them (`REQUIRE_ADMIN_ROUTER_ROUTES`): PK-6 converts each
 * to `auth: { platform, key? }` and lists it here.
 */
const PLATFORM_KEY_ROUTES: string[] = [
  'GET /api/v1/platform/settings',
  'GET /api/v1/platform/wallet-release',
];
const PLATFORM_KEY_CONDITIONAL: string[] = [
  // Refused to a key unless it is a dry run (P3: the apply is the owner's go/no-go).
  'POST /api/v1/platform/wallet-release/:provider/:mode/enable-ready',
  // Refused to a key when it names an auth.* or oidc.* setting (P4: it decides who gets in).
  'PUT /api/v1/platform/settings',
];
/** Person-only: no `key`. Each stays so until a package decides it takes keys (the platform-keys design, §2.3). */
const PERSON_ONLY_PLATFORM_ROUTES: string[] = [
  'DELETE /api/v1/platform/idp/groups/:key',
  'DELETE /api/v1/platform/idp/groups/:key/members/:id',
  'DELETE /api/v1/platform/idp/groups/:key/rules/:id',
  'DELETE /api/v1/platform/invitations/:id',
  'DELETE /api/v1/users/:id/holds/:role',
  'GET /api/v1/audit/platform',
  'GET /api/v1/audit/platform/export',
  'GET /api/v1/metrics/platform/developer',
  'GET /api/v1/platform/apple-calls',
  'GET /api/v1/platform/apple/identities',
  'GET /api/v1/platform/apple/identity-moves',
  'GET /api/v1/platform/apple/identity-moves/preview',
  'GET /api/v1/platform/entitlement-presets',
  'GET /api/v1/platform/idp',
  'GET /api/v1/platform/idp/calls',
  'GET /api/v1/platform/idp/drift',
  'GET /api/v1/platform/idp/groups',
  'GET /api/v1/platform/idp/groups/:key/claims',
  'GET /api/v1/platform/idp/groups/:key/members',
  'GET /api/v1/platform/idp/groups/:key/rules',
  'GET /api/v1/platform/invitations',
  'GET /api/v1/platform/orgs/:id/entitlements',
  'GET /api/v1/platform/personal-org-labels',
  'GET /api/v1/users/:id/access',
  'GET /api/v1/users/:id/claims',
  'PATCH /api/v1/platform/idp/groups/:key',
  'PATCH /api/v1/platform/idp/groups/:key/claims',
  'PATCH /api/v1/users/:id/claims',
  // P3: irreversible, every pass the certificate signed stops updating.
  'POST /api/v1/identities/:id/revoke-certificate',
  'POST /api/v1/platform/apple/identities',
  'POST /api/v1/platform/apple/identities/:id/default',
  'POST /api/v1/platform/apple/identity-moves',
  'POST /api/v1/platform/apple/identity-moves/:moveId/arm',
  'POST /api/v1/platform/idp/freeze',
  'POST /api/v1/platform/idp/groups',
  'POST /api/v1/platform/idp/groups/:key/members',
  'POST /api/v1/platform/idp/groups/:key/rules',
  'POST /api/v1/platform/idp/groups/ensure',
  'POST /api/v1/platform/idp/reconcile',
  'POST /api/v1/platform/idp/scim-breaker/clear',
  'POST /api/v1/platform/invitations',
  'POST /api/v1/platform/invitations/:id/resend',
  // P3: releasing a legal hold lets a purge run.
  'POST /api/v1/platform/orgs/:orgId/retention/holds/:holdId/release',
  'POST /api/v1/users/:id/offboard',
  'POST /api/v1/users/:id/roles',
  'POST /api/v1/users/:id/roles/:role/remove-external',
  'PUT /api/v1/platform/entitlement-presets',
  'PUT /api/v1/platform/orgs/:id/entitlements',
];

it('pins which platform routes take a key and which are person-only', () => {
  const { modes } = platformKeyRoutes();
  expect(modes.key).toEqual(PLATFORM_KEY_ROUTES);
  expect(modes.conditional).toEqual(PLATFORM_KEY_CONDITIONAL);
  expect(modes.person).toEqual(PERSON_ONLY_PLATFORM_ROUTES);
});

it('makes a platform scope mintable exactly when a route accepts it by key', () => {
  const { scopes } = platformKeyRoutes();
  if (scopes.size > 0) scopes.add('platform:read');
  expect([...MINTABLE_PLATFORM_SCOPES].sort()).toEqual([...scopes].sort());
});

/** The scope routes a Platform key may read (`platformKeys: 'own'`): only what that key started. Nothing else takes it. */
it('lets a Platform key into the operations reads and no other scope route', () => {
  const own = coverage()
    .filter(({ covering }) => covering.some((g) => isPlatformKeysOwn(g.handler)))
    .map(({ key }) => key)
    .sort();
  expect(own).toEqual(['GET /api/v1/operations', 'GET /api/v1/operations/:id']);
});
