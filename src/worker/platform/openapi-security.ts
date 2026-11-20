import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { ApiScope, RouteAuth, ScopeRule } from './auth.ts';
import { SESSION_COOKIE } from './auth.ts';
import type { AppBindings } from './context.ts';

/** What an API key needs on the routes a guard covers; read for GET and HEAD, write for the rest. */
export interface KeyAccess {
  read: readonly ApiScope[];
  write?: readonly ApiScope[];
  /** Any valid key, whatever its scopes. */
  anyKey?: boolean;
  /** Limits the claim to doc paths that match. */
  only?: RegExp;
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

/** Whether a guard declared its key scopes, which puts its routes in the OpenAPI document. */
export const hasKeyAccess = (guard: object): boolean => accessOf.has(guard);

/** The OpenAPI `security` (and extensions) a route's `auth` declaration writes. */
export function operationSecurity(
  auth: RouteAuth,
  method: string,
): { security: unknown[]; 'x-human-only'?: true; 'x-platform-scope'?: string } {
  if ('human' in auth) return { security: [{ session: [] }], 'x-human-only': true };
  if ('platform' in auth) return { security: [{ session: [] }], 'x-platform-scope': auth.platform };
  const scopes = scopesForMethod(auth.scope, method);
  return { security: [...scopes.map((scope) => ({ apiKey: [scope] })), { session: [] }] };
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
        bearerFormat: 'wlt_<prefix>_<secret>',
        description:
          'An API key. A key with any one of the listed scopes may call the operation, in its own organization and mode.',
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
