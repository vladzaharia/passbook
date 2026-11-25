import { grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';

export type GroupSource = 'signup' | 'added' | 'existing';
export type EndReason = 'removed' | 'org_closed';

export interface SponsorRow {
  id: string;
  org_id: string;
  user_id: string;
  invitation_id: string;
  idp_subject: string;
  group_source: GroupSource;
  created_at: number;
  ended_at: number | null;
  end_reason: EndReason | null;
  settled_at: number | null;
}

const COLUMNS = `id, org_id, user_id, invitation_id, idp_subject, group_source, created_at, ended_at,
  end_reason, settled_at`;

export const orgSponsors = (db: D1Database, orgId: string) =>
  all<SponsorRow>(
    db,
    `SELECT ${COLUMNS} FROM developer_sponsors WHERE org_id = ? ORDER BY created_at, id`,
    [orgId],
  );

export const liveSponsorOf = (db: D1Database, orgId: string, userId: string) =>
  first<SponsorRow>(
    db,
    `SELECT ${COLUMNS} FROM developer_sponsors WHERE org_id = ? AND user_id = ? AND ended_at IS NULL`,
    [orgId, userId],
  );

/** Live sponsorships of a person across orgs: the group stays while any remains. */
export const liveSponsorsOfUser = (db: D1Database, userId: string) =>
  all<SponsorRow>(
    db,
    `SELECT ${COLUMNS} FROM developer_sponsors WHERE user_id = ? AND ended_at IS NULL ORDER BY created_at, id`,
    [userId],
  );

/** Live sponsorships of the org, for the `members.developers` limit. */
export async function liveSponsorCount(db: D1Database, orgId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM developer_sponsors WHERE org_id = ? AND ended_at IS NULL',
    [orgId],
  );
  return row?.n ?? 0;
}

/** Ended sponsorships whose group removal and session revoke have not been settled yet. */
export const unsettled = (db: D1Database, limit: number) =>
  all<SponsorRow>(
    db,
    `SELECT ${COLUMNS} FROM developer_sponsors
     WHERE ended_at IS NOT NULL AND settled_at IS NULL ORDER BY ended_at, id LIMIT ?`,
    [limit],
  );

export interface NewSponsor {
  id: string;
  userId: string;
  invitationId: string;
  subject: string;
  source: GroupSource;
  now: number;
}

/** `org.developer.sponsor`: one live sponsorship per person and org; a second is refused by its index. */
export async function insertSponsor(
  ctx: ServiceContext,
  principal: Principal,
  checks: Check[],
  row: NewSponsor,
  audit: AuditEntry,
): Promise<void> {
  const g = grant(ctx, { purpose: 'org.developer.sponsor', principal, checks, target: row.id });
  g.insertSelect(
    'developer_sponsors',
    ['id', 'user_id', 'invitation_id', 'idp_subject', 'group_source', 'created_at'],
    [row.id, row.userId, row.invitationId, row.subject, row.source, row.now],
  );
  g.add(grantedAudit(g, ctx, audit));
  await g.commit();
}

/** True when this call ended a live sponsorship of the actor's org. */
export async function endSponsor(
  ctx: ServiceContext,
  principal: Principal,
  checks: Check[],
  id: string,
  reason: EndReason,
  audit: AuditEntry,
): Promise<boolean> {
  const g = grant(ctx, { purpose: 'org.developer.remove', principal, checks, target: id });
  g.add(grantedAudit(g, ctx, audit, [exists('developer_sponsors', { id, ended_at: null })]));
  g.update('developer_sponsors', {
    set: { ended_at: ctx.clock.now(), end_reason: reason },
    where: { id, ended_at: null },
    returning: ['id'],
  });
  const result = (await g.commit()).at(-1);
  return (result?.results.length ?? 0) > 0;
}
