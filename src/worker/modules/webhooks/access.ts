import type { Mode } from '../../../shared/contracts/common.ts';
import { type AuthContext, assertOrgAccess, modeOf } from '../../platform/auth.ts';
import { assertWorkbenchOrg, workbenchPinOf } from '../../platform/auth-workbench.ts';
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { rolesGranting } from '../orgs/access.ts';
import { activeMembership } from '../orgs/repo-members.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { locateEndpoint } from './repo-endpoints.ts';

export type WebhookCapability = 'integrations:read' | 'integrations:manage';

/** A verified tenant authority, and whether the caller may see the full endpoint URL. */
export interface WebhookAccess {
  authority: TenantPassWrite;
  canManage: boolean;
}

/**
 * Sessions need `integrations:read` or `integrations:manage` through their membership. Keys need the
 * `webhooks:manage` scope the route guard verified, never `connections:*`. Either mode is allowed.
 */
export async function authorizeWebhooks(
  sctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string,
  capability: WebhookCapability,
): Promise<WebhookAccess> {
  if (!auth) throw new UnauthenticatedError();
  if (auth.kind === 'scanner') throw new ForbiddenError();
  assertOrgAccess(auth, orgId);
  const authority = await tenantAuthorityOf(sctx, auth, orgId, capability);
  const canManage =
    authority.kind === 'api_key' ||
    capability === 'integrations:manage' ||
    authority.roles.some((role) => rolesGranting('integrations:manage').includes(role));
  return { authority, canManage };
}

/** Lists and creates name an org; only an org-bound key may omit it. */
export function webhookOrg(auth: AuthContext | undefined, requested: string | undefined): string {
  const pin = workbenchPinOf(auth);
  if (pin) {
    if (requested !== undefined) assertWorkbenchOrg(auth, requested);
    return pin.orgId;
  }
  if (auth?.kind === 'api_key' && auth.orgId !== null) {
    if (requested !== undefined) assertOrgAccess(auth, requested);
    return auth.orgId;
  }
  if (requested === undefined)
    throw new ValidationError('Invalid request.', [
      { path: 'orgId', message: 'Required', code: 'invalid_type' },
    ]);
  return requested;
}

const notFound = () =>
  new NotFoundError('Webhook endpoint not found.', 'WEBHOOK_ENDPOINT_NOT_FOUND');

/**
 * By-id routes: the endpoint's own org and mode decide. A caller with no access to that org, or in
 * the other mode, learns nothing about it: 404, not 403.
 */
export async function authorizeStoredEndpoint(
  sctx: ServiceContext,
  auth: AuthContext | undefined,
  endpointId: string,
  capability: WebhookCapability,
): Promise<WebhookAccess> {
  if (!auth) throw new UnauthenticatedError();
  const stored = await locateEndpoint(sctx.env.DB, endpointId);
  if (!stored || stored.mode !== modeOf(auth)) throw notFound();
  try {
    return await authorizeWebhooks(sctx, auth, stored.orgId, capability);
  } catch (error) {
    if (
      error instanceof ForbiddenError &&
      ((auth.kind === 'session' &&
        !(await activeMembership(sctx.env.DB, auth.userId, stored.orgId))) ||
        (auth.kind === 'api_key' && auth.orgId !== null && auth.orgId !== stored.orgId))
    )
      throw notFound();
    throw error;
  }
}

export const fenceOf = (a: WebhookAccess): { orgId: string; mode: Mode } => ({
  orgId: a.authority.orgId,
  mode: a.authority.mode,
});

/** The feed reads what `passes:read` already reads per pass: that capability or key scope, either mode. */
export async function authorizeFeed(
  sctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string,
): Promise<WebhookAccess> {
  if (!auth) throw new UnauthenticatedError();
  if (auth.kind === 'scanner') throw new ForbiddenError();
  assertOrgAccess(auth, orgId);
  return { authority: await tenantAuthorityOf(sctx, auth, orgId, 'passes:read'), canManage: false };
}
