import type { Context } from 'hono';
import type { OrgCapability } from '../../shared/contracts/org-membership.ts';
import { capabilityState } from './auth-capability.ts';
import type { AuthContext, SessionAuth, WorkbenchPin } from './auth-types.ts';
import type { AppBindings } from './context.ts';
import { NotFoundError } from './errors.ts';
import { workbenchTestOnly } from './errors-denial.ts';
import { type FeatureRule, trackFeatures } from './feature-guard.ts';
import type { StepUp } from './route-auth-spec.ts';
import { assertConsoleGroup, assertStepUp, hasConsoleAccess } from './sign-in-guard.ts';

/** The org a Workbench token pins this principal to, or undefined for every other credential. */
export function workbenchPinOf(auth: AuthContext | undefined): WorkbenchPin | undefined {
  return auth?.kind === 'session' || auth?.kind === 'api_key' ? auth.workbench : undefined;
}

/** True for a request made with a `pbtry_` token of either subject (the sandbox alias included). */
export const viaToken = (auth: AuthContext | undefined): boolean =>
  (auth?.kind === 'session' || auth?.kind === 'api_key') && auth.via === 'try';

/**
 * A pinned principal acting on another org: 404, so the token learns nothing about it. Every org a
 * member token names (query, body, path) and every tenant authority it asks for passes here.
 */
export function assertWorkbenchOrg(auth: AuthContext | undefined, orgId: string | null): void {
  const pin = workbenchPinOf(auth);
  if (pin && orgId !== pin.orgId) throw new NotFoundError();
}

interface Decl {
  sessionKind: 'plain' | 'tenant' | 'admin';
  capability?: OrgCapability;
  feature?: FeatureRule;
  stepUp?: StepUp;
  ownOnlyAdmitted: boolean;
}

/**
 * The session checks of `requireCaller` for a member token (a Test-mode session pinned to one org), which
 * came as a bearer: no cookie and so no CSRF. The org console group still applies, and a step-up asks what
 * the session would. A token is never a platform admin.
 */
export async function admitTokenSession(
  c: Context<AppBindings>,
  session: SessionAuth,
  decl: Decl,
): Promise<void> {
  if (decl.sessionKind === 'admin') throw workbenchTestOnly();
  const consoleAccess = !decl.ownOnlyAdmitted || hasConsoleAccess(c, session);
  if (decl.sessionKind === 'tenant' && consoleAccess) assertConsoleGroup(c, session);
  if (decl.stepUp && (!decl.stepUp.when || (await decl.stepUp.when(c))))
    assertStepUp(c, session, decl.stepUp.maxAgeSec);
  const principal: SessionAuth = { ...session, mode: 'test', consoleAccess };
  if (decl.capability)
    capabilityState.set(principal, { capability: decl.capability, proven: false });
  trackFeatures(principal, decl.feature, undefined);
  c.set('auth', principal);
}
