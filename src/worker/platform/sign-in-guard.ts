import type { Context, MiddlewareHandler } from 'hono';
import { safeNextPath } from '../../shared/next.ts';
import { canUseConsole, isStrongAmr, type SignInLevel } from '../../shared/sign-in.ts';
import type { SessionAuth } from './auth.ts';
import type { AppBindings } from './context.ts';
import { reportDenied } from './denied.ts';
import { IdpSignInRequiredError, StepUpRequiredError } from './errors.ts';
import { serviceContext } from './service-context.ts';

// A session guard registers the level it enforces, so the route inventory test and the OpenAPI
// document (`x-sign-in`) read it from one place. Deny by default: an undeclared session guard is `idp`.
const levels = new WeakMap<object, SignInLevel>();

/** Declares the sign-in level a guard enforces. */
export function declareSignIn<T extends object>(guard: T, level: SignInLevel): T {
  levels.set(guard, level);
  return guard;
}

/** The level a guard enforces, or undefined when it is no session guard. */
export const signInLevelOf = (guard: object): SignInLevel | undefined => levels.get(guard);

/** Where a refused caller signs in with Polaris ID: back to the surface they were using. */
function surfaceFor(c: Context<AppBindings>): string {
  const path = c.req.path;
  return path.startsWith('/api/v1/developer')
    ? '/developers'
    : path.startsWith('/api/v1/orgs/invitations')
      ? '/api/v1/orgs/invitations/accept'
      : path.startsWith('/api/v1/scan')
        ? '/scan'
        : '/admin';
}

function signInUrlFor(c: Context<AppBindings>): string {
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
 * with no `auth_time` (an email link, or a provider that sent none) is always stale. Keys never get here.
 */
export function assertStepUp(
  c: Context<AppBindings>,
  session: SessionAuth,
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

/** Router-level step-up for a session; a key passes untouched. */
export const requireStepUp =
  (maxAgeSec: number): MiddlewareHandler<AppBindings> =>
  async (c, next) => {
    const auth = c.var.auth;
    if (auth?.kind === 'session') assertStepUp(c, auth, maxAgeSec);
    await next();
  };
