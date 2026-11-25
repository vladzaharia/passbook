import { all } from '../../../platform/db.ts';
import type { InviteRow } from './repo-resolve.ts';

export interface EndedSetup {
  kind: InviteRow['kind'];
  id: string;
  /** When nothing the invitation made can still be in flight: its window ended and its last token expired. */
  ended: number;
}

/** A signup token is good for an hour; this is the slack for clocks that differ between this Worker and Polaris ID. */
const SKEW = 120_000;
const DAY = 86_400_000;

/**
 * Invitations that minted signup tokens and ended unaccepted (revoked, or past their window) since `after`, oldest
 * first, as of `now`. An invitation counts as ended once its last token has expired too, so an account made from a
 * token of a revoked invitation is still found. Accepted invitations are left alone: their account is proven at accept.
 */
export const endedSetups = (db: D1Database, after: number, now: number, limit: number) =>
  all<EndedSetup>(
    db,
    `SELECT kind, id, ended FROM (
       SELECT 'member' AS kind, i.id,
         MAX(COALESCE(i.revoked_at, i.expires_at + ${DAY}),
             (SELECT MAX(s.expires_at) FROM org_invitation_setups s WHERE s.invitation_id = i.id) + ${SKEW}) AS ended
       FROM org_invitations i
       WHERE i.accepted_at IS NULL AND EXISTS (SELECT 1 FROM org_invitation_setups s WHERE s.invitation_id = i.id)
       UNION ALL
       SELECT 'developer', d.id,
         MAX(COALESCE(d.revoked_at, d.claim_until),
             (SELECT MAX(s.expires_at) FROM developer_invite_setups s WHERE s.invitation_id = d.id) + ${SKEW})
       FROM developer_invitations d
       WHERE d.accepted_at IS NULL AND EXISTS (SELECT 1 FROM developer_invite_setups s WHERE s.invitation_id = d.id)
     ) WHERE ended > ? AND ended <= ? ORDER BY ended, id LIMIT ?`,
    [after, now, limit],
  );
