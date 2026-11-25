import type { Channel } from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { jobGrant } from '../../platform/authority.ts';
import { notExists } from '../../platform/authority-cond.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Policy } from './repo.ts';

/** The (mode, template) pairs that hold live passes of the org: one apply run each. */
export const passScopes = (
  db: D1Database,
  orgId: string,
): Promise<{ mode: Mode; templateId: string }[]> =>
  all<{ mode: Mode; templateId: string }>(
    db,
    `SELECT DISTINCT mode, template_id AS templateId FROM passes
     WHERE org_id = ? AND deleted_at IS NULL ORDER BY mode, template_id`,
    [orgId],
  );

/**
 * A run of the template already covers entitlement revision `revision` (not failed: a failed run applied
 * only in part): a retried or repeated job finds its work done.
 */
export async function revisionCovered(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  revision: number,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM channel_apply_runs WHERE org_id = ? AND mode = ? AND template_id = ?
       AND state != 'failed' AND from_rev <= ? AND to_rev >= ?`,
      [orgId, mode, templateId, revision, revision],
    )) !== null
  );
}

export interface EntitlementTransition {
  orgId: string;
  mode: Mode;
  templateId: string;
  /** The entitlement revision this change made. */
  revision: number;
  /** The channels the plan blocked before it and after it. */
  blockedBefore: Channel[];
  blockedAfter: Channel[];
  /** A full reconcile: the plan now on both sides, and the run is never dropped. */
  full?: boolean;
  requestedBy: string;
}

/** The pending run of the template with its plan interval, if any. */
export interface PendingPlan {
  id: string;
  fromRev: number | null;
  toRev: number | null;
  fromBlocked: Channel[] | null;
  toBlocked: Channel[] | null;
}

const same = (a: Channel[] | null, b: Channel[]): boolean => a !== null && a.join() === b.join();

export interface NewEntitlementRun {
  runId: string;
  /** The stored policy and its revision (0: none): the run changes no policy. */
  from: Policy;
  fromRevision: number;
}

/**
 * Records the transition on the template's apply run, in one grant, and returns whether it did.
 *   - no pending run: opens one covering this revision;
 *   - a pending template-save run (no interval yet): it takes the transition;
 *   - a pending entitlement run: a later revision that starts where its interval ends extends it; an
 *     earlier one that ends where it starts prepends. Anything else (the state does not join up: a job in
 *     between has not arrived) is left for a retry. A platform write that moved no channel queues no job and
 *     changes no blocked state, so it never breaks the chain.
 */
export async function writeEntitlementTransition(
  ctx: ServiceContext,
  t: EntitlementTransition,
  pending: PendingPlan | null,
  fresh: NewEntitlementRun,
): Promise<boolean> {
  const g = jobGrant(ctx, {
    purpose: 'org_mode.job.channels.entitlement',
    job: 'channel-apply',
    orgId: t.orgId,
    mode: t.mode,
    target: t.templateId,
    tables: ['channel_apply_runs'],
  });
  const now = ctx.clock.now();
  const before = JSON.stringify(t.blockedBefore);
  const after = JSON.stringify(t.blockedAfter);
  const full = t.full === true ? 1 : 0;
  if (pending !== null && t.full) {
    // The reconcile takes over the pending run and covers both intervals; it is never dropped as a no-op.
    g.update('channel_apply_runs', {
      set: {
        reconcile_all: 1,
        // A recorded start (an entitlement run) keeps its known flips; a template-save run has none.
        from_blocked:
          pending.fromRev !== null && pending.fromBlocked !== null
            ? JSON.stringify(pending.fromBlocked)
            : before,
        // An older full job arriving late keeps the newer end the run already has.
        to_blocked:
          pending.toBlocked !== null && (pending.toRev ?? 0) > t.revision
            ? JSON.stringify(pending.toBlocked)
            : after,
        from_rev: Math.min(pending.fromRev ?? t.revision, t.revision),
        to_rev: Math.max(pending.toRev ?? t.revision, t.revision),
        updated_at: now,
      },
      where: { id: pending.id, state: 'pending', from_rev: pending.fromRev, to_rev: pending.toRev },
      require: 'one',
    });
  } else if (pending === null) {
    g.insertSelect(
      'channel_apply_runs',
      [
        'id',
        'template_id',
        'state',
        'from_channels',
        'from_revision',
        'from_blocked',
        'to_blocked',
        'from_rev',
        'to_rev',
        'reconcile_all',
        'requested_by',
        'due_at',
        'created_at',
        'updated_at',
      ],
      [
        fresh.runId,
        t.templateId,
        'pending',
        JSON.stringify(fresh.from),
        fresh.fromRevision,
        before,
        after,
        t.revision,
        t.revision,
        full,
        t.requestedBy,
        now,
        now,
        now,
      ],
      { when: [notExists('channel_apply_runs', { template_id: t.templateId, state: 'pending' })] },
    );
  } else if (pending.fromRev === null || pending.toRev === null) {
    g.update('channel_apply_runs', {
      set: {
        from_blocked: before,
        to_blocked: after,
        from_rev: t.revision,
        to_rev: t.revision,
        updated_at: now,
      },
      where: { id: pending.id, state: 'pending', from_rev: null },
      require: 'one',
    });
  } else if (t.revision > pending.toRev && same(pending.toBlocked, t.blockedBefore)) {
    g.update('channel_apply_runs', {
      set: { to_blocked: after, to_rev: t.revision, updated_at: now },
      where: { id: pending.id, state: 'pending', to_rev: pending.toRev },
      require: 'one',
    });
  } else if (t.revision < pending.fromRev && same(pending.fromBlocked, t.blockedAfter)) {
    g.update('channel_apply_runs', {
      set: { from_blocked: before, from_rev: t.revision, updated_at: now },
      where: { id: pending.id, state: 'pending', from_rev: pending.fromRev },
      require: 'one',
    });
  } else return false;
  await g.commit();
  return true;
}
