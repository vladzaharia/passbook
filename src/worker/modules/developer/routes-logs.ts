import { createMiddleware } from 'hono/factory';
import {
  ApiRailSchema,
  IdParamSchema,
  RequestLogDetailSchema,
  RequestLogPageSchema,
  RequestLogQuerySchema,
  ResolvedSchema,
  ResolveQuerySchema,
} from '../../../shared/contracts/index.ts';
import { apiKeyMissing, bearerOf, keyCaller, requireSession } from '../../platform/auth.ts';
import { TRY_TOKEN_PREFIX } from '../../platform/browser-signals.ts';
import type { AppBindings } from '../../platform/context.ts';
import { noteKeyRefused } from '../../platform/denied.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { declareKeyAccess } from '../../platform/openapi-security.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { apiRail, getRequestLog, listRequestLog } from './request-log-service.ts';
import { resolveId } from './resolve-service.ts';

/**
 * The portal reads its own sandbox's log with the session, or with the try token it sends beside it. A try token
 * names its org and a session finds the person's sandbox; neither takes an org from the request. A real API key is
 * not accepted. Declared with no key scopes, so the public document lists no key for these operations.
 */
export const logCaller = declareKeyAccess(
  createMiddleware<AppBindings>(async (c, next) => {
    const sent = bearerOf(c);
    if (sent === 'empty') throw apiKeyMissing();
    const token = sent?.token;
    if (token?.startsWith(TRY_TOKEN_PREFIX)) {
      const key = await c.var.stores.apiKeys.resolve(token, keyCaller(c));
      if (key?.via !== 'try' || key.orgId === null) {
        noteKeyRefused(c, { code: 'INVALID_API_KEY', token });
        throw new UnauthenticatedError('The try token is invalid or expired.', 'INVALID_API_KEY');
      }
      c.set('auth', key);
      return next();
    }
    return requireSession(c, next);
  }),
  { read: [], write: [] },
);

export const developerLogRoutes = createRouter();
for (const path of ['/logs', '/logs/*', '/rail', '/resolve'])
  developerLogRoutes.use(path, logCaller);

register(
  developerLogRoutes,
  'developer',
  {
    method: 'get',
    path: '/logs',
    summary: 'The request log of your sandbox: metadata for 7 days',
    operationId: 'developer.getLogs',
    query: RequestLogQuerySchema,
    response: RequestLogPageSchema,
  },
  async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(await listRequestLog(serviceContext(c), c.var.auth, c.req.valid('query')));
  },
);

register(
  developerLogRoutes,
  'developer',
  {
    method: 'get',
    path: '/logs/{id}',
    summary: 'One request of your sandbox, with its redacted bodies for 24 hours',
    operationId: 'developer.getLog',
    params: IdParamSchema,
    response: RequestLogDetailSchema,
  },
  async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(await getRequestLog(serviceContext(c), c.var.auth, c.req.valid('param').id));
  },
);

register(
  developerLogRoutes,
  'developer',
  {
    method: 'get',
    path: '/rail',
    summary: 'Your API: the sandbox key, its scopes and tier, and the calls of the last hour',
    operationId: 'developer.getRail',
    response: ApiRailSchema,
  },
  async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(await apiRail(serviceContext(c), c.var.auth));
  },
);

register(
  developerLogRoutes,
  'developer',
  {
    method: 'get',
    path: '/resolve',
    summary: 'What a pasted id is in your sandbox. An alias of GET /resolve',
    operationId: 'developer.getResolve',
    query: ResolveQuerySchema,
    response: ResolvedSchema,
  },
  async (c) => {
    c.header('cache-control', 'no-store');
    const { id, orgId } = c.req.valid('query');
    return c.json(await resolveId(serviceContext(c), c.var.auth, id, { orgId, style: 'portal' }));
  },
);
