import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { apiKeysRoutes } from './modules/api-keys/routes.ts';
import { appleRoutes } from './modules/apple/routes.ts';
import { auditRoutes } from './modules/audit/routes.ts';
import { authRoutes, sessionRoutes } from './modules/auth/routes.ts';
import { broadcastsRoutes } from './modules/broadcasts/routes.ts';
import { bundlePublicRoutes } from './modules/bundles/public-routes.ts';
import { bundlesRoutes } from './modules/bundles/routes.ts';
import { connectionsRoutes, connectorsRoutes, hooksRoutes } from './modules/connections/routes.ts';
import { deliveryRoutes } from './modules/delivery/routes.ts';
import { holdersRoutes } from './modules/holders/routes.ts';
import { identitiesRoutes } from './modules/identities/routes.ts';
import { meRoutes } from './modules/me/routes.ts';
import { metricsRoutes } from './modules/metrics/routes.ts';
import { nfcRoutes } from './modules/nfc/routes.ts';
import { orgsRoutes } from './modules/orgs/routes.ts';
import { passesRoutes } from './modules/passes/routes.ts';
import { publicRoutes } from './modules/public/routes.ts';
import { sandboxRoutes } from './modules/sandbox/routes.ts';
import { scanRoutes } from './modules/scan/routes.ts';
import { scanDisplayRoutes } from './modules/scan/routes-display.ts';
import { scanEventsRoutes } from './modules/scan/routes-events.ts';
import { scanLiveRoutes } from './modules/scan/routes-live.ts';
import { scanPairRoutes } from './modules/scan/routes-pair.ts';
import { scannersRoutes } from './modules/scan/routes-scanners.ts';
import { scanningSessionsRoutes } from './modules/scan/routes-scanning-sessions.ts';
import { scansRoutes } from './modules/scan/routes-scans.ts';
import { scanSetupsRoutes } from './modules/scan/routes-setups.ts';
import { scanStaffRoutes } from './modules/scan/routes-staff.ts';
import { settingsRoutes } from './modules/settings/routes.ts';
import { statusRoutes } from './modules/status/routes.ts';
import { templatesRoutes } from './modules/templates/routes.ts';
import { usersRoutes } from './modules/users/routes.ts';
import { walletProviderAccountRoutes } from './modules/wallet-providers/routes-accounts.ts';
import { samsungCallbackRoutes } from './modules/wallet-providers/routes-callbacks.ts';
import { googleCallbackRoutes } from './modules/wallet-providers/routes-google-callbacks.ts';
import { walletOfferRoutes } from './modules/wallet-providers/routes-offers.ts';
import { walletProviderStatusRoutes } from './modules/wallet-providers/routes-status.ts';
import { type AuthStores, denyAllStores } from './platform/auth.ts';
import type { Clock } from './platform/clock.ts';
import { type AppBindings, requestContext } from './platform/context.ts';
import type { AppEnv } from './platform/env.ts';
import { handleError, notFoundHandler } from './platform/error-handler.ts';
import { hostPolicy } from './platform/host-policy.ts';
import { securityHeaders, staticAsset } from './platform/security-headers.ts';
import { asBrowserPage } from './ssr/error-response.ts';

export interface AppOptions {
  /** Session and API-key stores. Production wiring lives in stores.ts; tests pass fakes. */
  stores?: AuthStores | ((env: AppEnv) => AuthStores);
  clock?: Clock;
  /** Serve only PUBLIC_BASE_URL's origin, redirect REDIRECT_HOSTS, refuse the rest (index.ts). */
  hostPolicy?: boolean;
}

/** Paths only the Worker answers: an unknown one is a 404, never the SPA. */
const WORKER_ONLY = /^\/(?:api|auth|wallet|p|b|hooks|assets|health)(?:\/|$)/;

/**
 * Every other GET is one of the SPA's pages, served from static assets as the asset layer would
 * (wrangler.jsonc runs the Worker first so the host policy sees page visits). A file-like path
 * that public/ does not ship stays a 404 instead of the SPA's sign-in page.
 */
async function spaPage(c: Context<AppBindings>): Promise<Response | null> {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return null;
  if (WORKER_ONLY.test(c.req.path) || c.req.path.includes('.')) return null;
  return staticAsset(await c.env.ASSETS.fetch(c.req.raw));
}

/** The scanner's document and the files only it loads. */
const SCAN_ONLY = /^\/(?:scan(?:\/.*|\.html|\.webmanifest)?|assets\/decode-worker-[^/]*)$/;

