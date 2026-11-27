import { all, run } from '../../platform/db.ts';
import { madeByLiveKey } from './repo-key-creator.ts';

export type ClaimParent = { org: string } | { developer: string } | { platform: string };

export interface ClaimRow {
  id: string;
  org_invitation_id: string | null;
  developer_invitation_id: string | null;
  platform_invitation_id: string | null;
  subject: string;
  created_at: number;
  claim_until: number;
  swept_at: number | null;
}

const COLUMNS =
  'id, org_invitation_id, developer_invitation_id, platform_invitation_id, subject, created_at, claim_until, swept_at';

export interface NewClaim {
  id: string;
  parent: ClaimParent;
  subject: string;
  now: number;
  claimUntil: number;
}

/**
 * An existing-account claim: the invited mailbox proved, one Polaris ID account found. One per invitation and
 * subject (a second click is a no-op), at most three per invitation. True when a row was written.
 */
export async function insertClaim(db: D1Database, c: NewClaim): Promise<boolean> {
  const org = 'org' in c.parent ? c.parent.org : null;
  const developer = 'developer' in c.parent ? c.parent.developer : null;
  const platform = 'platform' in c.parent ? c.parent.platform : null;
  const result = await run(
    db,
    `INSERT INTO idp_invite_claims (id, org_invitation_id, developer_invitation_id, platform_invitation_id, subject, created_at, claim_until)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [c.id, org, developer, platform, c.subject, c.now, c.claimUntil],
  );
  return result.changes > 0;
}

const parentColumn = (p: ClaimParent) =>
  'org' in p
    ? { column: 'org_invitation_id', id: p.org }
    : 'developer' in p
      ? { column: 'developer_invitation_id', id: p.developer }
      : { column: 'platform_invitation_id', id: p.platform };

export function claimsOfInvitation(db: D1Database, parent: ClaimParent) {
  const { column, id } = parentColumn(parent);
  return all<ClaimRow>(
    db,
    `SELECT ${COLUMNS} FROM idp_invite_claims WHERE ${column} = ? ORDER BY created_at, id`,
    [id],
  );
}

/**
 * Claims the sweep must settle: not swept yet, and the window ended, the invitation expired or was revoked, or it
 * was accepted (the acceptor's reason moves to the membership or sponsorship, and any other subject's claim is no
 * longer a reason: marking each dirty lets the drain keep the one and take back the other). Oldest first.
 */
export const unsettledClaims = (db: D1Database, now: number, limit: number) => {
  const byLive = madeByLiveKey('pi', now);
  return all<ClaimRow>(
    db,
    `SELECT c.id, c.org_invitation_id, c.developer_invitation_id, c.platform_invitation_id, c.subject, c.created_at, c.claim_until, c.swept_at
     FROM idp_invite_claims c
     LEFT JOIN org_invitations oi ON oi.id = c.org_invitation_id
     LEFT JOIN developer_invitations di ON di.id = c.developer_invitation_id
     LEFT JOIN platform_invitations pi ON pi.id = c.platform_invitation_id
     WHERE c.swept_at IS NULL
       AND (c.claim_until <= ? OR oi.expires_at <= ?
         OR COALESCE(oi.revoked_at, di.revoked_at, pi.revoked_at) IS NOT NULL
         OR COALESCE(oi.accepted_at, di.accepted_at, pi.accepted_at) IS NOT NULL
         OR (pi.id IS NOT NULL AND NOT ${byLive.sql}))
     ORDER BY c.claim_until, c.id LIMIT ?`,
    [now, now, ...byLive.params, limit],
  );
};

/** The sweep settled this claim (its provisional grants were removed or the invitation was accepted). Once. */
export async function markClaimSwept(db: D1Database, id: string, now: number): Promise<boolean> {
  return (
    (
      await run(db, 'UPDATE idp_invite_claims SET swept_at = ? WHERE id = ? AND swept_at IS NULL', [
        now,
        id,
      ])
    ).changes > 0
  );
}
