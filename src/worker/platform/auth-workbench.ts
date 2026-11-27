import type { Context } from 'hono';
import type { OrgCapability } from '../../shared/contracts/org-membership.ts';
import { capabilityState } from './auth-capability.ts';
import type { ApiKeyAuth, AuthContext, SessionAuth, WorkbenchPin } from './auth-types.ts';
import { type KeyCaller, TRY_TOKEN_PREFIX } from './browser-signals.ts';
import type { AppBindings } from './context.ts';
import { NotFoundError } from './errors.ts';
import { workbenchTestOnly } from './errors-denial.ts';
import { enforceFeatures, type FeatureRule, trackFeatures } from './feature-guard.ts';
import { ownSandboxOrgId } from './repo-own-sandbox.ts';
import { isRead, type StepUp } from './route-auth-spec.ts';
import { serviceContext } from './service-context.ts';
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
  /** A sandbox's person, in their own sandbox: the console-group exemption, re-checked here (developer, own open sandbox). */
  ownSandbox?: boolean;
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
  // As `sessionOrThrow` does: a step-up's `when` may read the principal.
  c.set('auth', session);
  const consoleAccess = decl.ownSandbox
    ? undefined
    : !decl.ownOnlyAdmitted || hasConsoleAccess(c, session);
  if (decl.ownSandbox && session.workbench) {
    assertConsoleGroup(c, session, {
      orgId: session.workbench.orgId,
      ownSandbox: await ownSandboxOrgId(c.env.DB, session.userId),
    });
  } else if (decl.ownSandbox) throw workbenchTestOnly();
  else if (decl.sessionKind === 'tenant' && consoleAccess) assertConsoleGroup(c, session);
  if (decl.stepUp && (!decl.stepUp.when || (await decl.stepUp.when(c))))
    assertStepUp(c, session, decl.stepUp.maxAgeSec);
  const principal: SessionAuth = { ...session, mode: 'test', consoleAccess };
  if (decl.capability)
    capabilityState.set(principal, { capability: decl.capability, proven: false });
  // The org's `api` plan level applies to a member token as to a key: it is a bearer, used from code.
  trackFeatures(principal, decl.feature, { key: 'api', atLeast: isRead(c) ? 'read' : 'full' });
  c.set('auth', principal);
  if (session.workbench)
    await enforceFeatures(serviceContext(c), principal, session.workbench.orgId);
}

/** A bearer on an `auth` route: a `pbtry_` token through the Workbench store when wired, any other key through `apiKeys`. */
export function resolveBearer(
  c: Context<AppBindings>,
  token: string,
  caller: KeyCaller,
  limited: { limited: 'ok' } | undefined,
): Promise<ApiKeyAuth | SessionAuth | null> {
  const workbench = c.var.stores.workbench;
  return workbench && token.startsWith(TRY_TOKEN_PREFIX)
    ? workbench.resolve(token, caller, limited)
    : c.var.stores.apiKeys.resolve(token, caller, limited);
}
