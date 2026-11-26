import { SANDBOX_KEY_NAME } from '../../../shared/copy/developer.ts';
import { developerSandboxGrant } from '../../jobs/developer-sandbox.ts';
import { rawCheck } from '../../platform/authority-checks.ts';
import { condCheck, exists, notExists, tenantSql } from '../../platform/authority-cond.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { STRONG_AMR_SQL } from '../../platform/repo-session-strength-sql.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';

/** Resets a sandbox may claim in a rolling day. */
export const RESETS_PER_DAY = 3;
const DAY_MS = 86_400_000;
export const RESET_ACTION = 'developer_sandbox.reset';
/** Deletes a person may make in a rolling day. */
export const DELETES_PER_DAY = 3;
export const DELETE_ACTION = 'developer_sandbox.delete';

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
 * open sandbox of theirs whose `track_started_at` is still `prevStart` (compare and swap: two resets read the same
 * value, one wins), fewer than `RESETS_PER_DAY` resets in the last day (counted from the audit rows this very
 * batch writes) and no legal hold on the org; it then restarts the quickstart track at `startedAt`, revokes the
 * person's sandbox keys (nothing new is written during the purge that follows) and audits it. The funnel's
 * `first_*` columns are never named: they are set once. Nothing is deleted here; the purge repeats the claim's
 * stamp as its guard. A refused check throws `SANDBOX_CONFLICT`.
 */
export async function restartTrack(
  ctx: ServiceContext,
  sandbox: { id: string; orgId: string },
  by: { userId: string; sessionIdHash: string },
  startedAt: number,
  prevStart: number | null,
): Promise<void> {
  const { orgId } = sandbox;
  const now = ctx.clock.now();
  const owner = rawCheck(
    'config',
    'EXISTS (SELECT 1 FROM developer_sandboxes d WHERE d.id = ? AND d.user_id = ? AND d.closed_at IS NULL AND d.track_started_at IS ?)',
    [sandbox.id, by.userId, prevStart],
  );
  const room = rawCheck(
    'config',
    `(SELECT count(*) FROM audit_log au WHERE au.target_type = 'org' AND au.target_id = ? AND au.action = ? AND au.at > ?) < ${RESETS_PER_DAY}`,
    [orgId, RESET_ACTION, now - DAY_MS],
  );
  const g = developerSandboxGrant(
    ctx,
    'platform.job.developer_sandbox.restart',
    [
      liveSession(by, now),
      owner,
      room,
      condCheck('config', notExists('retention_holds', { org_id: orgId, released_at: null })),
    ],
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
  g.update('api_keys', {
    set: { revoked_at: now },
    where: {
      org_id: orgId,
      created_by: by.userId,
      name: SANDBOX_KEY_NAME,
      kind: 'personal',
      revoked_at: null,
    },
  });
  grantedAudit(g, ctx, {
    orgId,
    actorType: 'user',
    actorId: by.userId,
    action: RESET_ACTION,
    targetType: 'org',
    targetId: orgId,
  });
  await g.commit();
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
): Promise<void> {
  const { orgId } = sandbox;
  const now = ctx.clock.now();
  const owner = rawCheck(
    'config',
    `EXISTS (SELECT 1 FROM developer_sandboxes d WHERE d.id = ? AND d.user_id = ?
       AND d.closed_at IS NOT NULL AND d.close_reason IN ('user', 'idle'))`,
    [sandbox.id, by.userId],
  );
  // The 30-day window, in the write: a window that ended after the service's read refuses the reopen.
  const window = rawCheck(
    'config',
    'EXISTS (SELECT 1 FROM orgs o WHERE o.id = ? AND o.purge_after > ?)',
    [orgId, now],
  );
  const g = developerSandboxGrant(ctx, 'platform.job.developer_sandbox.reopen', [
    liveSession(by, now),
    owner,
    window,
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
  await g.commit();
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
    [
      claim,
      condCheck(
        'config',
        notExists('retention_holds', { org_id: sandbox.orgId, released_at: null }),
      ),
    ],
    sandbox.orgId,
  );
  g.delete('webhook_captures', {
    where: { org_id: sandbox.orgId },
    when: [tenantSql('{row}.created_at <= ?', [stamp])],
    returning: ['id'],
  });
  const [removed] = await g.commit();
  return removed?.results.length ?? 0;
}

export const RESET_KEY_ACTION = 'developer_sandbox.reset_key';
/** A reservation to mint holds this long: a mint that died frees the slot for the next resume. */
const RESERVE_MS = 60_000;

/**
 * `platform.job.developer_sandbox.reset_key`: reserves the right to mint the sandbox's key (once after it is made, and once after each reset). One batch checks the
 * person's live session, an open sandbox whose track still started at `stamp`, and that no reservation for this reset's stamp was made
 * in the last minute, then writes the reservation (an audit row). D1 batches run one at a time, so two racing
 * resumes cannot both pass: the loser throws `SANDBOX_CONFLICT`.
 */
export async function reserveKey(
  ctx: ServiceContext,
  sandbox: { id: string; orgId: string },
  by: { userId: string; sessionIdHash: string },
  /** The sandbox's `track_started_at`: null until its first reset. */
  stamp: number | null,
): Promise<void> {
  const now = ctx.clock.now();
  const claim = rawCheck(
    'config',
    'EXISTS (SELECT 1 FROM developer_sandboxes d WHERE d.id = ? AND d.user_id = ? AND d.closed_at IS NULL AND d.track_started_at IS ?)',
    [sandbox.id, by.userId, stamp],
  );
  const free = rawCheck(
    'config',
    "NOT EXISTS (SELECT 1 FROM audit_log au WHERE au.target_type = 'org' AND au.target_id = ? AND au.action = ? AND au.at > ? AND json_extract(au.detail, '$.stamp') = ?)",
    [sandbox.orgId, RESET_KEY_ACTION, now - RESERVE_MS, stamp ?? 0],
  );
  const g = developerSandboxGrant(
    ctx,
    'platform.job.developer_sandbox.reset_key',
    [liveSession(by, now), claim, free],
    sandbox.orgId,
  );
  grantedAudit(g, ctx, {
    orgId: sandbox.orgId,
    actorType: 'user',
    actorId: by.userId,
    action: RESET_KEY_ACTION,
    targetType: 'org',
    targetId: sandbox.orgId,
    detail: { stamp: stamp ?? 0 },
  });
  await g.commit();
}

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
    'EXISTS (SELECT 1 FROM developer_sandboxes d WHERE d.id = ? AND d.user_id = ?)',
    [sandbox.id, by.userId],
  );
  // The day's limit, in the write: two racing deletes cannot both take the last of the three.
  const room = rawCheck(
    'config',
    '(SELECT COUNT(*) FROM audit_log WHERE actor_id = ? AND action = ? AND at > ?) < ?',
    [by.userId, DELETE_ACTION, now - DAY_MS, DELETES_PER_DAY],
  );
  // No org on the grant, as in reopen: a closed org is not "active", and the owner check names the sandbox.
  const g = developerSandboxGrant(ctx, 'platform.job.developer_sandbox.delete', [
    live,
    owner,
    room,
  ]);
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
