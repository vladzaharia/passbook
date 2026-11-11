import type { Check } from '../../platform/authority-checks.ts';
import { first } from '../../platform/db.ts';
import { rolesGranting } from '../orgs/access.ts';
import type { BroadcastRow } from './repo.ts';

/**
 * False when the key that created a broadcast is revoked or expired, or the creating user is
 * disabled or no longer holds the roles that let it create the broadcast in its org (messages:manage,
 * plus passes:operate for a broadcast that changes passes). System-made broadcasts (the clearing follow-up) have no creator to check.
 */
export async function creatorIsActive(
  db: D1Database,
  row: Pick<BroadcastRow, 'created_by_type' | 'created_by_id' | 'org_id' | 'kind' | 'created_at'>,
  now: number,
): Promise<boolean> {
  if (!row.created_by_id) return true;
  if (row.created_by_type === 'api_key') {
    const key = await first<{ one: number }>(
      db,
      `SELECT 1 AS one FROM api_keys WHERE id = ? AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
      [row.created_by_id, now],
    );
    return key !== null;
  }
  if (row.created_by_type === 'user') {
    const holds = `EXISTS (SELECT 1 FROM json_each(m.roles) r
         WHERE r.type = 'text' AND r.value IN (SELECT value FROM json_each(?)))`;
    const user = await first<{ one: number }>(
      db,
      `SELECT 1 AS one FROM users u JOIN org_memberships m ON m.user_id = u.id AND m.org_id = ?
       WHERE u.id = ? AND u.status = 'active' AND m.revoked_at IS NULL AND m.created_at <= ? AND ${holds}
         ${row.kind === 'change' ? `AND ${holds}` : ''}`,
      [
        row.org_id,
        row.created_by_id,
        row.created_at,
        JSON.stringify(rolesGranting('messages:manage')),
        ...(row.kind === 'change' ? [JSON.stringify(rolesGranting('passes:operate'))] : []),
      ],
    );
    return user !== null;
  }
  return true;
}

/**
 * The same liveness as `creatorIsActive`, as a grant check over the actor row: the creating user is
 * active and holds a membership of this org that predates the broadcast (re-inviting a revoked creator
 * does not revive their work), or the creating key is live. System-made broadcasts have no creator.
 */
export function creatorLive(
  row: Pick<BroadcastRow, 'created_by_type' | 'created_by_id' | 'created_at' | 'kind'>,
  now: number,
): Check {
  return {
    reason: 'actor',
    ok: (b) => {
      if (!row.created_by_id) return '1 = 1';
      if (row.created_by_type === 'api_key')
        return `EXISTS (SELECT 1 FROM api_keys k WHERE k.id = ${b.bind(row.created_by_id)}
          AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ${b.bind(now)}))`;
      if (row.created_by_type !== 'user') return '1 = 1';
      const holds = (capability: 'messages:manage' | 'passes:operate') =>
        `EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.type = 'text'
          AND r.value IN (SELECT value FROM json_each(${b.bind(JSON.stringify(rolesGranting(capability)))})))`;
      return `EXISTS (SELECT 1 FROM users u JOIN org_memberships m ON m.user_id = u.id AND m.org_id = a.org_id
        WHERE u.id = ${b.bind(row.created_by_id)} AND u.status = 'active' AND m.revoked_at IS NULL
          AND m.created_at <= ${b.bind(row.created_at)} AND ${holds('messages:manage')}
          ${row.kind === 'change' ? `AND ${holds('passes:operate')}` : ''})`;
    },
  };
}
