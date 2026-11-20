import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { z } from 'zod';
import {
  ApiScopeSchema,
  MODE_HEADER,
  type Mode,
  type RoleSchema,
} from '../../shared/contracts/common.ts';
import type { OrgCapability } from '../../shared/contracts/org-membership.ts';
import type { PlatformScope } from './api-scopes.ts';
import type { AppBindings } from './context.ts';
import { csrfGuard } from './csrf.ts';
import { type DeniedEvent, reportDenied } from './denied.ts';
import { ForbiddenError, UnauthenticatedError } from './errors.ts';

export type Role = z.infer<typeof RoleSchema>;
export type Amr = 'oidc' | 'magic_link' | 'breakglass';
export const API_SCOPES = ApiScopeSchema.options;
export type ApiScope = z.infer<typeof ApiScopeSchema>;

export const SESSION_COOKIE = '__Host-wallet_sid';

export interface SessionAuth {
  kind: 'session';
  userId: string;
  sessionId: string;
  roles: Role[];
  csrfSecret: string;
  amr: Amr;
  /**
   * Stores resolve 'live'. Admin guards replace it from the x-passbook-mode header; holder routes
   * never read it (holders see all their passes).
   */
  mode: Mode;
}

export interface ApiKeyAuth {
  kind: 'api_key';
  keyId: string;
  /** null = platform-wide key. */
  orgId: string | null;
  scopes: ApiScope[];
  /** From api_keys.mode. */
  mode: Mode;
}

export const SCANNER_COOKIE = '__Host-wallet_scan';
export const SCANNER_TOKEN = /^wls_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/;

/** A paired browser device (cookie) or terminal (bearer). Reaches /api/v1/scan/* only. */
export interface ScannerAuth {
  kind: 'scanner';
  scannerId: string;
  orgId: string;
  mode: Mode;
  transport: 'cookie' | 'bearer';
  /** Cookie transport only. */
  csrfSecret: string | null;
  /** `scanners.kind`: a display never scans, a terminal always does. */
  scannerKind: 'device' | 'terminal' | 'display';
  /** `scanners.device_role`: what the device does now. Only `scan` reaches the scan routes. */
  deviceRole: 'scan' | 'customer' | 'monitor';
}

export type AuthContext = SessionAuth | ApiKeyAuth | ScannerAuth;

/** Implemented by modules/auth. Returns null for unknown, expired, revoked or disabled-user sessions. */
export interface SessionStore {
  resolve(cookieValue: string): Promise<SessionAuth | null>;
}

/** Implemented by modules/api-keys. Hashes the presented key; returns null when invalid. */
export interface ApiKeyStore {
  resolve(rawKey: string): Promise<ApiKeyAuth | null>;
}

/**
 * Implemented by modules/scan. Null for an unknown or malformed token. A known token whose scanner
 * was revoked or has expired throws a 401 with code SCANNER_REVOKED or SCANNER_EXPIRED, so the
 * device can say why. Revoking sets `revoked_at` and keeps the token columns, and expiry is
 * `expires_at` (or idle time), so the token still matches and the reason survives.
 */
export interface ScannerStore {
  resolve(
    token: string,
    transport: 'cookie' | 'bearer',
    meta?: { ipPrefix: string | null },
  ): Promise<ScannerAuth | null>;
}

export interface AuthStores {
  sessions: SessionStore;
  apiKeys: ApiKeyStore;
  scanners: ScannerStore;
  /** Audits a refused principal. Platform never imports a module; stores.ts wires this. */
  onDenied?(event: DeniedEvent): Promise<void> | void;
}

export const denyAllStores: AuthStores = {
  sessions: { resolve: async () => null },
  apiKeys: { resolve: async () => null },
  scanners: { resolve: async () => null },
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
  requireAdminRole(c, session);
  c.set('auth', { ...session, mode: modeFromRequest(c) });
  await csrfGuard(c, session);
  await next();
});

/** The mode an admin session works in. Only the exact value `test` selects test mode. */
export function modeFromRequest(c: Context): Mode {
  return c.req.header(MODE_HEADER)?.trim().toLowerCase() === 'test' ? 'test' : 'live';
}

/** The mode every admin or API list, aggregate and create must apply. */
export function modeOf(auth: AuthContext | undefined): Mode {
  return auth?.mode ?? 'live';
}

function requireAdminRole(c: Context<AppBindings>, session: SessionAuth): void {
  if (session.roles.includes('admin')) return;
  reportDenied(c, 'FORBIDDEN', session);
  throw new ForbiddenError('Admin access is required.');
}

/** Scopes that let a key in: one, any of several, or one for reads (GET, HEAD) and one for the rest. */
export type ScopeRule = ApiScope | readonly ApiScope[] | { read: ApiScope; write: ApiScope };

/** Reads (GET, HEAD) need `read`, everything else `write`. */
export function methodScope(scopes: { read: ApiScope; write: ApiScope }): ScopeRule {
  return scopes;
}

