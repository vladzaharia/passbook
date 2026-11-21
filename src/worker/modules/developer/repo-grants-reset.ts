import { developerSandboxGrant } from '../../jobs/developer-sandbox.ts';
import { rawCheck } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { STRONG_AMR_SQL } from '../../platform/repo-session-strength-sql.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';

/** Resets a sandbox may claim in a rolling day. */
export const RESETS_PER_DAY = 3;
const DAY_MS = 86_400_000;
export const RESET_ACTION = 'developer_sandbox.reset';

/** The person's live, strong session: the same check every owner action in this file makes. */
const liveSession = (by: { userId: string; sessionIdHash: string }, now: number) =>
  rawCheck(
    'actor',
    `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.user_id = ? AND u.status = 'active' AND s.revoked_at IS NULL
        AND s.expires_at > ? AND s.idle_expires_at > ? AND s.amr IN ${STRONG_AMR_SQL})`,
    [by.sessionIdHash, by.userId, now, now],
  );

/**
 * `platform.job.developer_sandbox.restart`: claims a reset. In one batch it checks the person's live session, an
 * open sandbox of theirs and fewer than `RESETS_PER_DAY` resets in the last day (counted from the audit rows
 * this very batch writes), restarts the quickstart track at `startedAt` and audits it. The funnel's `first_*`
 * columns are never named: they are set once. Nothing is deleted here; the purge that follows repeats the
 * claim's stamp as its guard. False when a check refused or the org was no longer open.
 */
export async function restartTrack(
  ctx: ServiceContext,
  sandbox: { id: string; orgId: string },
  by: { userId: string; sessionIdHash: string },
  startedAt: number,
): Promise<boolean> {
  const { orgId } = sandbox;
  const now = ctx.clock.now();
  const owner = rawCheck(
    'config',
    'EXISTS (SELECT 1 FROM developer_sandboxes d WHERE d.id = ? AND d.user_id = ? AND d.closed_at IS NULL)',
    [sandbox.id, by.userId],
  );
  const room = rawCheck(
    'config',
    `(SELECT count(*) FROM audit_log au WHERE au.target_type = 'org' AND au.target_id = ? AND au.action = ? AND au.at > ?) < ${RESETS_PER_DAY}`,
    [orgId, RESET_ACTION, now - DAY_MS],
  );
  const g = developerSandboxGrant(
    ctx,
    'platform.job.developer_sandbox.restart',
    [liveSession(by, now), owner, room],
    orgId,
  );
  g.update('developer_sandboxes', {
    set: {
      track_started_at: startedAt,
      track_key_call_at: null,
      track_pass_at: null,
      track_change_at: null,
      track_webhook_at: null,
    },
    where: { org_id: orgId, user_id: by.userId, closed_at: null },
    returning: ['id'],
  });
  grantedAudit(g, ctx, {
    orgId,
    actorType: 'user',
    actorId: by.userId,
    action: RESET_ACTION,
    targetType: 'org',
    targetId: orgId,
  });
  const [restarted] = await g.commit();
  return (restarted?.results.length ?? 0) > 0;
}

/**
 * `platform.job.developer_sandbox.reopen`: the owner's own close (its person or the idle sweep, not an
 * administrator's) goes back to active while the org's window is open and no purge has started. The org row
 * and the sandbox record move together; the keys stay revoked (the caller mints a new one). False when it
 * could not.
 */
export async function reopenSandbox(
  ctx: ServiceContext,
  sandbox: { id: string; orgId: string },
  by: { userId: string; sessionIdHash: string },
): Promise<boolean> {
  const { orgId } = sandbox;
  const now = ctx.clock.now();
  const owner = rawCheck(
    'config',
    `EXISTS (SELECT 1 FROM developer_sandboxes d WHERE d.id = ? AND d.user_id = ?
       AND d.closed_at IS NOT NULL AND d.close_reason IN ('user', 'idle'))`,
    [sandbox.id, by.userId],
  );
  const g = developerSandboxGrant(ctx, 'platform.job.developer_sandbox.reopen', [
    liveSession(by, now),
    owner,
  ]);
  g.update('orgs', {
    set: {
      status: 'active',
      closed_identity_id: null,
      closed_at: null,
      purge_after: null,
      updated_at: maxNow(now),
    },
    where: { id: orgId, status: 'deleted', kind: 'developer', purge_started_at: null },
    returning: ['id'],
  });
  g.update('developer_sandboxes', {
    set: { closed_at: null, close_reason: null },
    where: { org_id: orgId, user_id: by.userId },
    when: [exists('orgs', { id: orgId, status: 'active' })],
  });
  grantedAudit(g, ctx, {
    orgId,
    actorType: 'user',
    actorId: by.userId,
    action: 'developer_sandbox.reopen',
    targetType: 'org',
    targetId: orgId,
  });
  const [reopened] = await g.commit();
  return (reopened?.results.length ?? 0) > 0;
}

/**
 * `platform.job.developer_sandbox.reset_rows`: removes the sandbox's captured webhooks. It runs only while the
 * claim of `restartTrack` stands (the sandbox is open, the person's, and its track restarted at `stamp`), and
 * deletes only rows of that org. The endpoint and the hourly counters stay.
 */
export async function deleteCaptures(
  ctx: ServiceContext,
  sandbox: { id: string; orgId: string },
  userId: string,
  stamp: number,
): Promise<number> {
  const claim = rawCheck(
    'config',
    `EXISTS (SELECT 1 FROM developer_sandboxes d
       WHERE d.id = ? AND d.user_id = ? AND d.closed_at IS NULL AND d.track_started_at = ?)`,
    [sandbox.id, userId, stamp],
  );
  const g = developerSandboxGrant(
    ctx,
    'platform.job.developer_sandbox.reset_rows',
    [claim],
    sandbox.orgId,
  );
  g.delete('webhook_captures', { where: { org_id: sandbox.orgId }, returning: ['id'] });
  const [removed] = await g.commit();
  return removed?.results.length ?? 0;
}
