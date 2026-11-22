// Frozen copy of the guards `requireCaller` replaced (as of origin/main 3e3dabf1), kept so
// route-auth.test.ts can prove the declaration behaves exactly like the code it superseded.
// Do not "fix" this file: a difference from requireCaller is what the test exists to find.
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import {
  type ApiScope,
  type AuthContext,
  modeFromRequest,
  SESSION_COOKIE,
  type SessionAuth,
} from './auth.ts';
import type { AppBindings } from './context.ts';
import { csrfGuard } from './csrf.ts';
import { noteKeyRefused, reportDenied } from './denied.ts';
import { ForbiddenError, UnauthenticatedError } from './errors.ts';

type Selector = ApiScope | ((c: Context<AppBindings>) => ApiScope);

const bearer = (c: Context) =>
  /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? null;
async function sessionOrThrow(c: Context<AppBindings>): Promise<SessionAuth> {
  const cookie = getCookie(c, SESSION_COOKIE);
  const session =
    c.var.auth?.kind === 'session'
      ? c.var.auth
      : cookie
        ? await c.var.stores.sessions.resolve(cookie)
        : null;
  if (!session) throw new UnauthenticatedError();
  c.set('auth', session);
  return session;
}

/** The old requireSession, frozen. */
export const legacyRequireSession: MiddlewareHandler<AppBindings> = createMiddleware(
  async (c, next) => {
    const session = await sessionOrThrow(c);
    await csrfGuard(c, session);
    await next();
  },
);

/** The old requireAdmin, frozen. */
export const legacyRequireAdmin: MiddlewareHandler<AppBindings> = createMiddleware(
  async (c, next) => {
    const session = await sessionOrThrow(c);
    if (!session.roles.includes('admin')) {
      reportDenied(c, 'FORBIDDEN', session);
      throw new ForbiddenError('Admin access is required.');
    }
    c.set('auth', { ...session, mode: modeFromRequest(c) });
    await csrfGuard(c, session);
    await next();
  },
);

const tags = new WeakMap<AuthContext, ApiScope>();
export const legacyTagOf = (auth: AuthContext) => tags.get(auth);

export function legacyMethodScope(scopes: { read: ApiScope; write: ApiScope }): Selector {
  return Object.assign(
    (c: Context<AppBindings>) =>
      c.req.method === 'GET' || c.req.method === 'HEAD' ? scopes.read : scopes.write,
    { scopes },
  );
}

export function legacyKeyOrAdmin(scope: Selector): MiddlewareHandler<AppBindings> {
  return createMiddleware(async (c, next) => {
    const key = bearer(c);
    if (key) {
      const auth = await c.var.stores.apiKeys.resolve(key);
      if (!auth) {
        noteKeyRefused(c, { code: 'INVALID_API_KEY', token: key });
        throw new UnauthenticatedError('The API key is invalid or expired.', 'INVALID_API_KEY');
      }
      const needed = typeof scope === 'function' ? scope(c) : scope;
      if (!auth.scopes.includes(needed)) {
        reportDenied(c, 'MISSING_SCOPE', auth);
        noteKeyRefused(c, { code: 'MISSING_SCOPE', keyId: auth.keyId, scope: needed });
        throw new ForbiddenError(`The API key lacks the ${needed} scope.`, 'MISSING_SCOPE');
      }
      c.set('auth', auth);
      return next();
    }
    return legacyRequireAdmin(c, next);
  });
}

export const legacyTenantSession: MiddlewareHandler<AppBindings> = createMiddleware(
  async (c, next) =>
    legacyRequireSession(c, async () => {
      const auth = c.var.auth;
      if (auth?.kind !== 'session') throw new UnauthenticatedError();
      c.set('auth', { ...auth, mode: modeFromRequest(c) });
      await next();
    }),
);

export function legacyTenantSessionOrApiKey(
  scope: Selector | readonly ApiScope[],
): MiddlewareHandler<AppBindings> {
  if (Array.isArray(scope)) {
    return createMiddleware<AppBindings>(async (c, next) => {
      const token = bearer(c);
      if (!token) return legacyTenantSession(c, next);
      const auth = await c.var.stores.apiKeys.resolve(token);
      if (!auth) {
        noteKeyRefused(c, { code: 'INVALID_API_KEY', token });
        throw new UnauthenticatedError('The API key is invalid or expired.', 'INVALID_API_KEY');
      }
      const selected = scope.find((candidate) => auth.scopes.includes(candidate));
      if (!selected) {
        reportDenied(c, 'MISSING_SCOPE', auth);
        noteKeyRefused(c, { code: 'MISSING_SCOPE', keyId: auth.keyId, scope: null });
        throw new ForbiddenError('The API key lacks a required scope.', 'MISSING_SCOPE');
      }
      const scoped = { ...auth };
      tags.set(scoped, selected);
      c.set('auth', scoped);
      await next();
    });
  }
  const selector = scope as Selector;
  const keyGuard = legacyKeyOrAdmin(selector);
  return createMiddleware<AppBindings>(async (c, next) => {
    if (bearer(c)) {
      return keyGuard(c, async () => {
        const auth = c.var.auth;
        if (auth?.kind !== 'api_key') throw new UnauthenticatedError();
        const scoped = { ...auth };
        tags.set(scoped, typeof selector === 'function' ? selector(c) : selector);
        c.set('auth', scoped);
        await next();
      });
    }
    return legacyTenantSession(c, next);
  });
}

/** The old key-scope-to-capability table and the old `permitted` predicate in tenantAuthorityOf. */
export const LEGACY_SCOPE_CAPABILITY = {
  'passes:read': 'passes:read',
  'passes:write': 'passes:operate',
  'holders:write': 'passes:operate',
  'templates:read': 'templates:read',
  'messages:write': 'messages:manage',
  'scans:read': 'scanning:read',
  'scans:write': 'passes:operate',
  'connections:read': 'integrations:read',
  'connections:write': 'integrations:manage',
  'webhooks:manage': 'integrations:manage',
} as const;

export function legacyPermitted(scope: string, capability: string): boolean {
  return (
    (capability === 'passes:read' && scope === 'passes:read') ||
    (capability === 'passes:operate' && (scope === 'passes:write' || scope === 'holders:write')) ||
    (capability === 'integrations:read' && scope === 'connections:read') ||
    (capability === 'integrations:manage' && scope === 'connections:write') ||
    ((capability === 'integrations:read' || capability === 'integrations:manage') &&
      scope === 'webhooks:manage') ||
    (capability === 'templates:read' && scope === 'templates:read') ||
    (capability === 'scanning:read' && scope === 'scans:read') ||
    ((capability === 'messages:read' || capability === 'messages:manage') &&
      scope === 'messages:write')
  );
}
