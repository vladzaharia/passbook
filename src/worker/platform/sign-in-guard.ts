import type { Context, MiddlewareHandler } from 'hono';
import { safeNextPath } from '../../shared/next.ts';
import { canUseConsole, isStrongAmr, type SignInLevel } from '../../shared/sign-in.ts';
import { hasConsoleGroup, hasDeveloperAccess } from '../../shared/spaces.ts';
import type { SessionAuth } from './auth.ts';
import type { AppBindings } from './context.ts';
import { reportDenied } from './denied.ts';
import { ForbiddenError, IdpSignInRequiredError, StepUpRequiredError } from './errors.ts';
import { serviceContext } from './service-context.ts';

// A session guard registers the level it enforces, so the route inventory test and the OpenAPI
// document (`x-sign-in`) read it from one place. Deny by default: an undeclared session guard is `idp`.
const levels = new WeakMap<object, SignInLevel>();

/** Declares the sign-in level a guard enforces. */
export function declareSignIn<T extends object>(guard: T, level: SignInLevel): T {
  levels.set(guard, level);
  return guard;
}

const oidcOnly = new WeakSet<object>();

/** Marks a guard that admits Polaris ID sessions only (no break-glass, no email link), for `x-sign-in: oidc`. */
export function declareOidcOnly<T extends object>(guard: T): T {
  oidcOnly.add(guard);
  return guard;
}
export const isOidcOnly = (guard: object): boolean => oidcOnly.has(guard);

/** The level a guard enforces, or undefined when it is no session guard. */
export const signInLevelOf = (guard: object): SignInLevel | undefined => levels.get(guard);

/** Where a refused caller signs in with Polaris ID: back to the surface they were using. */
function surfaceFor(c: Context<AppBindings>): string {
  const path = c.req.path;
  return path.startsWith('/api/v1/developer')
    ? '/developers'
    : path.startsWith('/api/v1/orgs/invitations') || path.startsWith('/api/v1/invitations')
      ? '/invite'
      : path.startsWith('/api/v1/scan')
        ? '/scan'
        : '/admin';
}

export function signInUrlFor(c: Context<AppBindings>): string {
  return `/auth/oidc/start?next=${surfaceFor(c)}`;
}

/**
 * The one place an email-link session is refused. `any` admits every session; `idp` needs a strong
 * one, or an email one inside its grace window (`consoleUntil`); `strict` needs a strong one, always.
 */
export function assertSignIn(
  c: Context<AppBindings>,
  session: SessionAuth,
  level: SignInLevel,
): void {
  if (level === 'any') return;
  if (
    level === 'strict'
      ? isStrongAmr(session.amr)
      : canUseConsole(session, serviceContext(c).clock.now())
  )
    return;
  reportDenied(c, 'IDP_SIGN_IN_REQUIRED', session);
  throw new IdpSignInRequiredError(signInUrlFor(c));
}

/** `strict` for a handler or router that already holds the session. */
export const assertStrictSignIn = (c: Context<AppBindings>, session: SessionAuth): void =>
  assertSignIn(c, session, 'strict');

/** How recent a sign-in a sensitive action asks for. */
export const STEP_UP_SECONDS = 600;

/** The page the person is on (a same-origin Referer), else the surface the route belongs to. */
function stepUpNext(c: Context<AppBindings>): string {
  const referer = c.req.header('referer');
  if (referer && URL.canParse(referer)) {
    const url = new URL(referer);
    if (url.origin === new URL(c.req.url).origin) {
      const page = safeNextPath(`${url.pathname}${url.search}`);
      if (page) return page;
    }
  }
  return surfaceFor(c);
}

/**
 * A sensitive action needs a recent sign-in: the session's `auth_time` within `maxAgeSec`. A session
 * with no `auth_time` (an email link, or a provider that sent none) is always stale. A try token is its
 * session in a key's clothing, so it carries the session's `auth_time`; other keys never get here.
 */
