import { all } from '../../../platform/db.ts';
import type { InviteRow } from './repo-resolve.ts';

/** Where a sweep stopped: the last item settled, by its time and a key that breaks ties. */
export interface Cursor {
  at: number;
  key: string;
}

export interface EndedSetup {
  kind: InviteRow['kind'] | 'platform';
  id: string;
  /** When nothing the invitation made can still be in flight: its window ended and its last token expired. */
  ended: number;
}

export interface ExpiredToken {
  token_id: string;
  email: string;
  due: number;
  kind: InviteRow['kind'] | 'platform';
  invitation_id: string;
}

/** A signup token is good for an hour; this is the slack for clocks that differ between this Worker and Polaris ID. */
const SKEW = 120_000;
const DAY = 86_400_000;

/**
 * Invitations that minted signup tokens and ended (revoked, accepted, or past their window) after the cursor, oldest
 * first, as of `now`. An invitation counts as ended once its last token has expired too, so an account made from a
 * token of a revoked or accepted invitation is still found. The cursor is (ended, kind, id): invitations that tie on
 * the time are settled one by one and none is skipped.
 */
export const endedSetups = (db: D1Database, after: Cursor, now: number, limit: number) =>
  all<EndedSetup>(
    db,
    `SELECT kind, id, ended FROM (
       SELECT 'member' AS kind, i.id,
         MAX(COALESCE(i.accepted_at, i.revoked_at, i.expires_at + ${DAY}),
             (SELECT MAX(s.expires_at) FROM org_invitation_setups s WHERE s.invitation_id = i.id) + ${SKEW}) AS ended
       FROM org_invitations i
       WHERE EXISTS (SELECT 1 FROM org_invitation_setups s WHERE s.invitation_id = i.id)
       UNION ALL
       SELECT 'developer', d.id,
         MAX(COALESCE(d.accepted_at, d.revoked_at, d.claim_until),
             (SELECT MAX(s.expires_at) FROM developer_invite_setups s WHERE s.invitation_id = d.id) + ${SKEW})
       FROM developer_invitations d
       WHERE EXISTS (SELECT 1 FROM developer_invite_setups s WHERE s.invitation_id = d.id)
       UNION ALL
       SELECT 'platform', p.id,
         MAX(COALESCE(p.accepted_at, p.revoked_at, p.claim_until),
             (SELECT MAX(s.expires_at) FROM platform_invitation_setups s WHERE s.invitation_id = p.id) + ${SKEW})
       FROM platform_invitations p
       WHERE EXISTS (SELECT 1 FROM platform_invitation_setups s WHERE s.invitation_id = p.id)
     ) WHERE (ended > ? OR (ended = ? AND kind || ':' || id > ?)) AND ended <= ?
     ORDER BY ended, kind, id LIMIT ?`,
    [after.at, after.at, after.key, now, limit],
  );

/**
 * Signup tokens that expired (with the slack) after the cursor, oldest first, with the address of their invitation:
 * an account made from one with another address can never accept, so it is settled now, not at the window's end.
 */
export const expiredTokens = (db: D1Database, after: Cursor, now: number, limit: number) =>
  all<ExpiredToken>(
    db,
    `SELECT token_id, email, due, kind, invitation_id FROM (
       SELECT s.idp_token_id AS token_id, i.email, s.expires_at + ${SKEW} AS due, 'member' AS kind, i.id AS invitation_id
       FROM org_invitation_setups s JOIN org_invitations i ON i.id = s.invitation_id
       UNION ALL
       SELECT s.idp_token_id, d.email, s.expires_at + ${SKEW}, 'developer', d.id
       FROM developer_invite_setups s JOIN developer_invitations d ON d.id = s.invitation_id
       UNION ALL
       SELECT s.idp_token_id, p.email, s.expires_at + ${SKEW}, 'platform', p.id
       FROM platform_invitation_setups s JOIN platform_invitations p ON p.id = s.invitation_id
     ) WHERE (due > ? OR (due = ? AND token_id > ?)) AND due <= ?
     ORDER BY due, token_id LIMIT ?`,
    [after.at, after.at, after.key, now, limit],
  );
