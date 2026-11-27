import type { Env, Hono, MiddlewareHandler } from 'hono';

type Own = { readonly routes: ReadonlyArray<{ method: string; path: string }> };
type Entry = { method: string; re: RegExp };

const owners = new WeakMap<object, (base: string, method: string, path: string) => boolean>();

/** A Hono route pattern as a regex; a trailing slash is optional. */
export const patternOf = (pattern: string): RegExp => {
  const body = pattern
    .replace(/[.+?^$()|[\]\\]/g, '\\$&')
    .replace(/:[A-Za-z0-9_]+\{([^}]*)\}/g, '$1')
    .replace(/:[A-Za-z0-9_]+/g, '[^/]+')
    .replace(/\/\*$/, '(?:/.*)?')
    .replace(/\*/g, '.*');
  return new RegExp(`^${body}/?$`);
};

const methodMatches = (own: string, method: string) =>
  own === method || (method === 'HEAD' && own === 'GET');

function ownerOf(router: Own) {
  const cache = new Map<string, { count: number; entries: Entry[] }>();
  return (base: string, method: string, path: string): boolean => {
    const hit = cache.get(base);
    const routes = router.routes;
    let entries = hit?.entries;
    if (!entries || hit?.count !== routes.length) {
      // Handlers only: `use` entries (method ALL) are the middleware being scoped.
      entries = routes
        .filter((r) => r.method !== 'ALL')
        .map((r) => ({
          method: r.method,
          re: patternOf(`${base}${r.path === '/' ? '' : r.path}`),
        }));
      cache.set(base, { count: routes.length, entries });
    }
    return entries.some((e) => methodMatches(e.method, method) && e.re.test(path));
  };
}

/**
 * Runs `mw` only for requests one of the router's own handlers matches. Hono runs a router's
 * `use('*', ...)` for every request under its mount path, so on a prefix shared with another
 * router (e.g. /api/v1/orgs) a bare wildcard also reaches that router's routes.
 */
export function ownRoutesOnly<E extends Env>(
  router: Hono<E> | Own,
  mw: MiddlewareHandler<E>,
  path = '*',
): MiddlewareHandler<E> {
  const owns = ownerOf(router);
  const rel = path === '*' ? '/*' : path;
  const scoped: MiddlewareHandler<E> = (c, next) => {
    const mounted = c.req.routePath;
    const base = mounted.endsWith(rel) ? mounted.slice(0, mounted.length - rel.length) : '';
    return owns(base, c.req.method, c.req.path) ? mw(c, next) : next();
  };
  owners.set(scoped, owns);
  return scoped;
}

/** Whether `scoped` (from `ownRoutesOnly`) would run for this request; undefined for any other handler. */
export const scopedOwns = (scoped: unknown, base: string, method: string, path: string) =>
  typeof scoped === 'function' ? owners.get(scoped)?.(base, method, path) : undefined;

/** `router.use('*', mw)` that stays on the router's own routes. */
export const ownUse = <E extends Env>(router: Hono<E>, mw: MiddlewareHandler<E>): void => {
  router.use('*', ownRoutesOnly(router, mw));
};

const wholeMount = new WeakSet<object>();

/** `router.use('*', mw)` that reaches every route under the mount on purpose, other routers' included. */
export const wholeMountUse = <E extends Env>(router: Hono<E>, mw: MiddlewareHandler<E>): void => {
  const marked: MiddlewareHandler<E> = (c, next) => mw(c, next);
  wholeMount.add(marked);
  router.use('*', marked);
};

export const isWholeMount = (handler: unknown) =>
  typeof handler === 'function' && wholeMount.has(handler);