export function assertStepUp(
  c: Context<AppBindings>,
  session: Pick<SessionAuth, 'authTime' | 'amr'>,
  maxAgeSec: number,
): void {
  const now = serviceContext(c).clock.now();
  if (session.authTime != null && now - session.authTime <= maxAgeSec * 1000) return;
  const next = encodeURIComponent(stepUpNext(c));
  throw new StepUpRequiredError(
    session.amr === 'breakglass'
      ? `/auth/breakglass?next=${next}`
      : `/auth/oidc/start?prompt=login&max_age=0&next=${next}`,
  );
}

/** A route's step-up, as the OpenAPI document and the route inventory read it. */
export interface StepUpDecl {
  maxAgeSec: number;
  /** Asked only for some requests (a body that touches a secret, a sensitive role). */
  conditional: boolean;
}
const stepUps = new WeakMap<object, StepUpDecl>();

/** Declares the step-up a guard enforces, so no sensitive route is invisible to the inventory. */
export function declareStepUp<T extends object>(guard: T, decl: StepUpDecl): T {
  stepUps.set(guard, decl);
  return guard;
}

/** The step-up a guard enforces, or undefined. */
export const stepUpOf = (guard: object): StepUpDecl | undefined => stepUps.get(guard);

/**
 * Step-up for a session, registered per route (`router.post(path, requireStepUp(...))`) ahead of its
 * handler; a key passes untouched, except a developer try token, which asks what its session would. With `when`, only requests it accepts are asked (it may read the body).
 */
export const requireStepUp = (
  maxAgeSec: number,
  when?: (c: Context<AppBindings>) => boolean | Promise<boolean>,
): MiddlewareHandler<AppBindings> =>
  declareStepUp(
    async (c, next) => {
      const auth = c.var.auth;
      const person =
        auth?.kind === 'session'
          ? auth
          : auth?.kind === 'api_key' && auth.via === 'try'
            ? { authTime: auth.sessionAuthTime ?? null, amr: auth.sessionAmr ?? ('oidc' as const) }
            : null;
      if (person && (!when || (await when(c)))) assertStepUp(c, person, maxAgeSec);
      await next();
    },
    { maxAgeSec, conditional: when !== undefined },
  );

/** The JSON body of a request, or undefined when it has none or is malformed (validation reports that). */
export async function peekBody(c: Context<AppBindings>): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * With `OIDC_CONSOLE_GROUP_REQUIRED` on, an org console needs the admin group (`console`) or platform
 * admin. Polaris ID sessions only: an email-link session keeps the console grace rules, and break-glass
 * carries the admin role.
 */
export function assertConsoleGroup(c: Context<AppBindings>, session: SessionAuth): void {
  if (consoleGroupOk(c, session)) return;
  reportDenied(c, 'FORBIDDEN', session);
  throw new ForbiddenError(
    "You don't have console access. Ask an administrator.",
    'CONSOLE_ACCESS_REQUIRED',
  );
}

/** The console group rule: not required, not a Polaris ID session, or the group is held. */
const consoleGroupOk = (c: Context<AppBindings>, session: SessionAuth): boolean =>
  c.env.OIDC_CONSOLE_GROUP_REQUIRED !== 'true' ||
  session.amr !== 'oidc' ||
  hasConsoleGroup(session.roles);

/** Whether the session passes the console checks (`idp` level and the console group), without refusing. */
export function hasConsoleAccess(c: Context<AppBindings>, session: SessionAuth): boolean {
  return canUseConsole(session, serviceContext(c).clock.now()) && consoleGroupOk(c, session);
}

/** `RouteAuth.developer`: the developer role, or a platform admin. */
export function assertDeveloper(c: Context<AppBindings>, session: SessionAuth): void {
  if (hasDeveloperAccess(session.roles)) return;
  reportDenied(c, 'FORBIDDEN', session);
  throw new ForbiddenError(
    "You don't have developer access. Ask an administrator.",
    'DEVELOPER_ACCESS_REQUIRED',
  );
}
