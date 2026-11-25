import { type Check, rawCheck } from '../../platform/authority-checks.ts';
import { first } from '../../platform/db.ts';
import { keyHoldsScope, keyLive, withParams } from '../../platform/repo-api-key-sql.ts';
import { rolesGranting } from '../orgs/access.ts';
import type { BroadcastRow } from './repo.ts';

/** What a creating key must still hold: messages:write, and passes:write to change passes. */
const keyScopes = (kind: BroadcastRow['kind']) =>
  kind === 'change' ? (['messages:write', 'passes:write'] as const) : (['messages:write'] as const);

/**
 * False when the key that created a broadcast is revoked or expired, or the creating user is
 * disabled or no longer holds the roles that let it create the broadcast in its org (messages:manage,
 * plus passes:operate for a broadcast that changes passes). System-made broadcasts (the clearing follow-up) have no creator to check.
 */
export async function creatorIsActive(
  db: D1Database,
  row: Pick<
    BroadcastRow,
    'created_by_type' | 'created_by_id' | 'org_id' | 'mode' | 'kind' | 'created_at'
  >,
  now: number,
): Promise<boolean> {
  if (!row.created_by_id) return true;
  if (row.created_by_type === 'api_key') {
    const live = keyLive('k', now);
    const scopes = keyScopes(row.kind);
    const key = await first<{ one: number }>(
      db,
      `SELECT 1 AS one FROM api_keys k WHERE k.id = ? AND (k.org_id IS NULL OR k.org_id = ?) AND k.mode = ?
         AND ${live.sql}${scopes.map((s) => ` AND ${keyHoldsScope('k', s).sql}`).join('')}`,
      [
        row.created_by_id,
        row.org_id,
        row.mode,
        ...live.params,
        ...scopes.flatMap((s) => keyHoldsScope('k', s).params),
      ],
    );
    return key !== null;
  }
  if (row.created_by_type === 'user') {
    const holds = `EXISTS (SELECT 1 FROM json_each(m.roles) r
         WHERE r.type = 'text' AND r.value IN (SELECT value FROM json_each(?)))`;
    const user = await first<{ one: number }>(
      db,
      `SELECT 1 AS one FROM users u JOIN org_memberships m ON m.user_id = u.id AND m.org_id = ?
       WHERE u.id = ? AND u.status = 'active' AND m.revoked_at IS NULL AND COALESCE(m.joined_at, m.created_at) <= ? AND ${holds}
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
  row: Pick<BroadcastRow, 'created_by_type' | 'created_by_id' | 'created_at' | 'kind' | 'mode'>,
  now: number,
): Check {
  return {
    reason: 'actor',
    ok: (b) => {
      if (!row.created_by_id) return '1 = 1';
      if (row.created_by_type === 'api_key')
        return `EXISTS (SELECT 1 FROM api_keys k WHERE k.id = ${b.bind(row.created_by_id)}
          AND (k.org_id IS NULL OR k.org_id = a.org_id) AND k.mode = ${b.bind(row.mode)}
          AND ${withParams(b.params, keyLive('k', now))}
          ${keyScopes(row.kind)
            .map((s) => `AND ${withParams(b.params, keyHoldsScope('k', s))}`)
            .join(' ')})`;
      if (row.created_by_type !== 'user') return '1 = 1';
      const holds = (capability: 'messages:manage' | 'passes:operate') =>
        `EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.type = 'text'
          AND r.value IN (SELECT value FROM json_each(${b.bind(JSON.stringify(rolesGranting(capability)))})))`;
      return `EXISTS (SELECT 1 FROM users u JOIN org_memberships m ON m.user_id = u.id AND m.org_id = a.org_id
        WHERE u.id = ${b.bind(row.created_by_id)} AND u.status = 'active' AND m.revoked_at IS NULL
          AND COALESCE(m.joined_at, m.created_at) <= ${b.bind(row.created_at)} AND ${holds('messages:manage')}
          ${row.kind === 'change' ? `AND ${holds('passes:operate')}` : ''})`;
    },
  };
}

/**
 * A run's write to a pass is refused once its item is recorded or its write is stamped: a step attempt that outlived a newer one (or a retry after its own write landed) stops
 * instead of computing the change again on the moved pass. Evaluated inside the write.
 */
export const notWrittenYet = (runId: string, passId: string): Check =>
  rawCheck(
    'stale',
    `NOT EXISTS (SELECT 1 FROM broadcast_items WHERE broadcast_id = ? AND pass_id = ?)
     AND NOT EXISTS (SELECT 1 FROM broadcast_targets WHERE broadcast_id = ? AND pass_id = ? AND written_version IS NOT NULL)`,
    [runId, passId, runId, passId],
  );
