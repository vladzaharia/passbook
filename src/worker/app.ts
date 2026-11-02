import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { apiKeysRoutes } from './modules/api-keys/routes.ts';
import { appleRoutes } from './modules/apple/routes.ts';
import { auditRoutes } from './modules/audit/routes.ts';
import { limitBody } from './modules/auth/body-limit.ts';
import { authRoutes, sessionRoutes } from './modules/auth/routes.ts';
import { connectionsRoutes, connectorsRoutes, hooksRoutes } from './modules/connections/routes.ts';
import { deliveryRoutes } from './modules/delivery/routes.ts';
import { holdersRoutes } from './modules/holders/routes.ts';
import { identitiesRoutes } from './modules/identities/routes.ts';
import { meRoutes } from './modules/me/routes.ts';
import { metricsRoutes } from './modules/metrics/routes.ts';
import { orgsRoutes } from './modules/orgs/routes.ts';
import { passesRoutes } from './modules/passes/routes.ts';
import { publicRoutes } from './modules/public/routes.ts';
import { settingsRoutes } from './modules/settings/routes.ts';
import { statusRoutes } from './modules/status/routes.ts';
import { templatesRoutes } from './modules/templates/routes.ts';
import { usersRoutes } from './modules/users/routes.ts';
import { type AuthStores, denyAllStores } from './platform/auth.ts';
import type { Clock } from './platform/clock.ts';
import { type AppBindings, requestContext } from './platform/context.ts';
import type { AppEnv } from './platform/env.ts';
import { handleError, notFoundHandler } from './platform/error-handler.ts';
import { securityHeaders } from './platform/security-headers.ts';

const DEFAULT_BODY_BYTES = 256 * 1024;
const UPLOAD_PATH = /^\/api\/v1\/(templates\/uploads|passes\/[^/]+\/assets\/[^/]+)$/;
const sized = limitBody(DEFAULT_BODY_BYTES);
/** Routes with their own larger caps (template archive, image assets) opt out. */
const defaultBodyLimit: MiddlewareHandler = (c, next) =>
  UPLOAD_PATH.test(new URL(c.req.url).pathname) ? next() : sized(c, next);

export interface AppOptions {
  /** Session and API-key stores. Production wiring lives in stores.ts; tests pass fakes. */
  stores?: AuthStores | ((env: AppEnv) => AuthStores);
  clock?: Clock;
}

/** One line per module. Adding a module means adding a line here and nothing else shared. */
export function createApp(options: AppOptions = {}): OpenAPIHono<AppBindings> {
  const app = new OpenAPIHono<AppBindings>();
  app.use('*', requestContext({ stores: options.stores ?? denyAllStores, clock: options.clock }));
  app.use('*', securityHeaders);
  app.use('/api/v1/*', defaultBodyLimit);
  app.use('/hooks/*', limitBody(DEFAULT_BODY_BYTES));
  app.onError(handleError);
  app.notFound(notFoundHandler);

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
  app.route('/api/v1/holders', holdersRoutes);
  app.route('/api/v1/delivery', deliveryRoutes);
  app.route('/api/v1/connections', connectionsRoutes);
  app.route('/api/v1/connectors', connectorsRoutes);
  app.route('/api/v1/identities', identitiesRoutes);
  app.route('/api/v1/users', usersRoutes);
  app.route('/api/v1/api-keys', apiKeysRoutes);
  app.route('/api/v1/settings', settingsRoutes);
  app.route('/api/v1/audit', auditRoutes);
  app.route('/api/v1/status', statusRoutes);
  app.route('/api/v1/metrics', metricsRoutes);
  app.route('/wallet/v1', appleRoutes);
  app.route('/p', publicRoutes);
  app.route('/hooks', hooksRoutes);

  app.doc31('/api/v1/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'Wallet API', version: '1.0.0' },
    servers: [{ url: '/' }],
  });

  return app;
}
