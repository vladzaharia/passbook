import { grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';

export interface DeveloperInvitationRow {
  id: string;
  org_id: string;
  email: string;
  org_invitation_id: string | null;
  created_by_user: string | null;
  created_by_key: string | null;
  created_at: number;
  expires_at: number;
  claim_until: number;
  revoked_at: number | null;
  accepted_at: number | null;
  accepted_user_id: string | null;
  swept_at: number | null;
}

export interface SetupRow {
  idp_token_id: string;
  invitation_id: string;
  created_at: number;
  expires_at: number;
}

const COLUMNS = `id, org_id, email, org_invitation_id, created_by_user, created_by_key, created_at,
  expires_at, claim_until, revoked_at, accepted_at, accepted_user_id, swept_at`;

export const invitationByHash = (db: D1Database, hash: string) =>
  first<DeveloperInvitationRow>(
    db,
    `SELECT ${COLUMNS} FROM developer_invitations WHERE token_hash = ?`,
    [hash],
  );

export const orgInvitations = (db: D1Database, orgId: string) =>
  all<DeveloperInvitationRow>(
    db,
    `SELECT ${COLUMNS} FROM developer_invitations WHERE org_id = ? ORDER BY created_at, id`,
    [orgId],
  );

/** The address's live invitation in this org: not revoked, not accepted, not expired. */
export const pendingForEmail = (db: D1Database, orgId: string, email: string, now: number) =>
  first<DeveloperInvitationRow>(
    db,
    `SELECT ${COLUMNS} FROM developer_invitations
     WHERE org_id = ? AND email = ? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > ?`,
    [orgId, email, now],
  );

/** Pending invitations of the org, for the `members.developers` limit. */
export async function pendingCount(db: D1Database, orgId: string, now: number): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM developer_invitations
     WHERE org_id = ? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > ?`,
    [orgId, now],
  );
  return row?.n ?? 0;
}

export const setupsOf = (db: D1Database, invitationId: string) =>
  all<SetupRow>(
    db,
    `SELECT idp_token_id, invitation_id, created_at, expires_at FROM developer_invite_setups
     WHERE invitation_id = ? ORDER BY created_at, idp_token_id`,
    [invitationId],
  );

/** Invitations past their claim window that no one accepted and no sweep has closed yet. */
export const unclaimedPast = (db: D1Database, now: number, limit: number) =>
  all<DeveloperInvitationRow>(
    db,
    `SELECT ${COLUMNS} FROM developer_invitations
     WHERE claim_until < ? AND accepted_at IS NULL AND swept_at IS NULL ORDER BY claim_until, id LIMIT ?`,
    [now, limit],
  );

export interface NewDeveloperInvitation {
  id: string;
  email: string;
  hash: string;
  createdByUser: string | null;
  createdByKey: string | null;
  now: number;
  expires: number;
  /** The paired org invitation: it makes the membership when the person accepts. */
  org: { id: string; roles: string; hash: string };
}

/**
 * `org.developer.invite`: the invitation and its paired org invitation in one batch, so neither exists
 * alone. The grant's org is the manager's; `checks` carry the caps and the entitlement.
 */
export async function insertDeveloperInvitation(
  ctx: ServiceContext,
  principal: Principal,
  checks: Check[],
  row: NewDeveloperInvitation,
  audit: AuditEntry,
): Promise<void> {
  const g = grant(ctx, { purpose: 'org.developer.invite', principal, checks, target: row.id });
  g.insertSelect(
    'org_invitations',
    ['id', 'email', 'roles', 'token_hash', 'created_at', 'expires_at'],
    [row.org.id, row.email, row.org.roles, row.org.hash, row.now, row.expires],
  );
  g.insertSelect(
    'developer_invitations',
    [
      'id',
      'email',
      'token_hash',
      'org_invitation_id',
      'created_by_user',
      'created_by_key',
      'created_at',
      'expires_at',
      'claim_until',
    ],
    [
      row.id,
      row.email,
      row.hash,
      row.org.id,
      row.createdByUser,
      row.createdByKey,
      row.now,
      row.expires,
      row.expires,
    ],
  );
  g.add(grantedAudit(g, ctx, audit));
  await g.commit();
}

/** True when this call revoked a pending invitation and its paired org invitation. */
export async function revokeDeveloperInvitation(
  ctx: ServiceContext,
  principal: Principal,
  checks: Check[],
  inv: { id: string; orgInvitationId: string | null },
  audit: AuditEntry,
): Promise<boolean> {
  const { id } = inv;
  const g = grant(ctx, { purpose: 'org.developer.uninvite', principal, checks, target: id });
  g.add(
    grantedAudit(g, ctx, audit, [
      exists('developer_invitations', { id, revoked_at: null, accepted_at: null }),
    ]),
  );
  const now = ctx.clock.now();
  if (inv.orgInvitationId)
    g.update('org_invitations', {
      set: { revoked_at: now },
      where: { id: inv.orgInvitationId, revoked_at: null, accepted_at: null },
    });
  g.update('developer_invitations', {
    set: { revoked_at: now },
    where: { id, revoked_at: null, accepted_at: null },
    returning: ['id'],
  });
  const result = (await g.commit()).at(-1);
  return (result?.results.length ?? 0) > 0;
}

export interface NewSetup {
  idpTokenId: string;
  invitationId: string;
  now: number;
  expires: number;
  /** Never earlier than the invitation's current window (a trigger refuses a decrease). */
  claimUntil: number;
}

/** `org.developer.setup`: records a signup token id for the invitation and moves the claim window; the trigger caps it at three. */
export async function insertSetup(
  ctx: ServiceContext,
  principal: Principal,
  checks: Check[],
  row: NewSetup,
  audit: AuditEntry,
): Promise<void> {
  const g = grant(ctx, {
    purpose: 'org.developer.setup',
    principal,
    checks,
    target: row.invitationId,
  });
  g.insertJoined('developer_invite_setups', {
    parents: { invitation_id: row.invitationId },
    columns: ['idp_token_id', 'created_at', 'expires_at'],
    values: [row.idpTokenId, row.now, row.expires],
  });
  g.update('developer_invitations', {
    set: { claim_until: row.claimUntil },
    where: { id: row.invitationId, accepted_at: null, revoked_at: null },
  });
  g.add(grantedAudit(g, ctx, audit));
  await g.commit();
}
