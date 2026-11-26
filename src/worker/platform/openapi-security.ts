import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { ApiScope, RouteAuth, ScopeRule } from './auth.ts';
import { SESSION_COOKIE } from './auth.ts';
import type { AppBindings } from './context.ts';
import type { FeatureRule } from './feature-guard.ts';
import { isOidcOnly, signInLevelOf, stepUpOf } from './sign-in-guard.ts';

/** What an API key needs on the routes a guard covers; read for GET and HEAD, write for the rest. */
export interface KeyAccess {
  read: readonly ApiScope[];
  write?: readonly ApiScope[];
  /** Any valid key, whatever its scopes. */
  anyKey?: boolean;
  /** Limits the claim to doc paths that match. */
  only?: RegExp;
  /** The guard only documents key access; another guard on the route does the checking. */
  documentOnly?: true;
}

/** The scopes a rule accepts, for reads and for the rest. */
export function keyAccessOf(rule: ScopeRule): KeyAccess {
  if (typeof rule === 'string') return { read: [rule], write: [rule] };
  if (Array.isArray(rule)) return { read: rule, write: rule };
  const split = rule as { read: ApiScope; write: ApiScope };
  return { read: [split.read], write: [split.write] };
}

const accessOf = new WeakMap<object, KeyAccess>();

/** Declares, next to a guard, the key scopes it accepts, so the OpenAPI document can list them. */
export function declareKeyAccess<T extends MiddlewareHandler<AppBindings>>(
  guard: T,
  access: KeyAccess,
): T {
  accessOf.set(guard, access);
  return guard;
}

const isRead = (method: string) => method === 'get' || method === 'head';

/** The scopes a rule accepts for a method: the read half for GET and HEAD, the write half else. */
export function scopesForMethod(rule: ScopeRule, method: string): readonly ApiScope[] {
  const access = keyAccessOf(rule);
  return isRead(method) ? access.read : (access.write ?? []);
}

/** Whether a guard declared key access and enforces it: a route it covers has its access decision. */
export const enforcesKeyAccess = (guard: object): boolean => {
  const access = accessOf.get(guard);
  return access !== undefined && access.documentOnly !== true;
};

/** The OpenAPI `security` (and extensions) a route's `auth` declaration writes. */
export function operationSecurity(
  auth: RouteAuth,
  method: string,
): {
  security: unknown[];
  'x-human-only'?: true | 'apply';
  'x-platform-scope'?: string;
  'x-feature'?: FeatureRule;
} {
  if ('platform' in auth) {
    const scope = { 'x-platform-scope': auth.platform };
    // No `key`: a person only. `key.unless`: a key may call it, but some requests (named in the description) need a person.
    if (!auth.key) return { security: [{ session: [] }], 'x-human-only': true, ...scope };
    return {
      security: [
        { apiKey: [auth.platform] },
        ...(isRead(method) ? [{ apiKey: ['platform:read'] }] : []),
        { session: [] },
      ],
      ...(auth.key === true ? {} : { 'x-human-only': 'apply' as const }),
      ...scope,
    };
  }
  // The entitlement the organization must have: a key, or { key, atLeast } for a level.
  const feature = auth.feature === undefined ? {} : { 'x-feature': auth.feature };
  if ('human' in auth) return { security: [{ session: [] }], 'x-human-only': true, ...feature };
  const scopes = scopesForMethod(auth.scope, method);
  return {
    security: [...scopes.map((scope) => ({ apiKey: [scope] })), { session: [] }],
    ...feature,
  };
}
const patternOf = (path: string) =>
  new RegExp(
    `^${path
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\/\*$/, '(?:/.*)?')
      .replace(/\*/g, '.*')
      .replace(/:[A-Za-z0-9_]+/g, '[^/]+')}/?$`,
  );

/** Scopes that let a key call `method path`, or null when the key is not accepted. */
function keyScopes(
  app: OpenAPIHono<AppBindings>,
  method: string,
  docPath: string,
): { scopes: ApiScope[]; any: boolean } | null {
  const sample = docPath.replace(/\{([^}]+)\}/g, '$1');
  const scopes = new Set<ApiScope>();
  let any = false;
  let seen = false;
  for (const r of app.routes) {
    const access = accessOf.get(r.handler);
    if (!access || (r.method !== 'ALL' && r.method.toLowerCase() !== method)) continue;
    if (!patternOf(r.path).test(sample) || (access.only && !access.only.test(docPath))) continue;
    const list = isRead(method) ? access.read : (access.write ?? []);
    if (!access.anyKey && list.length === 0) continue;
    seen = true;
    if (access.anyKey) any = true;
    for (const s of list) scopes.add(s);
  }
  return seen ? { scopes: [...scopes], any } : null;
}

