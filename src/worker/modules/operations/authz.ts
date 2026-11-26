import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import { scopeExercises } from '../../platform/api-scopes.ts';
import { type AuthContext, assertOrgAccess, isOwnOnly } from '../../platform/auth.ts';
import type { Check } from '../../platform/authority-checks.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireOrgCapability } from '../orgs/access.ts';
import {
  keyScope,
  membershipCapability,
  tenantOrgAccessRevision,
} from '../passes/repo-authority.ts';
import { kindOf } from './kinds.ts';
import type { OperationRow } from './repo.ts';
import { type Fence, orgFence, platformFence, starterFence } from './repo-fence.ts';

/**
 * The fence that lets `auth` read org rows of `capability` in `orgId`, or null. Null is also "no such org":
 * the caller learns nothing either way. The org and mode of the rows come from the actor row in SQL.
 */
export async function orgFenceFor(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  capability: OrgCapability,
): Promise<Fence | null> {
  const now = ctx.clock.now();
  const revision = await tenantOrgAccessRevision(ctx.env.DB, orgId);
  if (revision === null) return null;
  let principal: Principal;
  let checks: Check[];
  if (auth.kind === 'session') {
    try {
      const membership = await requireOrgCapability(ctx, auth.userId, orgId, capability);
      principal = {
        kind: 'membership',
        membershipId: membership.id,
        via: 'session',
        sessionIdHash: auth.sessionId,
        orgAccessRevision: revision,
        mode: auth.mode,
      };
      checks = [membershipCapability(membership.id, capability)];
    } catch (error) {
      if (error instanceof AppError) return null;
      throw error;
    }
  } else if (auth.kind === 'api_key') {
    try {
      assertOrgAccess(auth, orgId);
    } catch (error) {
      if (error instanceof AppError) return null;
      throw error;
    }
    // A key reads with any scope that exercises the kind's capability: its read scope.
    const scope = auth.scopes.find((s) => scopeExercises(s, capability));
    if (!scope) return null;
    principal = {
      kind: 'api_key',
      keyId: auth.keyId,
      scope,
      orgAccessRevision: revision,
      ...(auth.orgId === null ? { orgId } : {}),
    };
    checks = [keyScope(auth.keyId, scope)];
  } else {
    return null;
  }
  return orgFence(principal, checks, now);
}

/** Platform rows: a live admin session. Keys never read them in v1. */
export function platformFenceFor(ctx: ServiceContext, auth: AuthContext): Fence | null {
  if (auth.kind !== 'session' || !auth.roles.includes('admin')) return null;
  return platformFence(
    { kind: 'platform', userId: auth.userId, sessionIdHash: auth.sessionId },
    ctx.clock.now(),
  );
}

/** Starter rows: the person who started them; an own-only session only what its own session started. Never a key. */
export function starterFenceFor(
  ctx: ServiceContext,
  auth: AuthContext,
  writer = false,
): Fence | null {
  return auth.kind === 'session'
    ? starterFence(
        { userId: auth.userId, sessionId: auth.sessionId },
        ctx.clock.now(),
        writer || isOwnOnly(auth),
      )
    : null;
}

/** The fence for reading `row`, by its audience; null when the caller may not. */
export async function readFenceFor(
  ctx: ServiceContext,
  auth: AuthContext,
  row: Pick<OperationRow, 'audience' | 'org_id' | 'kind'>,
  capability: 'read' | 'write' = 'read',
): Promise<Fence | null> {
  if (row.audience === 'starter') return starterFenceFor(ctx, auth, capability === 'write');
  if (isOwnOnly(auth)) return null;
  if (row.audience === 'platform') return platformFenceFor(ctx, auth);
  const needed = kindOf(row.kind)?.[capability] ?? null;
  if (!needed || !row.org_id) return null;
  return orgFenceFor(ctx, auth, row.org_id, needed);
}
