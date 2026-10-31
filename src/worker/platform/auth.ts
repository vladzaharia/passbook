import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { AppBindings } from './context.ts';
import { csrfGuard } from './csrf.ts';
import { ForbiddenError, UnauthenticatedError } from './errors.ts';

export type Role = 'admin' | 'user';
export const API_SCOPES = [
  'passes:read',
  'passes:write',
  'holders:write',
  'templates:read',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SESSION_COOKIE = '__Host-wallet_sid';

export interface SessionAuth {
  kind: 'session';
  userId: string;
  sessionId: string;
  roles: Role[];
  csrfSecret: string;
  amr: 'oidc' | 'magic_link';
}

export interface ApiKeyAuth {
  kind: 'api_key';
  keyId: string;
  /** null = platform-wide key. */
  orgId: string | null;
  scopes: ApiScope[];
}

export type AuthContext = SessionAuth | ApiKeyAuth;

/** Implemented by modules/auth. Returns null for unknown, expired, revoked or disabled-user sessions. */
export interface SessionStore {
  resolve(cookieValue: string): Promise<SessionAuth | null>;
}

/** Implemented by modules/api-keys. Hashes the presented key; returns null when invalid. */
export interface ApiKeyStore {
  resolve(rawKey: string): Promise<ApiKeyAuth | null>;
}

export interface AuthStores {
  sessions: SessionStore;
  apiKeys: ApiKeyStore;
}

export const denyAllStores: AuthStores = {
  sessions: { resolve: async () => null },
  apiKeys: { resolve: async () => null },
};

function bearer(c: Context): string | null {
  const header = c.req.header('authorization');
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1] ?? null;
}

async function resolveSession(c: Context<AppBindings>): Promise<SessionAuth | null> {
  const cookie = getCookie(c, SESSION_COOKIE);
  return cookie ? c.var.stores.sessions.resolve(cookie) : null;
}

/** Loads the auth context if present; never rejects. */
export const loadAuth: MiddlewareHandler<AppBindings> = createMiddleware(async (c, next) => {
  const key = bearer(c);
  const auth = key ? await c.var.stores.apiKeys.resolve(key) : await resolveSession(c);
  if (auth) c.set('auth', auth);
  await next();
});

async function sessionOrThrow(c: Context<AppBindings>): Promise<SessionAuth> {
  const session = c.var.auth?.kind === 'session' ? c.var.auth : await resolveSession(c);
  if (!session) throw new UnauthenticatedError();
  c.set('auth', session);
  return session;
}

/** Cookie session (user or admin). State-changing requests also pass the CSRF check. */
export const requireSession: MiddlewareHandler<AppBindings> = createMiddleware(async (c, next) => {
  const session = await sessionOrThrow(c);
  await csrfGuard(c, session);
  await next();
});

/** Cookie session with the admin role. */
export const requireAdmin: MiddlewareHandler<AppBindings> = createMiddleware(async (c, next) => {
  const session = await sessionOrThrow(c);
  if (!session.roles.includes('admin')) throw new ForbiddenError('Admin access is required.');
  await csrfGuard(c, session);
  await next();
});

export type ScopeSelector = ApiScope | ((c: Context<AppBindings>) => ApiScope);

/** Picks the scope from the HTTP method: reads need `read`, everything else `write`. */
export function methodScope(scopes: { read: ApiScope; write: ApiScope }): ScopeSelector {
  return (c) => (c.req.method === 'GET' || c.req.method === 'HEAD' ? scopes.read : scopes.write);
}

/**
 * Machine API: a bearer API key with the scope, or an admin cookie session. API-key requests are
 * cookie-free and exempt from CSRF. Handlers must still apply org scoping with `assertOrgAccess`.
 */
export function requireApiKeyOrAdmin(scope: ScopeSelector): MiddlewareHandler<AppBindings> {
  return createMiddleware(async (c, next) => {
    const key = bearer(c);
    if (key) {
      const auth = await c.var.stores.apiKeys.resolve(key);
      if (!auth)
        throw new UnauthenticatedError('The API key is invalid or expired.', 'INVALID_API_KEY');
      const needed = typeof scope === 'function' ? scope(c) : scope;
      if (!auth.scopes.includes(needed))
        throw new ForbiddenError(`The API key lacks the ${needed} scope.`, 'MISSING_SCOPE');
      c.set('auth', auth);
      return next();
    }
    const session = await sessionOrThrow(c);
    if (!session.roles.includes('admin')) throw new ForbiddenError('Admin access is required.');
    await csrfGuard(c, session);
    return next();
  });
}

/** Org-scoped API keys may only touch their own org; platform keys and admins may touch any. */
export function assertOrgAccess(auth: AuthContext | undefined, orgId: string): void {
  if (!auth) throw new UnauthenticatedError();
  if (auth.kind === 'api_key' && auth.orgId !== null && auth.orgId !== orgId) {
    throw new ForbiddenError('The API key cannot access this organization.', 'ORG_FORBIDDEN');
  }
}

export function currentUserId(c: Context<AppBindings>): string {
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  return auth.userId;
}