type Doc = {
  paths?: Record<string, Record<string, { security?: unknown } | undefined>>;
  components?: Record<string, unknown>;
} & Record<string, unknown>;

/** Adds the security schemes, and per operation the scopes an API key needs. */
export function withSecurity(app: OpenAPIHono<AppBindings>, doc: Doc): Doc {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      // A route that declares `auth` already carries its own security.
      if (!op || typeof op !== 'object' || op.security !== undefined) continue;
      const key = keyScopes(app, method, path);
      if (!key) continue;
      op.security = [
        ...(key.any ? [{ apiKey: [] }] : key.scopes.map((scope) => ({ apiKey: [scope] }))),
        { session: [] },
      ];
    }
  }
  doc.components = {
    ...doc.components,
    securitySchemes: {
      apiKey: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'pb_<live|test>_<prefix>_<secret>',
        description:
          'An API key, for server calls only. A key with any one of the listed scopes may call the operation, in its own organization and mode. Sent with browser headers (`Origin`, `Sec-Fetch-Site` or a PassBook cookie) it is refused: 403 `KEY_IN_BROWSER`.',
      },
      session: {
        type: 'apiKey',
        in: 'cookie',
        name: SESSION_COOKIE,
        description: 'A signed-in console session, checked against the member role.',
      },
    },
  };
  return doc;
}

/**
 * `x-sign-in` on every operation a session reaches: `idp` (a strong sign-in, Polaris ID) or `any` (an email
 * link too: holder features). Read from the guards covering the route, strictest wins; none found reads `idp`.
 */
export function withSignIn(app: OpenAPIHono<AppBindings>, doc: Doc): Doc {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const sample = path.replace(/\{([^}]+)\}/g, '$1');
    const exact = path.replace(/\{([^}]+)\}/g, ':$1');
    for (const [method, op] of Object.entries(item)) {
      const security = (op as { security?: unknown } | undefined)?.security;
      if (
        !Array.isArray(security) ||
        !security.some((s) => s && typeof s === 'object' && 'session' in s)
      )
        continue;
      // Only what runs before the route's own handler guards it (Hono runs middleware in registration order).
      const last = app.routes.findLastIndex(
        (r) => r.method.toLowerCase() === method && r.path === exact,
      );
      const guards = app.routes
        .filter(
          (r, i) =>
            (last < 0 || i < last) &&
            (r.method === 'ALL' || r.method.toLowerCase() === method) &&
            patternOf(r.path).test(sample),
        )
        .map((r) => r.handler);
      const levels = guards.map((g) => signInLevelOf(g));
      Object.assign(op as object, {
        'x-sign-in': guards.some((g) => isOidcOnly(g))
          ? 'oidc'
          : levels.some((l) => l !== 'any') || !levels.includes('any')
            ? 'idp'
            : 'any',
      });
    }
  }
  return doc;
}

/**
 * `x-step-up` on every session operation that asks for a recent sign-in: `{ maxAgeSec, conditional }`
 * (conditional: only for some requests). A key is never asked. Read from the guards before the handler.
 */
export function withStepUp(app: OpenAPIHono<AppBindings>, doc: Doc): Doc {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const sample = path.replace(/\{([^}]+)\}/g, '$1');
    const exact = path.replace(/\{([^}]+)\}/g, ':$1');
    for (const [method, op] of Object.entries(item)) {
      const last = app.routes.findLastIndex(
        (r) => r.method.toLowerCase() === method && r.path === exact,
      );
      const decls = app.routes
        .filter(
          (r, i) =>
            (last < 0 || i < last) &&
            (r.method === 'ALL' || r.method.toLowerCase() === method) &&
            patternOf(r.path).test(sample),
        )
        .map((r) => stepUpOf(r.handler))
        .filter((d) => d !== undefined);
      if (decls.length === 0) continue;
      Object.assign(op as object, {
        'x-step-up': {
          maxAgeSec: Math.min(...decls.map((d) => d.maxAgeSec)),
          conditional: decls.every((d) => d.conditional),
        },
      });
    }
  }
  return doc;
}

/** The operations an API key can call: what the public document lists. */
export function keyCallableOnly(doc: Doc): Doc {
  const paths: NonNullable<Doc['paths']> = {};
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const kept = Object.entries(item).filter(([, op]) => {
      const security = op?.security;
      return (
        Array.isArray(security) && security.some((s) => s && typeof s === 'object' && 'apiKey' in s)
      );
    });
    if (kept.length) paths[path] = Object.fromEntries(kept);
  }
  return { ...doc, paths };
}
