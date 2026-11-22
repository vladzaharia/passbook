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
import type { SignInAmr, SignInLevel } from '../../shared/sign-in.ts';
import {
  authorityUnproven,
  capabilityState,
  proveCapability,
  verifiedScopeOf,
  verifiedScopes,
} from './auth-capability.ts';
import { type KeyCaller, keyCallerOf } from './browser-signals.ts';
import type { AppBindings } from './context.ts';
import { csrfGuard } from './csrf.ts';
import { type DeniedEvent, reportDenied } from './denied.ts';
import { ForbiddenError, UnauthenticatedError } from './errors.ts';
import { enforceFeatures, trackFeatures } from './feature-guard.ts';
import { enforceRateLimit } from './rate-limit.ts';
import {
  isRead,
  neededScope,
  type RouteAuth,
  type ScopeRule,
  sessionKindOf,
} from './route-auth-spec.ts';
import type { ScannerAuth } from './scanner-auth.ts';
import { serviceContext } from './service-context.ts';
import {
  assertConsoleGroup,
  assertDeveloper,
  assertSignIn,
  assertStepUp,
  declareSignIn,
  declareStepUp,
} from './sign-in-guard.ts';

/** Guards the route inventory test recognises; every guard of this file registers itself. */
const knownGuards = new WeakSet<object>();
export const isKnownGuard = (handler: object): boolean => knownGuards.has(handler);

export type Role = z.infer<typeof RoleSchema>;
export type Amr = SignInAmr;
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
  /** An email session still inside the console grace window: when it ends (ms). Null otherwise. */
  consoleUntil?: number | null;
  /** When the sign-in was last proven (ms); null for an email link or a provider that sent no `auth_time`. */
  authTime?: number | null;
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
  /** The key is limited to templates or styles (`api_key_resources`); only a `templateScoped` route admits it. */
  limited?: true;
  /** Presented as a developer try token (`pbtry_`), not the key's secret. */
  via?: 'try';
  /** For a try token: `auth_time` of the session it stands for (null: none recorded), so step-up applies to it. */
  sessionAuthTime?: number | null;
  /** For a try token: how that session signed in, so a break-glass step-up goes to break-glass. */
  sessionAmr?: Amr;
  /** The key's org is a developer org (the sandbox); absent for every other org. */
  orgKind?: 'developer';
}

export { SCANNER_COOKIE, SCANNER_TOKEN, type ScannerAuth } from './scanner-auth.ts';

export type AuthContext = SessionAuth | ApiKeyAuth | ScannerAuth;

/** Implemented by modules/auth. Returns null for unknown, expired, revoked or disabled-user sessions. */
export interface SessionStore {
  resolve(cookieValue: string): Promise<SessionAuth | null>;
}

/** Implemented by modules/api-keys. Hashes the presented key; returns null when invalid. */
export interface ApiKeyStore {
  /** A key limited to templates is refused (403) unless the caller passes `limited: 'ok'`. */
  resolve(
    rawKey: string,
    caller?: KeyCaller,
    options?: { limited?: 'ok' },
  ): Promise<ApiKeyAuth | null>;
}

export type { KeyCaller } from './browser-signals.ts';
/** Every key guard passes this to the key store: the address, browser signals and session cookie (KEY_IN_BROWSER). */
export const keyCaller = (c: Context): KeyCaller => keyCallerOf(c, SESSION_COOKIE);

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
  const session = cookie ? await c.var.stores.sessions.resolve(cookie) : null;
  // A person's browser calls have a budget too; API keys are metered by tier.
  if (session) await enforceRateLimit(c.env, 'RL_SESSION', `session:${session.sessionId}`);
  return session;
}

async function sessionOrThrow(c: Context<AppBindings>, level: SignInLevel): Promise<SessionAuth> {
  const session = c.var.auth?.kind === 'session' ? c.var.auth : await resolveSession(c);
  if (!session) throw new UnauthenticatedError();
  assertSignIn(c, session, level);
  c.set('auth', session);
  return session;
}

const sessionGuard = (level: SignInLevel): MiddlewareHandler<AppBindings> =>
  declareSignIn(
    createMiddleware<AppBindings>(async (c, next) => {
      await csrfGuard(c, await sessionOrThrow(c, level));
      await next();
    }),
    level,
  );

