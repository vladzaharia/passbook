import { createMiddleware } from 'hono/factory';
import type { AuthContext, AuthStores } from './auth.ts';
import { type Clock, systemClock } from './clock.ts';
import type { AppEnv } from './env.ts';
import { createIds, type Ids } from './ids.ts';
import { createLogger, type Logger } from './log.ts';

export type Actor =
  | { type: 'user'; id: string }
  | { type: 'api_key'; id: string }
  | { type: 'system'; id: string | null }
  | { type: 'connection'; id: string }
  | { type: 'device'; id: string }
  | { type: 'scanner'; id: string };

export interface AppVariables {
  requestId: string;
  clock: Clock;
  ids: Ids;
  log: Logger;
  /** Per-request CSP nonce for SSR pages. */
  nonce: string;
  stores: AuthStores;
  auth?: AuthContext;
}

export interface AppBindings {
  Bindings: AppEnv;
  Variables: AppVariables;
}

export function actorOf(auth: AuthContext | undefined): Actor {
  if (!auth) return { type: 'system', id: null };
  if (auth.kind === 'session') return { type: 'user', id: auth.userId };
  if (auth.kind === 'scanner') return { type: 'scanner', id: auth.scannerId };
  return { type: 'api_key', id: auth.keyId };
}

export interface ContextOptions {
  clock?: Clock;
  /** A factory is called per request with that request's env, so nothing outlives the request. */
  stores: AuthStores | ((env: AppEnv) => AuthStores);
  logger?: (base: Record<string, unknown>) => Logger;
}

/** Share of successful requests that log `request.done`; every 4xx logs. */
const SUCCESS_SAMPLE = 0.05;

/** Sets requestId, clock, ids, logger, nonce and auth stores on every request. */
export function requestContext(options: ContextOptions) {
  return createMiddleware<AppBindings>(async (c, next) => {
    const clock = options.clock ?? systemClock;
    const ids = createIds(clock);
    const requestId = c.req.header('cf-ray') ?? ids.id();
    c.set('requestId', requestId);
    c.set('clock', clock);
    c.set('ids', ids);
    c.set('nonce', btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))));
    c.set('stores', typeof options.stores === 'function' ? options.stores(c.env) : options.stores);
    const base = { requestId, build: c.env.CF_VERSION?.id };
    c.set('log', options.logger ? options.logger(base) : createLogger(base));
    c.header('x-request-id', requestId);
    const started = clock.now();
    await next();
    const status = c.res.status;
    // Route pattern only, never the URL: paths carry capability tokens. 5xx is logged by the error handler.
    if (status < 500 && (status >= 400 || Math.random() < SUCCESS_SAMPLE))
      c.var.log.info('request.done', {
        route: c.req.routePath,
        method: c.req.method,
        status,
        ms: clock.now() - started,
      });
  });
}
