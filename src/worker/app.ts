import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { apiKeysRoutes } from './modules/api-keys/routes.ts';
import { apiKeyMeRoutes } from './modules/api-keys/routes-me.ts';
import { appleRoutes } from './modules/apple/routes.ts';
import { auditRoutes } from './modules/audit/routes.ts';
import { authRoutes, sessionRoutes } from './modules/auth/routes.ts';
import { broadcastsRoutes } from './modules/broadcasts/routes.ts';
import { bundlePublicRoutes } from './modules/bundles/public-routes.ts';
import { bundlesRoutes } from './modules/bundles/routes.ts';
import { connectionsRoutes, connectorsRoutes, hooksRoutes } from './modules/connections/routes.ts';
import { deliveryRoutes } from './modules/delivery/routes.ts';
import { developerOrgRoutes } from './modules/dev-access/routes-org.ts';
import { developerPortalRoutes } from './modules/developer/portal.ts';
import { requestLog } from './modules/developer/request-log.ts';
import { developerRoutes } from './modules/developer/routes.ts';
import { holdersRoutes } from './modules/holders/routes.ts';
import { offboardRoutes } from './modules/holders/routes-offboard.ts';
import { identitiesRoutes } from './modules/identities/routes.ts';
import { platformIdentityRoutes } from './modules/identities/routes-platform.ts';
import { identityProvisionRoutes, identityRunsRoutes } from './modules/identities/routes-runs.ts';
import { platformAppleRoutes, walletIdentitiesRoutes } from './modules/identities/routes-wallet.ts';
import { invitationRoutes } from './modules/idp/invitations/routes.ts';
import { groupClaimsRoutes, userClaimsRoutes } from './modules/idp/routes-claims.ts';
import { scimRoutes } from './modules/idp/scim-routes.ts';
import { joinLinksRoutes } from './modules/join/routes-admin.ts';
import { joinPublicRoutes } from './modules/join/routes-public.ts';
import { marketingRoutes } from './modules/marketing/routes.ts';
import { marketingPageRoutes } from './modules/marketing/routes-pages.ts';
import { meRoutes } from './modules/me/routes.ts';
import { messageRulesRoutes } from './modules/message-rules/routes.ts';
import { metricsRoutes } from './modules/metrics/routes.ts';
import { nfcRoutes } from './modules/nfc/routes.ts';
import { tagPageRoutes } from './modules/nfc/tag-page.ts';
import { operationsRoutes } from './modules/operations/routes.ts';
import {
  orgClosedRoutes,
  orgExportDownloadRoutes,
  orgLifecycleRoutes,
} from './modules/org-lifecycle/routes.ts';
import { brandAssetRoutes } from './modules/orgs/brand-assets.ts';
import { brandRoutes } from './modules/orgs/brand-routes.ts';
import { passSetupRoutes } from './modules/orgs/pass-setup-routes.ts';
import { passSetupWriteRoutes } from './modules/orgs/pass-setup-write-routes.ts';
import { orgsRoutes } from './modules/orgs/routes.ts';
import {
  orgEntitlementsRoutes,
  platformEntitlementsRoutes,
} from './modules/orgs/routes-entitlements.ts';
import { platformPersonalLabelsRoutes } from './modules/orgs/routes-personal-labels.ts';
import { passesRoutes } from './modules/passes/routes.ts';
import { passImportRoutes } from './modules/passes/routes-import.ts';
import { publicRoutes } from './modules/public/routes.ts';
import { previewRoutes } from './modules/public/routes-preview.ts';
import { retentionPlatformRoutes, retentionRoutes } from './modules/retention/routes.ts';
import { sandboxRoutes } from './modules/sandbox/routes.ts';
import { rollCallRoutes } from './modules/scan/roll-call/routes-api.ts';
import { scanRoutes } from './modules/scan/routes.ts';
import { scanDisplayRoutes } from './modules/scan/routes-display.ts';
import { scanEventsRoutes } from './modules/scan/routes-events.ts';
import { scanLiveRoutes } from './modules/scan/routes-live.ts';
import { scanPairRoutes } from './modules/scan/routes-pair.ts';
import { scannersRoutes } from './modules/scan/routes-scanners.ts';
import { scanningSessionsRoutes } from './modules/scan/routes-scanning-sessions.ts';
import { scansRoutes } from './modules/scan/routes-scans.ts';
import { scanSetupsRoutes } from './modules/scan/routes-setups.ts';
import { scanShellSwRoutes } from './modules/scan/routes-shell-sw.ts';
import { scanStaffRoutes } from './modules/scan/routes-staff.ts';
import { scanZonesRoutes } from './modules/scan/routes-zones.ts';
import { settingsRoutes } from './modules/settings/routes.ts';
import { statusRoutes } from './modules/status/routes.ts';
import { templatesRoutes } from './modules/templates/routes.ts';
import { templateReviewsRoutes } from './modules/templates/routes-reviews.ts';
import { usersRoutes } from './modules/users/routes.ts';
import { walletProviderAccountRoutes } from './modules/wallet-providers/routes-accounts.ts';
import { walletImageRoutes } from './modules/wallet-providers/routes-assets.ts';
import { samsungCallbackRoutes } from './modules/wallet-providers/routes-callbacks.ts';
import { walletCredentialRoutes } from './modules/wallet-providers/routes-credentials.ts';
import { walletEnrolmentRoutes } from './modules/wallet-providers/routes-enrolments.ts';
import { googleCallbackRoutes } from './modules/wallet-providers/routes-google-callbacks.ts';
import { walletOfferRoutes } from './modules/wallet-providers/routes-offers.ts';
import { walletPlatformRoutes } from './modules/wallet-providers/routes-platform-credentials.ts';
import { walletReissueRoutes } from './modules/wallet-providers/routes-reissue.ts';
import { walletProviderStatusRoutes } from './modules/wallet-providers/routes-status.ts';
import { webhookKick } from './modules/webhooks/kick.ts';
import { webhookEndpointsRoutes } from './modules/webhooks/routes.ts';
import { eventFeedRoutes } from './modules/webhooks/routes-feed.ts';
import { apiVersionGate } from './platform/api-version.ts';
import { type AuthStores, denyAllStores, SESSION_COOKIE } from './platform/auth.ts';
import type { Clock } from './platform/clock.ts';
import { type AppBindings, requestContext } from './platform/context.ts';
import type { AppEnv } from './platform/env.ts';
import { handleError, notFoundHandler } from './platform/error-handler.ts';
import { hostPolicy } from './platform/host-policy.ts';
import { buildOpenApiDocument } from './platform/openapi-document.ts';
import { keyCallableOnly } from './platform/openapi-security.ts';
import { apiKeyRateHeaders } from './platform/rate-limit.ts';
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
const WORKER_ONLY = /^\/(?:api|auth|wallet|p|b|j|w|hooks|scim|assets|health|marketing)(?:\/|$)/;

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
  app.use('*', apiKeyRateHeaders);
  if (options.hostPolicy) app.use('*', hostPolicy);
  app.use('*', scanGate);
  app.use('*', webhookKick);
  // PX16: every API-key call is logged after the response (modules/developer/request-log.ts).
  app.use('/api/v1/*', requestLog);
  // An unknown PassBook-Version is refused here, before any handler commits a write.
  app.use('/api/v1/*', apiVersionGate);
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
  app.route('/api/v1/developer', developerRoutes);
  // Ahead of orgsRoutes, whose session-only guard would turn a key away from the read.
  app.route('/api/v1/orgs', orgEntitlementsRoutes);
  app.route('/api/v1/orgs', developerOrgRoutes);
  app.route('/api/v1/invitations', invitationRoutes);
  app.route('/api/v1/orgs', passSetupRoutes);
  app.route('/api/v1/orgs', passSetupWriteRoutes);
  app.route('/api/v1/orgs', orgsRoutes);
  app.route('/api/v1/brand', brandRoutes);
  app.route('/api/v1/orgs', walletCredentialRoutes);
  app.route('/api/v1/orgs', walletEnrolmentRoutes);
  app.route('/api/v1/orgs', retentionRoutes);
  app.route('/api/v1/orgs', orgLifecycleRoutes);
  app.route('/api/v1/org-exports', orgExportDownloadRoutes);
  app.route('/api/v1/platform', walletPlatformRoutes);
  app.route('/api/v1/platform', platformEntitlementsRoutes);
  app.route('/api/v1/platform', platformPersonalLabelsRoutes);
  app.route('/api/v1/platform', retentionPlatformRoutes);
  app.route('/api/v1/platform', orgClosedRoutes);
  app.route('/api/v1/templates', templatesRoutes);
  app.route('/api/v1/template-reviews', templateReviewsRoutes);
  app.route('/api/v1/operations', operationsRoutes);
  app.route('/api/v1/passes', passesRoutes);
  app.route('/api/v1/pass-imports', passImportRoutes);
  app.route('/api/v1/bundles', bundlesRoutes);
  app.route('/api/v1/join-links', joinLinksRoutes);
  app.route('/api/v1/test-inbox', sandboxRoutes);
  app.route('/api/v1/broadcasts', broadcastsRoutes);
  app.route('/api/v1/message-rules', messageRulesRoutes);
  app.route('/api/v1/holders', holdersRoutes);
  app.route('/api/v1/offboard', offboardRoutes);
  app.route('/api/v1/delivery', deliveryRoutes);
  app.route('/api/v1/connections', connectionsRoutes);
  app.route('/api/v1/connectors', connectorsRoutes);
  app.route('/api/v1/webhook-endpoints', webhookEndpointsRoutes);
  app.route('/api/v1/events', eventFeedRoutes);
  app.route('/api/v1/identities', identitiesRoutes);
  app.route('/api/v1/identity-runs', identityRunsRoutes);
  app.route('/api/v1/wallet-identities', walletIdentitiesRoutes);
  app.route('/api/v1/orgs', identityProvisionRoutes);
  app.route('/api/v1/platform/apple/identities', platformIdentityRoutes);
  app.route('/api/v1/platform', platformAppleRoutes);
  app.route('/api/v1/wallet-providers/accounts', walletProviderAccountRoutes);
  app.route('/api/v1/wallet-providers/passes', walletProviderStatusRoutes);
  app.route('/api/v1/wallet-providers/reissue', walletReissueRoutes);
  // Before usersRoutes: its admin-session guard would otherwise run first on `/{id}/claims`.
  app.route('/api/v1/users', userClaimsRoutes);
  app.route('/api/v1/platform', groupClaimsRoutes);
  app.route('/api/v1/users', usersRoutes);
  app.route('/api/v1/api-keys/me', apiKeyMeRoutes);
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
  app.route('/api/v1/scan-zones', scanZonesRoutes);
  app.route('/api/v1/scans', scansRoutes);
  app.route('/api/v1/roll-calls', rollCallRoutes);
  app.route('/api/v1/scan-display', scanDisplayRoutes);
  app.route('/api/v1/nfc', nfcRoutes);
  app.route('/t', tagPageRoutes);
  app.route('/wallet/v1/google', googleCallbackRoutes);
  app.route('/wallet/v1/samsung', samsungCallbackRoutes);
  app.route('/wallet/v1', appleRoutes);
  app.route('/scan', scanShellSwRoutes);
  app.route('/p', walletOfferRoutes);
  app.route('/w/i', walletImageRoutes);
  app.route('/brand', brandAssetRoutes);
  app.route('/p', publicRoutes);
  app.route('/preview', previewRoutes);
  app.route('/b', bundlePublicRoutes);
  app.route('/j', joinPublicRoutes);
  app.route('/hooks', hooksRoutes);
  app.route('/scim/v2', scimRoutes);
  app.route('/developers', developerPortalRoutes);
  app.route('/access', marketingRoutes);
  app.route('/', marketingPageRoutes);

  // The same JSON document at both paths: `/api/v1/docs` is the one to link. Everyone gets the
  // operations an API key can call; signed-in platform admins get the whole document.
  const documents: { full?: unknown; keys?: unknown } = {};
  const document = async (c: Context<AppBindings>) => {
    documents.full ??= buildOpenApiDocument(app);
    documents.keys ??= keyCallableOnly(documents.full as never);
    const cookie = getCookie(c, SESSION_COOKIE);
    const session = cookie ? await c.var.stores.sessions.resolve(cookie) : null;
    return c.json((session?.roles.includes('admin') ? documents.full : documents.keys) as never);
  };
  app.get('/api/v1/openapi.json', document);
  app.get('/api/v1/docs', document);

  return app;
}
