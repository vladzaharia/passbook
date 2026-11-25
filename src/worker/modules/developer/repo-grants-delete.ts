import { developerSandboxGrant } from '../../jobs/developer-sandbox.ts';
import { rawCheck } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { all } from '../../platform/db.ts';
import { STRONG_AMR_SQL } from '../../platform/repo-session-strength-sql.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';

/** Deletes a person may make in a rolling day. */
export const DELETES_PER_DAY = 3;
export const DELETE_ACTION = 'developer.sandbox_deleted';

/** When the person's deletes in the last day happened, newest first: the audit rows are the count. */
export const deletesSince = async (
  db: D1Database,
  userId: string,
  since: number,
): Promise<number[]> =>
  (
    await all<{ at: number }>(
      db,
      'SELECT at FROM audit_log WHERE actor_id = ? AND action = ? AND at > ? ORDER BY at DESC',
      [userId, DELETE_ACTION, since],
    )
  ).map((r) => r.at);

/**
 * `platform.job.developer_sandbox.delete`: closes the sandbox's org so the org purge takes it from here (purge due
 * now), revokes its keys and drops the person's sandbox record, in one batch. It commits only for the person's live
 * session and their own sandbox. The audit row names the org and the person, never a name or an email.
 */
export async function deleteSandbox(
  ctx: ServiceContext,
  sandbox: { id: string; orgId: string },
  by: { userId: string; sessionIdHash: string },
): Promise<void> {
  const { orgId } = sandbox;
  const now = ctx.clock.now();
  const live = rawCheck(
    'actor',
    `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.user_id = ? AND u.status = 'active' AND s.revoked_at IS NULL
        AND s.expires_at > ? AND s.idle_expires_at > ? AND s.amr IN ${STRONG_AMR_SQL})`,
    [by.sessionIdHash, by.userId, now, now],
  );
  const owner = rawCheck(
    'config',
    'EXISTS (SELECT 1 FROM developer_sandboxes d WHERE d.id = ? AND d.org_id = ? AND d.user_id = ?)',
    [sandbox.id, orgId, by.userId],
  );
  const g = developerSandboxGrant(
    ctx,
    'platform.job.developer_sandbox.delete',
    [live, owner],
    orgId,
  );
  // An open sandbox closes now; one the person closed earlier has its 30-day window cut to now.
  g.update('orgs', {
    set: {
      status: 'deleted',
      default_identity_id: null,
      closed_at: now,
      purge_after: now,
      updated_at: maxNow(now),
    },
    where: { id: orgId, status: 'active', kind: 'developer' },
  });
  g.update('orgs', {
    set: { purge_after: now, updated_at: maxNow(now) },
    where: { id: orgId, status: 'deleted', kind: 'developer', purge_started_at: null },
  });
  g.update('api_keys', { set: { revoked_at: now }, where: { org_id: orgId, revoked_at: null } });
  g.delete('developer_sandboxes', {
    where: { id: sandbox.id, org_id: orgId, user_id: by.userId },
    when: [exists('orgs', { id: orgId, status: 'deleted' })],
  });
  grantedAudit(g, ctx, {
    actorType: 'user',
    actorId: by.userId,
    action: DELETE_ACTION,
    targetType: 'org',
    targetId: orgId,
  });
  await g.commit();
}
