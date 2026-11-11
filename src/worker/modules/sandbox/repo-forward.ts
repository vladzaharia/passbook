import { type Grant, grant, jobGrant } from '../../platform/authority.ts';
import { type Check, exactlyOne, rawCheck } from '../../platform/authority-checks.ts';
import { lt } from '../../platform/authority-expr.ts';
import { first } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { bundleChecks } from '../bundles/repo-delivery-fence.ts';
import { passLineageChecks } from '../delivery/delivery-checks.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import type { CaptureSnapshot } from './binding.ts';
import {
  type CapturedRef,
  type CapturedRow,
  type InboxAuthority,
  inboxAuthorityFence,
} from './repo-capture.ts';
import { snapshotFence } from './repo-snapshot-fence.ts';

export type ForwardState = 'sending' | 'sent' | 'failed' | 'unknown' | 'expired';

/** A reservation is live this long; past it the sweeper (or the next reservation) expires it. */
export const FORWARD_LEASE_MS = 10 * 60_000;
/** An unknown outcome blocks the capture's locks this long. */
export const UNKNOWN_FORWARD_MS = 24 * 3_600_000;

/** The latest explicit attempt, or null if the capture/grant is no longer visible. */
export async function forwardingState(
  db: D1Database,
  captureId: string,
  authority: InboxAuthority,
  now: number,
): Promise<Exclude<ForwardState, 'expired'> | 'none' | null> {
  const access = inboxAuthorityFence(authority, 'passes:read', now);
  const row = await first<{ state: ForwardState | 'none' }>(
    db,
    `SELECT COALESCE((SELECT f.state FROM sandbox_forwards f WHERE f.capture_id = c.id
       ORDER BY f.rowid DESC LIMIT 1), 'none') AS state
     FROM captured_emails c WHERE c.id = ? AND ${access.sql}`,
    [captureId, ...access.params],
  );
  const state = row?.state ?? null;
  // The lease is not read here: the next reservation or the sweeper expires it.
  return state === 'expired' ? 'none' : state;
}

/** Stale reservations of one capture (or all of them, for the sweeper) become `expired`. */
function addExpiry(g: Grant, now: number, captureId?: string): void {
  const scope = captureId === undefined ? {} : { capture_id: captureId };
  g.update('sandbox_forwards', {
    set: { state: 'expired', finished_at: now },
    where: { ...scope, state: 'sending', lease_until: lt(now) },
  });
  g.update('sandbox_forwards', {
    set: { state: 'expired', finished_at: now },
    where: { ...scope, state: 'unknown', finished_at: lt(now - UNKNOWN_FORWARD_MS) },
  });
}

/** Sweeper: releases every lock held by a stuck reservation. Needs a queue, cron or workflow ctx. */
export async function expireStaleForwards(ctx: ServiceContext): Promise<void> {
  const g = jobGrant(ctx, { job: 'sandbox', purpose: 'platform.job.sandbox_expire' });
  addExpiry(g, ctx.clock.now());
  await g.commit();
}

/** The capture is the one the caller read, the actor's address is verified, and the snapshot holds. */
function forwardChecks(
  ref: CapturedRef,
  snapshot: CaptureSnapshot,
  userId: string,
  email: string,
): Check[] {
  return [
    exactlyOne('captured_emails', {
      id: ref.id,
      pass_id: ref.pass_id,
      bundle_id: ref.bundle_id,
      recipient: ref.recipient,
      attached: ref.attached,
      intent: ref.intent,
    }),
    rawCheck(
      'actor',
      `EXISTS (SELECT 1 FROM users u JOIN user_emails e ON e.user_id = u.id
        WHERE u.id = ? AND u.status = 'active' AND e.email = ? AND e.verified_at IS NOT NULL)`,
      [userId, email],
    ),
    ...(snapshot.kind === 'pass'
      ? passLineageChecks(snapshot.pass)
      : bundleChecks(snapshot.snapshot)),
  ];
}

/**
 * Reserve the capture and its complete member set in one batch under the actor's session grant:
 * the exact captured message, the verified address and the lineage of every member are checked
 * with the grant, and stale reservations of this capture are expired first. False when another
 * reservation is live or a check refused.
 */
