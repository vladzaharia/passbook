import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import type { RouterRoute } from 'hono/types';
import { expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/fake-auth.ts';
import { createApp } from '../app.ts';
import { isKnownGuard } from './auth.ts';
import { isPublicHandler } from './openapi.ts';
import { declareKeyAccess, enforcesKeyAccess } from './openapi-security.ts';

// Every route needs a decision: a guard the inventory recognises (requireCaller from `auth`,
// requireSession, requireAdmin, or a guard declaring key access), `public: true`, or a line below.
// The lists below are exact: a new route fails until it is declared, and a route that gains a
// declaration must leave its list. They may only shrink.

/** Open to anyone on purpose: a capability URL, a provider signature or a sign-in step is the route's own credential. */
const PUBLIC = [
  'GET /api/v1/session',
  'DELETE /wallet/v1/devices/:deviceId/registrations/:passTypeId/:serial',
  'GET /api/v1/docs',
  'GET /api/v1/openapi.json',
  'GET /assets/*',
  'GET /brand/:orgId/:file',
  'GET /scan/sw.js',
  'GET /auth/breakglass',
  'GET /auth/magic',
  'GET /auth/no-access',
  'GET /auth/oidc/callback',
  'GET /auth/oidc/client-metadata.json',
  'GET /auth/oidc/start',
  'GET /b/:token',
  'GET /b/:token/:passId/assets/:name',
  'GET /b/:token/:passId/barcode',
  'GET /b/:token/:passId/pass.pkpass',
  'GET /b/:token/:passId/wallet/:provider',
  'GET /b/:token/passes.pkpasses',
  'GET /health',
  'GET /j/:token',
  'GET /j/:token/card/:name',
  'GET /p/:token',
  'GET /p/:token/assets/:name',
  'GET /p/:token/barcode',
  'GET /p/:token/pass.pkpass',
  'GET /p/:token/print',
  'GET /p/:token/print/pdf',
  'GET /p/:token/wallet/:provider',
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
  'POST /j/:token',
  'POST /p/:token/print',
  'POST /p/:token/print/reprint',
  'POST /p/:token/print/void',
  'POST /p/:token/resend',
  'POST /wallet/v1/devices/:deviceId/registrations/:passTypeId/:serial',
  'POST /wallet/v1/google/:accountId',
  'POST /wallet/v1/log',
  'POST /wallet/v1/passes/:passTypeId/:serial/personalize',
  'POST /wallet/v1/samsung/cards/:cardId/:refId',
];

/** Scanner principal or pairing code, checked by modules/scan/guard*.ts. */
const SCANNER = [
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
  'GET /api/v1/scan/visitors',
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
  'POST /api/v1/scan/tag-enrollments/:id/complete',
  'POST /api/v1/scan/tag-enrollments/:id/decline',
  'POST /api/v1/scan/tags/bind',
  'POST /api/v1/scan/tags/bindings/:bindingId/undo',
  'POST /api/v1/scan/tags/inspect',
  'POST /api/v1/scan/unpair',
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
  'POST /api/v1/identities/:id/revoke-certificate',
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

/** Routes (method and path) that no recognised guard covers and that are not declared public. */
function undecidedRoutes(
  routes: readonly RouterRoute[] = createApp({ stores: fakeAuth().stores }).routes,
): string[] {
  const groups = new Map<string, number[]>();
  routes.forEach((r, i) => {
    if (r.method === 'ALL') return;
    const key = `${r.method} ${r.path}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const found: string[] = [];
  for (const [key, own] of groups) {
    const last = Math.max(...own);
    const route = routes[last];
    if (!route) continue;
    const sample = route.path.replace(/:[A-Za-z0-9_]+/g, 'x');
    // The route's own middleware (from `auth`), then anything mounted over its path before it.
    const covering = routes.filter(
      (r, i) =>
        i < last &&
        (own.includes(i) ||
          ((r.method === 'ALL' || r.method === route.method) && toRegex(r.path).test(sample))),
    );
    const decided =
      isPublicHandler(route.handler) ||
      covering.some((g) => isKnownGuard(g.handler) || enforcesKeyAccess(g.handler));
    if (!decided) found.push(key);
  }
  return found.sort();
}

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
