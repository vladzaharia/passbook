/**
 * Sign-in strength. A session is strong when it came through Polaris ID (`oidc`) or break-glass.
 * An email-link (`magic_link`) session is for holder features only. The worker and the SPA share
 * this one definition.
 */
export type SignInAmr = 'oidc' | 'magic_link' | 'breakglass';

export const STRONG_AMR = ['oidc', 'breakglass'] as const;

export const isStrongAmr = (amr: string): boolean =>
  (STRONG_AMR as readonly string[]).includes(amr);

/**
 * What a route needs: a strong session or an email one in its grace window (`idp`), any signed-in
 * one (`any`), or a strong session with no grace (`strict`: credentials, sandboxes, joining an org).
 */
export type SignInLevel = 'idp' | 'any' | 'strict';

/**
 * Whether a session may use the console and developer tools at `now`: strong, or an email session
 * still inside the grace window (`consoleUntil`, from `auth.consoleEmailUntil`).
 */
export function canUseConsole(
  session: { amr: string; consoleUntil?: number | null },
  now: number,
): boolean {
  return isStrongAmr(session.amr) || (session.consoleUntil != null && now < session.consoleUntil);
}

/** How recent a sign-in a sensitive action asks for. */
export const STEP_UP_SECONDS = 600;

/** Whether a sign-in at `authTime` (ms; null when the session has none) is within `maxAgeSec` of `now`. */
export const isRecentSignIn = (
  authTime: number | null | undefined,
  now: number,
  maxAgeSec: number,
): boolean => authTime != null && now - authTime <= maxAgeSec * 1000;
