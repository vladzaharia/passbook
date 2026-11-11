import type { SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import type { AssetSessionSnapshot } from './asset-types.ts';

type Predicate = { sql: string; params: SqlValue[] };

export const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** Compare the captured session, not just the session's current tenant authority. */
export function sessionPredicate(
  actor: ScanActor,
  session: AssetSessionSnapshot | null,
  now: number,
): Predicate {
  if (actor.principal !== 'admin') return { sql: session === null ? '1' : '0', params: [] };
  if (
    !session ||
    !nonempty(actor.platformSessionId) ||
    session.user_id !== actor.actor.id ||
    !nonempty(session.user_id) ||
    !nonempty(session.amr) ||
    !nonempty(session.roles) ||
    !Number.isSafeInteger(session.created_at) ||
    !Number.isSafeInteger(session.expires_at) ||
    !(
      (session.membership_id === null && session.membership_roles === null) ||
      (nonempty(session.membership_id) && nonempty(session.membership_roles))
    )
  )
    return { sql: '0', params: [] };
  return {
    sql: `EXISTS (
      SELECT 1 FROM sessions asset_session
      JOIN users asset_user ON asset_user.id=asset_session.user_id AND asset_user.status='active'
      LEFT JOIN org_memberships asset_membership ON asset_membership.user_id=asset_session.user_id
        AND asset_membership.org_id=? AND asset_membership.revoked_at IS NULL
      WHERE asset_session.id_hash=?/* scan-ephemeral-session-id-hash */
        AND asset_session.user_id=?/* scan-ephemeral-asset-session-user-id */
        AND asset_session.amr IS ? AND json(asset_session.roles) IS json(?)
        AND asset_session.created_at IS ? AND asset_session.expires_at IS ?
        AND asset_session.revoked_at IS NULL
        AND asset_session.expires_at>? AND asset_session.idle_expires_at>?
        AND asset_membership.id IS ?/* scan-ephemeral-asset-session-membership-id */
        AND json(asset_membership.roles) IS json(?)
    )`,
    params: [
      actor.orgId,
      actor.platformSessionId,
      session.user_id,
      session.amr,
      session.roles,
      session.created_at,
      session.expires_at,
      now,
      now,
      session.membership_id,
      session.membership_roles,
    ],
  };
}
