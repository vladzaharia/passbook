import type { Context } from 'hono';
import { type AuthContext, assertOrgAccess } from '../../platform/auth.ts';
import { type AppBindings, actorOf } from '../../platform/context.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { serviceContext } from '../../platform/service-context.ts';
import type { Actor } from './service.ts';

export type C = Context<AppBindings>;

export const svc = serviceContext;

export function authOf(c: C): AuthContext {
  const auth = c.var.auth;
  if (!auth) throw new UnauthenticatedError();
  return auth;
}

/** Org scope for queries: org-scoped API keys are pinned to their org, admins see every org. */
export function orgScopeOf(c: C): string | null {
  const auth = authOf(c);
  return auth.kind === 'api_key' ? auth.orgId : null;
}

export function assertOrg(c: C, orgId: string): void {
  assertOrgAccess(authOf(c), orgId);
}

export function actorFor(c: C): Actor {
  const actor = actorOf(c.var.auth);
  if (actor.type === 'device') return { type: 'system', id: actor.id };
  return { type: actor.type, id: actor.id };
}