/**
 * Off unless SCAN_ENABLED is "1" (production turns it on at M1): every scanner path is the
 * not-found page, uncached so turning it on takes effect at once. The scan API stays mounted.
 */
const scanGate = createMiddleware<AppBindings>(async (c, next) => {
  if (!SCAN_ONLY.test(c.req.path)) return next();
  if (c.env.SCAN_ENABLED !== '1') {
    const res = await asBrowserPage(c, notFoundHandler(c));
    const out = new Response(res.body, res);
    out.headers.set('cache-control', 'no-store');
    return out;
  }
  // A file-like path the SPA fallback would refuse; run_worker_first sends it here for the gate.
  if (c.req.path === '/scan.webmanifest') return staticAsset(await c.env.ASSETS.fetch(c.req.raw));
  return next();
});

/** One line per module. Adding a module means adding a line here and nothing else shared. */
export function createApp(options: AppOptions = {}): OpenAPIHono<AppBindings> {
  const app = new OpenAPIHono<AppBindings>();
  app.use('*', requestContext({ stores: options.stores ?? denyAllStores, clock: options.clock }));
  app.use('*', securityHeaders);
  if (options.hostPolicy) app.use('*', hostPolicy);
  app.use('*', scanGate);
  app.onError((error, c) => asBrowserPage(c, handleError(error, c) as Response));
  app.notFound(async (c) => (await spaPage(c)) ?? asBrowserPage(c, notFoundHandler(c)));

  // A missing chunk must not come back as the SPA fallback page (cached immutable under that URL).
  app.get('/assets/*', async (c) => {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    const html = (res.headers.get('content-type') ?? '').startsWith('text/html');
    if (res.status === 404 || html) {
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    return res;
  });

  app.get('/health', (c) => c.json({ ok: true }));

  app.route('/auth', authRoutes);
  app.route('/api/v1/session', sessionRoutes);
  app.route('/api/v1/me', meRoutes);
  app.route('/api/v1/orgs', orgsRoutes);
  app.route('/api/v1/templates', templatesRoutes);
  app.route('/api/v1/passes', passesRoutes);
  app.route('/api/v1/bundles', bundlesRoutes);
  app.route('/api/v1/test-inbox', sandboxRoutes);
  app.route('/api/v1/broadcasts', broadcastsRoutes);
  app.route('/api/v1/holders', holdersRoutes);
  app.route('/api/v1/delivery', deliveryRoutes);
  app.route('/api/v1/connections', connectionsRoutes);
  app.route('/api/v1/connectors', connectorsRoutes);
  app.route('/api/v1/identities', identitiesRoutes);
  app.route('/api/v1/wallet-providers/accounts', walletProviderAccountRoutes);
  app.route('/api/v1/wallet-providers/passes', walletProviderStatusRoutes);
  app.route('/api/v1/users', usersRoutes);
  app.route('/api/v1/api-keys', apiKeysRoutes);
  app.route('/api/v1/settings', settingsRoutes);
  app.route('/api/v1/audit', auditRoutes);
  app.route('/api/v1/status', statusRoutes);
  app.route('/api/v1/metrics', metricsRoutes);
  app.route('/api/v1/scan', scanPairRoutes);
  app.route('/api/v1/scan', scanRoutes);
  app.route('/api/v1/scanners', scannersRoutes);
  app.route('/api/v1/scan-setups', scanSetupsRoutes);
  app.route('/api/v1/scanning-sessions', scanningSessionsRoutes);
  app.route('/api/v1/scan/live', scanLiveRoutes);
  app.route('/api/v1/scan-events', scanEventsRoutes);
  app.route('/api/v1/scan-staff', scanStaffRoutes);
  app.route('/api/v1/scans', scansRoutes);
  app.route('/api/v1/scan-display', scanDisplayRoutes);
  app.route('/api/v1/nfc', nfcRoutes);
  app.route('/wallet/v1/google', googleCallbackRoutes);
  app.route('/wallet/v1/samsung', samsungCallbackRoutes);
  app.route('/wallet/v1', appleRoutes);
  app.route('/p', walletOfferRoutes);
  app.route('/p', publicRoutes);
  app.route('/b', bundlePublicRoutes);
  app.route('/hooks', hooksRoutes);

  app.doc31('/api/v1/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'PassBook API', version: '1.0.0' },
    servers: [{ url: '/' }],
  });

  return app;
}
