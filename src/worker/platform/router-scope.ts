import type { Context, Env, Hono, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';

type Own = {
  readonly routes: ReadonlyArray<{ method: string; path: string; handler: unknown }>;
};
type Entry = { method: string; re: RegExp };

const inner = new WeakMap<object, object>();
/** The middleware behind an `ownRoutesOnly` wrapper, so the guard registries still recognise it. */
export const innerOf = (handler: object): object => inner.get(handler) ?? handler;

const routers = new WeakMap<object, Own>();
/** The router an `ownRoutesOnly` wrapper was made for; undefined for any other handler. */
export const scopedRouter = (scoped: unknown) =>
  typeof scoped === 'function' ? routers.get(scoped) : undefined;

const owners = new WeakMap<object, (base: string, method: string, path: string) => boolean>();

const esc = (text: string) => text.replace(/[.+?^$()|[\]{}\\*]/g, '\\$&');

/**
 * A Hono route pattern as a regex; a trailing slash is optional. Handles `:id`, `:id{regex}`,
 * `:id?` and `*`; any other use of `{`, `}` or `?` throws. `assertScopedPatterns` runs it over every
 * scoped router when the app is built, so a route this cannot read fails at startup instead of
 * silently losing its router's guard.
 */
export const patternOf = (pattern: string): RegExp => {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === ':') {
      const name = /^:[A-Za-z0-9_]+/.exec(pattern.slice(i));
      if (!name) throw new Error(`router-scope: cannot read route pattern ${pattern}`);
      i += name[0].length;
      let re = '[^/]+';
      if (pattern.charAt(i) === '{') {
        let depth = 0;
        let j = i;
        for (; j < pattern.length; j += 1) {
          const c = pattern.charAt(j);
          if (c === '\\') j += 1;
          else if (c === '{') depth += 1;
          else if (c === '}' && --depth === 0) break;
        }
        if (depth !== 0) throw new Error(`router-scope: cannot read route pattern ${pattern}`);
        re = pattern
          .slice(i + 1, j)
          .replace(/^\^/, '')
          .replace(/\$$/, '');
        i = j + 1;
      }
      if (pattern.charAt(i) === '?') {
        i += 1;
        if (out.endsWith('/')) out = out.slice(0, -1);
        out += `(?:/(?:${re}))?`;
      } else out += `(?:${re})`;
    } else if (ch === '*') {
      if (i === pattern.length - 1 && out.endsWith('/')) out = `${out.slice(0, -1)}(?:/.*)?`;
      else out += '.*';
      i += 1;
    } else if (ch === '{' || ch === '}' || ch === '?') {
      throw new Error(`router-scope: cannot read route pattern ${pattern}`);
    } else {
      out += esc(ch);
      i += 1;
    }
  }
  return new RegExp(`^${out}/?$`);
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

/** Whether any route handler (not middleware) matches this request's method and path. */
const hasHandler = (c: Context) =>
  matchedRoutes(c).some((r) => methodMatches(r.method, c.req.method) && r.method !== 'ALL');

/**
 * Runs `mw` only for requests one of the router's own handlers matches. Hono runs a router's
 * `use('*', ...)` for every request under its mount path, so on a prefix shared with another
 * router (e.g. /api/v1/orgs) a bare wildcard also reaches that router's routes. A request no
 * handler answers at all (an unknown path, a wrong method) still runs it, so an anonymous caller
 * gets the guard's 401 there instead of a 404 that lists which routes exist.
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
    return owns(base, c.req.method, c.req.path) || !hasHandler(c) ? mw(c, next) : next();
  };
  owners.set(scoped, owns);
  routers.set(scoped, router as Own);
  inner.set(scoped, innerOf(mw));
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
  inner.set(marked, innerOf(mw));
  router.use('*', marked);
};

export const isWholeMount = (handler: unknown) =>
  typeof handler === 'function' && wholeMount.has(handler);

/** Throws if a router with a scoped middleware has a route `patternOf` cannot read. */
export const assertScopedPatterns = (app: { routes: ReadonlyArray<{ handler: unknown }> }) => {
  for (const { handler } of app.routes)
    for (const r of scopedRouter(handler)?.routes ?? []) patternOf(r.path);
};
