import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { hooksMounts } from './app-routes-hooks.ts';
import { platformMounts } from './app-routes-platform.ts';
import { publicMounts } from './app-routes-public.ts';
import { tenantMounts } from './app-routes-tenant.ts';
import { requestLog } from './modules/developer/request-log.ts';
import { webhookKick } from './modules/webhooks/kick.ts';
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
import { assertScopedPatterns } from './platform/router-scope.ts';
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
const WORKER_ONLY = /^\/(?:api|auth|wallet|p|b|j|w|hooks|scim|assets|health|marketing|d)(?:\/|$)/;

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

  // The order is the one the routes were mounted in: it sets the order of the OpenAPI components.
  const groupAt = <T>(list: readonly T[], i: number): T => {
    const group = list[i];
    if (!group) throw new Error(`route group ${i} is missing from its list in app-routes-*.ts`);
    return group;
  };
  const order = [
    groupAt(tenantMounts, 0),
    groupAt(platformMounts, 0),
    groupAt(tenantMounts, 1),
    groupAt(platformMounts, 1),
    groupAt(tenantMounts, 2),
    groupAt(publicMounts, 0),
    ...hooksMounts,
    groupAt(publicMounts, 1),
  ];
  // A group added to a list but not placed above would never be mounted.
  for (const group of [...tenantMounts, ...platformMounts, ...publicMounts, ...hooksMounts])
    if (!order.includes(group)) throw new Error('a route group in app-routes-*.ts is not mounted');
  for (const mounts of order) for (const [path, routes] of mounts) app.route(path, routes);

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

  assertScopedPatterns(app);
  return app;
}
