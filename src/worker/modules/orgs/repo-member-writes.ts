import { grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { withinLimit } from '../../platform/entitlements.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';
import { KEY_GUARD_CODES, keyNotAdministering } from './repo-member-keyguard.ts';

/**
 * Passes only while another active org_admin of the actor's org would remain: the target membership
 * is not the last one. Evaluated inside the grant, before the revoke, in the same transaction.
 */
export function notLastOrgAdmin(membershipId: string): Check {
  return {
    reason: 'config',
    ok: (b) => {
      const id = b.bind(membershipId);
      return `NOT EXISTS (
        SELECT 1 FROM org_memberships t WHERE t.id = ${id} AND t.org_id = a.org_id AND t.revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM json_each(t.roles) ar WHERE ar.type = 'text' AND ar.value = 'org_admin')
          AND NOT EXISTS (SELECT 1 FROM org_memberships o2 JOIN users u2 ON u2.id = o2.user_id
            WHERE o2.org_id = a.org_id AND o2.id != t.id AND o2.revoked_at IS NULL
              AND u2.status = 'active'
              AND EXISTS (SELECT 1 FROM json_each(o2.roles) r2 WHERE r2.type = 'text' AND r2.value = 'org_admin')))`;
    },
  };
}

/** Active members and pending invitations count together against the `members` limit. */
export const membersLimit = (now: number): Check =>
  withinLimit(
    'members',
    `SELECT (SELECT COUNT(*) FROM org_memberships m WHERE m.org_id = {org} AND m.revoked_at IS NULL)
      + (SELECT COUNT(*) FROM org_invitations i WHERE i.org_id = {org} AND i.revoked_at IS NULL
          AND i.accepted_at IS NULL AND i.expires_at > ?)`,
    [now],
  );

export interface NewInvitation {
  id: string;
  email: string;
  roles: string;
  hash: string;
  now: number;
  expires: number;
}

/** `org.member.invite`: the manager's live session (or a platform admin's, or a Live key's) and an active org. */
export async function insertInvitation(
  ctx: ServiceContext,
  principal: Principal,
  checks: Check[],
  row: NewInvitation,
  audit: AuditEntry,
): Promise<void> {
  const g = grant(ctx, {
    purpose: 'org.member.invite',
    principal,
    checks: [...checks, ...keyNotAdministering(principal, { roles: row.roles })],
    target: row.id,
    codes: KEY_GUARD_CODES,
  });
  g.insertSelect(
    'org_invitations',
    ['id', 'email', 'roles', 'token_hash', 'created_at', 'expires_at'],
    [row.id, row.email, row.roles, row.hash, row.now, row.expires],
  );
  g.add(grantedAudit(g, ctx, audit));
  await g.commit();
}

/** True when this call revoked a pending invitation of the actor's org. */
export async function revokePendingInvitation(
  ctx: ServiceContext,
  principal: Principal,
  checks: Check[],
  id: string,
  audit: AuditEntry,
): Promise<boolean> {
  const g = grant(ctx, { purpose: 'org.member.uninvite', principal, checks, target: id });
  g.add(
    grantedAudit(g, ctx, audit, [
      exists('org_invitations', { id, revoked_at: null, accepted_at: null }),
    ]),
  );
  g.update('org_invitations', {
    set: { revoked_at: ctx.clock.now() },
    where: { id, revoked_at: null, accepted_at: null },
    returning: ['id'],
  });
  const result = (await g.commit()).at(-1);
  return (result?.results.length ?? 0) > 0;
}

/**
 * True when this call revoked an active membership of the actor's org. Revoking the last org_admin
 * aborts the batch with `LAST_ORG_ADMIN` (409).
 */
export async function revokeActiveMembership(
  ctx: ServiceContext,
  principal: Principal,
  checks: Check[],
  id: string,
  audit: AuditEntry,
): Promise<boolean> {
  const g = grant(ctx, {
    purpose: 'org.member.revoke',
    principal,
    checks: [
      ...checks,
      ...keyNotAdministering(principal, { table: 'org_memberships', id }),
      notLastOrgAdmin(id),
    ],
    target: id,
    codes: { config: 'LAST_ORG_ADMIN', ...KEY_GUARD_CODES },
  });
  g.add(grantedAudit(g, ctx, audit, [exists('org_memberships', { id, revoked_at: null })]));
  g.update('org_memberships', {
    set: { revoked_at: ctx.clock.now() },
    where: { id, revoked_at: null },
    returning: ['id'],
  });
  const result = (await g.commit()).at(-1);
  return (result?.results.length ?? 0) > 0;
}
