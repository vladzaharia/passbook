import { createMiddleware } from 'hono/factory';
import type { ApiKeyAuth, AuthContext, AuthStores, SessionAuth } from './auth.ts';
import { type Clock, systemClock } from './clock.ts';
import type { AppEnv } from './env.ts';
import { createIds, type Ids } from './ids.ts';
import { createLogger, type Logger } from './log.ts';

export type Actor =
  | { type: 'user'; id: string }
  | { type: 'api_key'; id: string }
  | { type: 'system'; id: string | null }
  | { type: 'connection'; id: string }
  | { type: 'device'; id: string };

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
  return auth.kind === 'session'
    ? { type: 'user', id: auth.userId }
    : { type: 'api_key', id: auth.keyId };
}

export interface ContextOptions {
  clock?: Clock;
  stores: AuthStores;
  logger?: (base: Record<string, unknown>) => Logger;
}

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
    c.set('stores', options.stores);
    const base = { requestId, build: c.env.CF_VERSION?.id };
    c.set('log', options.logger ? options.logger(base) : createLogger(base));
    c.header('x-request-id', requestId);
    await next();
  });
}