/** Cookie session with a strong sign-in (Polaris ID). State-changing requests also pass the CSRF check. */
export const requireSession = sessionGuard('idp');

/** A strong session with no grace for an email link: minting credentials, sandboxes, joining an org. */
export const requireStrictSession = sessionGuard('strict');

/** Any signed-in session, an email link included: holder features only (my passes, account). */
export const requireHolderSession = sessionGuard('any');

knownGuards.add(requireSession);
knownGuards.add(requireStrictSession);
knownGuards.add(requireHolderSession);

/** `requireSession`, and the admin group where it is required: org console routes that take no scope. */
export const requireConsoleSession: MiddlewareHandler<AppBindings> = declareSignIn(
  createMiddleware<AppBindings>(async (c, next) => {
    const session = await sessionOrThrow(c, 'idp');
    assertConsoleGroup(c, session);
    await csrfGuard(c, session);
    await next();
  }),
  'idp',
);
knownGuards.add(requireConsoleSession);

/** Cookie session with the admin role. */
export const requireAdmin: MiddlewareHandler<AppBindings> = createMiddleware(async (c, next) => {
  const session = await sessionOrThrow(c, 'idp');
  requireAdminRole(c, session);
  c.set('auth', { ...session, mode: modeFromRequest(c) });
  await csrfGuard(c, session);
  await next();
});

declareSignIn(requireAdmin, 'idp');
knownGuards.add(requireAdmin);

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

export type { RouteAuth, ScopeRule } from './route-auth-spec.ts';
export { methodScope } from './route-auth-spec.ts';
export { authorityUnproven, proveCapability, verifiedScopeOf };

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
  const capability = 'scope' in auth ? auth.capability : undefined;
  const feature = 'platform' in auth ? undefined : auth.feature;
  const tillKey = 'scope' in auth && auth.tillKey === true;
  const limited = 'scope' in auth && auth.templateScoped ? ({ limited: 'ok' } as const) : undefined;
  const developer = 'human' in auth && auth.developer === true;
  const sessionKind = sessionKindOf(auth);
  const stepUp = auth.stepUp;
  const level: SignInLevel = 'human' in auth ? (auth.signIn ?? 'idp') : 'idp';
  const guard = createMiddleware<AppBindings>(async (c, next) => {
    const token = rule ? bearer(c) : null;
    if (rule && token) {
      const key = await c.var.stores.apiKeys.resolve(token, keyCaller(c), limited);
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
      if (capability) capabilityState.set(scoped, { capability, proven: false });
      // An org-bound key needs the `api` level (read for GET and HEAD, full for the rest). Exempt: a platform
      // key (on every path alike) and, on a `tillKey` route, scans:write. Door calls use guard-api-key.ts.
      trackFeatures(
        scoped,
        feature,
        key.orgId === null || (tillKey && needed === 'scans:write')
          ? undefined
          : { key: 'api', atLeast: isRead(c) ? 'read' : 'full' },
      );
      c.set('auth', scoped);
      // An org-bound key names its org; a platform key's declared feature is checked per org in tenantAuthorityOf.
      if (key.orgId !== null) await enforceFeatures(serviceContext(c), scoped, key.orgId);
      return next();
    }
    const session = await sessionOrThrow(c, level);
    if (developer) assertDeveloper(c, session);
    if (sessionKind === 'tenant') assertConsoleGroup(c, session);
    if (sessionKind === 'admin') requireAdminRole(c, session);
    // After the role check: a person who could not do this anyway is not sent through a passkey prompt.
    if (stepUp) assertStepUp(c, session, stepUp.maxAgeSec);
    if (sessionKind !== 'plain') {
      const principal = { ...session, mode: modeFromRequest(c) };
      if (capability) capabilityState.set(principal, { capability, proven: false });
      trackFeatures(principal, feature, undefined);
      c.set('auth', principal);
    }
    await csrfGuard(c, session);
    return next();
  });
  knownGuards.add(guard);
  if (stepUp) declareStepUp(guard, { maxAgeSec: stepUp.maxAgeSec, conditional: false });
  return declareSignIn(guard, level);
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
