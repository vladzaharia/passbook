import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import type { Actor } from '../../platform/actor.ts';
import type { AuthContext } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AuditEntry } from '../audit/types.ts';
import { orgActorOf } from '../orgs/actor.ts';

/** Who acts on an org's developers: the org actor (`orgActorOf`), kept under its old name. */
export type DevActor = Actor;

/** A session needs `members:manage` (or a platform admin acting on the org); a key must be Live and name `members:write` (or `members:read` for reads). */
export const devActorOf = (
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  capability: Extract<OrgCapability, 'members:read' | 'members:manage'>,
): Promise<DevActor> => orgActorOf(ctx, auth, orgId, capability);

export const auditOf = (
  actor: DevActor,
  orgId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
): AuditEntry => ({
  orgId,
  actorType: actor.actorType,
  actorId: actor.actorId,
  action,
  targetType,
  targetId,
  ...(detail ? { detail } : {}),
});
