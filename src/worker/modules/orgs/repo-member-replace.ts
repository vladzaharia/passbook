import { grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';
import type { NewInvitation } from './repo-member-writes.ts';

/**
 * Invitations and memberships never change once written (roles, token and expiry are immutable), so
 * a resend and a role change each retire the row and write its successor in one batch. The batch
 * aborts when the old row is no longer the one pending (or active) row of the org.
 */
export async function replaceInvitation(
  ctx: ServiceContext,
  principal: Principal,
  checks: Check[],
  oldId: string,
  row: NewInvitation,
  audit: AuditEntry,
): Promise<void> {
  const g = grant(ctx, { purpose: 'org.member.resend', principal, checks, target: oldId });
  g.add(
    grantedAudit(g, ctx, audit, [
      exists('org_invitations', { id: oldId, revoked_at: null, accepted_at: null }),
    ]),
  );
  g.update('org_invitations', {
    set: { revoked_at: row.now },
    where: { id: oldId, revoked_at: null, accepted_at: null },
    require: 'one',
  });
  g.insertSelect(
    'org_invitations',
    ['id', 'email', 'roles', 'token_hash', 'created_at', 'expires_at'],
    [row.id, row.email, row.roles, row.hash, row.now, row.expires],
  );
  await g.commit();
}

export interface RoleChange {
  oldId: string;
  userId: string;
  email: string;
  roles: string;
  membershipId: string;
  invitationId: string;
  hash: string;
  now: number;
}

/**
 * Retires the membership and writes the same person's new one with the new roles, behind an
 * already-accepted invitation (a membership always follows one). Refusing a last-admin loss is the
 * caller's check.
 */
export async function replaceMembership(
  ctx: ServiceContext,
  principal: Principal,
  checks: Check[],
  change: RoleChange,
  audit: AuditEntry,
  codes: { config: string },
): Promise<void> {
  const g = grant(ctx, {
    purpose: 'org.member.roles',
    principal,
    checks,
    target: change.oldId,
    codes,
  });
  g.add(
    grantedAudit(g, ctx, audit, [
      exists('org_memberships', { id: change.oldId, revoked_at: null }),
    ]),
  );
  g.update('org_memberships', {
    set: { revoked_at: change.now },
    where: { id: change.oldId, revoked_at: null },
    require: 'one',
  });
  g.insertSelect(
    'org_invitations',
    ['id', 'email', 'roles', 'token_hash', 'created_at', 'expires_at', 'accepted_at'],
    [
      change.invitationId,
      change.email,
      change.roles,
      change.hash,
      change.now,
      change.now,
      change.now,
    ],
  );
  g.insertSelect(
    'org_memberships',
    ['id', 'user_id', 'invitation_id', 'roles', 'created_at'],
    [change.membershipId, change.userId, change.invitationId, change.roles, change.now],
  );
  await g.commit();
}