/**
 * Who may call a route. Declared once per route (`RouteSpec.auth`); `requireCaller` enforces it and
 * `openapi-security.ts` writes it into the document, so the two cannot disagree.
 */
export type RouteAuth =
  /**
   * A bearer API key holding the scope, or else a tenant cookie session. `capability` names what
   * the scope exercises; the handler still proves a session's membership for the org it acts on.
   * `session: 'admin'` takes an admin session instead of any tenant session.
   */
  | { scope: ScopeRule; capability?: OrgCapability; session?: 'admin' }
  /** A signed-in person: never a key. `requestMode` adopts the x-passbook-mode header. */
  | { human: true; requestMode?: boolean }
  /** A platform admin session. Keys never pass until a platform key kind exists. */
  | { platform: PlatformScope };

// Only requireCaller tags the scope it verified, so a handler can trust it.
const verifiedScopes = new WeakMap<AuthContext, ApiScope>();

/** The scope `requireCaller` checked on this key principal; undefined for anything else. */
export function verifiedScopeOf(auth: AuthContext): ApiScope | undefined {
  return verifiedScopes.get(auth);
}

const isRead = (c: Context) => c.req.method === 'GET' || c.req.method === 'HEAD';

/** The scope the key must hold, or null when none of several matches. Named scopes give a named refusal. */
function neededScope(rule: ScopeRule, c: Context, held: readonly ApiScope[]): ApiScope | null {
  if (typeof rule === 'string') return rule;
  if (Array.isArray(rule)) return rule.find((candidate) => held.includes(candidate)) ?? null;
  const split = rule as { read: ApiScope; write: ApiScope };
  return isRead(c) ? split.read : split.write;
}

type SessionKind = 'plain' | 'tenant' | 'admin';

function sessionKindOf(auth: RouteAuth): SessionKind {
  if ('platform' in auth) return 'admin';
  if ('human' in auth) return auth.requestMode ? 'tenant' : 'plain';
  return auth.session === 'admin' ? 'admin' : 'tenant';
}

/**
 * The single place a route's `auth` is evaluated.
 *
 * 1. `scope` routes with a Bearer header: the key alone decides, and a cookie is never consulted.
 *    The key must resolve (401 INVALID_API_KEY) and hold the scope (403 MISSING_SCOPE, audited).
 *    The verified scope is tagged on a copy of the principal (`verifiedScopeOf`).
 * 2. Otherwise a cookie session (401 without one) that passes CSRF. `scope` routes take any tenant
 *    session, or an admin one with `session: 'admin'`; `human` routes take any session; `platform`
 *    routes take an admin session. Admin and tenant sessions adopt the request mode.
 * 3. `human` and `platform` routes ignore a Bearer header: a key is never a person.
 */
export function requireCaller(auth: RouteAuth): MiddlewareHandler<AppBindings> {
  const rule = 'scope' in auth ? auth.scope : null;
  const sessionKind = sessionKindOf(auth);
  return createMiddleware(async (c, next) => {
    const token = rule ? bearer(c) : null;
    if (rule && token) {
      const key = await c.var.stores.apiKeys.resolve(token);
      if (!key)
        throw new UnauthenticatedError('The API key is invalid or expired.', 'INVALID_API_KEY');
      const needed = neededScope(rule, c, key.scopes);
      if (!needed || !key.scopes.includes(needed)) {
        reportDenied(c, 'MISSING_SCOPE', key);
        throw new ForbiddenError(
          needed ? `The API key lacks the ${needed} scope.` : 'The API key lacks a required scope.',
          'MISSING_SCOPE',
        );
      }
      const scoped = { ...key };
      // Admin-session routes are not tenant routes: their keys carry no verified scope, so
      // tenantAuthorityOf refuses them, as it always has.
      if (sessionKind !== 'admin') verifiedScopes.set(scoped, needed);
      c.set('auth', scoped);
      return next();
    }
    const session = await sessionOrThrow(c);
    if (sessionKind === 'admin') requireAdminRole(c, session);
    if (sessionKind !== 'plain') c.set('auth', { ...session, mode: modeFromRequest(c) });
    await csrfGuard(c, session);
    return next();
  });
}

/** Machine API: a bearer API key with the scope, or an admin cookie session. */
export function requireApiKeyOrAdmin(scope: ScopeRule): MiddlewareHandler<AppBindings> {
  return requireCaller({ scope, session: 'admin' });
}

/** Org-scoped API keys may only touch their own org; platform keys and admins may touch any. */
export function assertOrgAccess(auth: AuthContext | undefined, orgId: string): void {
  if (!auth) throw new UnauthenticatedError();
  if (auth.kind === 'api_key' && auth.orgId !== null && auth.orgId !== orgId) {
    throw new ForbiddenError('The API key cannot access this organization.', 'ORG_FORBIDDEN');
  }
  if (auth.kind === 'scanner' && auth.orgId !== orgId) {
    throw new ForbiddenError('The scanner cannot access this organization.', 'ORG_FORBIDDEN');
  }
}

export function currentUserId(c: Context<AppBindings>): string {
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  return auth.userId;
}
