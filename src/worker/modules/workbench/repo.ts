import { first, run } from '../../platform/db.ts';
import { STRONG_AMR_SQL } from '../../platform/repo-session-strength-sql.ts';

/** A member token's generation for its session: 0 until `DELETE /workbench/token` ends the session's tokens. */
const epochSql = (session: string) =>
  `COALESCE((SELECT e.generation FROM workbench_token_epochs e WHERE e.session_id_hash = ${session}), 0)`;

/** The org a person may mint a token for: an org they hold a live membership in, and their open sandbox. */
export interface MintTarget {
  org_id: string;
  org_kind: string;
  membership_id: string;
  /** The person's open sandbox org, or null: the only developer org a token is minted for. */
  own_sandbox: string | null;
  generation: number;
}

export const mintTargetOf = (
  db: D1Database,
  userId: string,
  orgId: string,
  sessionIdHash: string,
) =>
  first<MintTarget>(
    db,
    `SELECT o.id AS org_id, o.kind AS org_kind, m.id AS membership_id,
       (SELECT d.org_id FROM developer_sandboxes d WHERE d.user_id = m.user_id AND d.closed_at IS NULL) AS own_sandbox,
       ${epochSql('?3')} AS generation
     FROM org_memberships m JOIN orgs o ON o.id = m.org_id AND o.status = 'active'
     JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE m.org_id = ?1 AND m.user_id = ?2 AND m.revoked_at IS NULL`,
    [orgId, userId, sessionIdHash],
  );

/** The session behind a member token, while every binding holds: a live strong session, the same live membership. */
export interface MemberTokenRow {
  user_id: string;
  amr: 'oidc' | 'breakglass';
  roles: string;
  auth_time: number | null;
}

export const memberTokenRow = (
  db: D1Database,
  claims: { orgId: string; membershipId: string; sessionIdHash: string; generation: number },
  now: number,
) =>
  first<MemberTokenRow>(
    db,
    `SELECT s.user_id, s.amr, s.roles, s.auth_time
     FROM sessions s
     JOIN users u ON u.id = s.user_id AND u.status = 'active'
     JOIN org_memberships m ON m.id = ?2 AND m.org_id = ?1 AND m.user_id = s.user_id AND m.revoked_at IS NULL
     JOIN orgs o ON o.id = m.org_id AND o.status = 'active' AND o.kind IS NOT 'developer'
     WHERE s.id_hash = ?3 AND s.revoked_at IS NULL AND s.expires_at > ?5 AND s.idle_expires_at > ?5
       AND s.amr IN ${STRONG_AMR_SQL} AND ${epochSql('s.id_hash')} = ?4`,
    [claims.orgId, claims.membershipId, claims.sessionIdHash, claims.generation, now],
  );

/** Ends every member token of the session: the next mint carries the new generation. */
export const bumpMemberEpoch = (db: D1Database, sessionIdHash: string, now: number) =>
  run(
    db,
    `INSERT INTO workbench_token_epochs (session_id_hash, generation, changed_at) VALUES (?1, 1, ?2)
     ON CONFLICT (session_id_hash) DO UPDATE SET generation = generation + 1, changed_at = excluded.changed_at`,
    [sessionIdHash, now],
  );

/** Daily retention: the epochs of sessions that are gone (the auth purge deleted them). Rows removed. */
export async function purgeOrphanEpochs(db: D1Database): Promise<number> {
  const { changes } = await run(
    db,
    `DELETE FROM workbench_token_epochs WHERE NOT EXISTS
       (SELECT 1 FROM sessions s WHERE s.id_hash = workbench_token_epochs.session_id_hash)`,
  );
  return changes;
}
