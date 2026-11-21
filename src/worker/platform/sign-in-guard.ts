import type { Context } from 'hono';
import { canUseConsole, isStrongAmr, type SignInLevel } from '../../shared/sign-in.ts';
import type { SessionAuth } from './auth.ts';
import type { AppBindings } from './context.ts';
import { reportDenied } from './denied.ts';
import { IdpSignInRequiredError } from './errors.ts';
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
