import type { Context } from 'hono';
import { canUseConsole, isStrongAmr, type SignInLevel } from '../../shared/sign-in.ts';
import { hasConsoleGroup, hasDeveloperAccess } from '../../shared/spaces.ts';
import type { SessionAuth } from './auth.ts';
import type { AppBindings } from './context.ts';
import { reportDenied } from './denied.ts';
import { ForbiddenError, IdpSignInRequiredError } from './errors.ts';
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
function signInUrlFor(c: Context<AppBindings>): string {
  const path = c.req.path;
  const next = path.startsWith('/api/v1/developer')
    ? '/developers'
    : path.startsWith('/api/v1/orgs/invitations')
      ? '/api/v1/orgs/invitations/accept'
      : path.startsWith('/api/v1/scan')
        ? '/scan'
        : '/admin';
  return `/auth/oidc/start?next=${next}`;
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

/**
 * With `OIDC_CONSOLE_GROUP_REQUIRED` on, an org console needs the admin group (`console`) or platform
 * admin. Polaris ID sessions only: an email-link session keeps the console grace rules, and break-glass
 * carries the admin role.
 */
export function assertConsoleGroup(c: Context<AppBindings>, session: SessionAuth): void {
  if (
    c.env.OIDC_CONSOLE_GROUP_REQUIRED !== 'true' ||
    session.amr !== 'oidc' ||
    hasConsoleGroup(session.roles)
  )
    return;
  reportDenied(c, 'FORBIDDEN', session);
  throw new ForbiddenError(
    "You don't have console access. Ask an administrator.",
    'CONSOLE_ACCESS_REQUIRED',
  );
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