export async function reserveForward(
  ctx: ServiceContext,
  id: string,
  ref: CapturedRef,
  snapshot: CaptureSnapshot,
  authority: InboxAuthority,
  email: string,
): Promise<boolean> {
  // A forged non-session authority must not reach the grant.
  if (authority.kind !== 'session') return false;
  const now = ctx.clock.now();
  const g = grant(ctx, {
    purpose: 'org_mode.sandbox.forward',
    principal: tenantPrincipal(authority),
    checks: [
      ...capabilityChecks(authority),
      ...forwardChecks(ref, snapshot, authority.userId, email),
    ],
    target: ref.id,
  });
  addExpiry(g, now, ref.id);
  const passIds = JSON.stringify(
    snapshot.kind === 'pass' ? [snapshot.pass.id] : snapshot.snapshot.passes.map((pass) => pass.id),
  );
  g.insertSelect(
    'sandbox_forwards',
    [
      'id',
      'capture_id',
      'bundle_id',
      'actor_id',
      'email',
      'intent',
      'pass_ids',
      'state',
      'created_at',
      'lease_until',
    ],
    [
      id,
      ref.id,
      ref.bundle_id,
      authority.userId,
      email,
      ref.intent,
      passIds,
      'sending',
      now,
      now + FORWARD_LEASE_MS,
    ],
    { returning: ['id'] },
  );
  try {
    const results = await g.commit();
    return (results.at(-1)?.results.length ?? 0) === 1;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}

/**
 * Final provider-boundary read. No content is released unless the reservation, exact captured
 * intent, complete snapshot, verified address and session tenant grant all still agree.
 */
export function readForwardContent(
  db: D1Database,
  id: string,
  ref: CapturedRef,
  snapshot: CaptureSnapshot,
  authority: InboxAuthority,
  email: string,
  now: number,
): Promise<CapturedRow | null> {
  const fence = snapshotFence(snapshot);
  const access = inboxAuthorityFence(authority, 'passes:operate', now);
  const passIds = JSON.stringify(
    snapshot.kind === 'pass' ? [snapshot.pass.id] : snapshot.snapshot.passes.map((pass) => pass.id),
  );
  return first<CapturedRow>(
    db,
    `SELECT c.* FROM captured_emails c
     JOIN sandbox_forwards f ON f.capture_id = c.id
     WHERE f.id = ? AND f.state = 'sending' AND f.actor_id = ? AND f.email = ?
       AND f.org_id = c.org_id AND f.bundle_id IS c.bundle_id AND f.intent = c.intent
       AND f.pass_ids = ?
       AND (SELECT count(*) FROM sandbox_forward_passes fp WHERE fp.forward_id = f.id)
         = json_array_length(f.pass_ids)
       AND NOT EXISTS (SELECT 1 FROM json_each(f.pass_ids) j WHERE NOT EXISTS (
         SELECT 1 FROM sandbox_forward_passes fp WHERE fp.forward_id = f.id AND fp.pass_id = j.value))
       AND c.id = ? AND c.org_id = ? AND c.pass_id IS ? AND c.bundle_id IS ?
       AND c.recipient = ? AND c.attached = ? AND c.intent = ?
       AND EXISTS (SELECT 1 FROM users u JOIN user_emails e ON e.user_id = u.id
         WHERE u.id = ? AND u.status = 'active' AND e.email = ? AND e.verified_at IS NOT NULL)
       AND ${fence.sql} AND ${access.sql}`,
    [
      id,
      authority.userId,
      email,
      passIds,
      ref.id,
      ref.org_id,
      ref.pass_id,
      ref.bundle_id,
      ref.recipient,
      ref.attached,
      ref.intent,
      authority.userId,
      email,
      ...fence.params,
      ...access.params,
    ],
  );
}

/** The user's `access_revision`, captured before the send so a disable during it cancels the settlement. */
export async function userRevisionOf(db: D1Database, userId: string): Promise<number> {
  return (
    (
      await first<{ r: number }>(db, 'SELECT access_revision AS r FROM users WHERE id = ?', [
        userId,
      ])
    )?.r ?? 0
  );
}

/**
 * The owner of a reservation settles it even after signing out: the deferred membership principal
 * (live membership and user, the org revision the request captured) replaces the session. A refusal
 * is logged; the reservation then expires with its lease. Unknown is never retried.
 */
export async function finishForward(
  ctx: ServiceContext,
  id: string,
  authority: InboxAuthority,
  state: 'sent' | 'failed' | 'unknown',
  userAccessRevision: number,
): Promise<boolean> {
  const g = grant(ctx, {
    purpose: 'org_mode.sandbox.forward_finish',
    principal: {
      kind: 'membership',
      membershipId: authority.membershipId,
      via: 'deferred',
      orgAccessRevision: authority.orgUpdatedAt,
      userAccessRevision,
      allowRequestContext: true,
      mode: authority.mode,
    },
    target: id,
  });
  g.update('sandbox_forwards', {
    set: { state, finished_at: ctx.clock.now() },
    where: { id, state: 'sending' },
    returning: ['id'],
  });
  try {
    const [result] = await g.commit();
    return (result?.results.length ?? 0) === 1;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('sandbox.forward_finish_refused', {
      code: 'TEST_FORWARD_FINISH',
      reason: error.code,
    });
    return false;
  }
}
