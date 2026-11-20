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

/** An entitlement run of the template was opened at or after `at`: a retried job finds its work done. */
export async function entitlementRunSince(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  at: number,
): Promise<boolean> {
  return (
    (await first(
      db,
      `SELECT 1 FROM channel_apply_runs WHERE org_id = ? AND mode = ? AND template_id = ?
       AND from_blocked IS NOT NULL AND created_at >= ?`,
      [orgId, mode, templateId, at],
    )) !== null
  );
}

export interface EntitlementRun {
  orgId: string;
  mode: Mode;
  templateId: string;
  runId: string;
  /** The channels the plan blocked before the change. */
  blockedBefore: Channel[];
  /** The stored policy and its revision (0: none): the run changes no policy. */
  from: Policy;
  fromRevision: number;
  requestedBy: string;
}

/**
 * Opens the template's apply run for a plan change, or joins the pending one: a pending run that has no
 * plan state yet takes this one. A pending run that already has one keeps it (the oldest before wins).
 */
export async function writeEntitlementRun(ctx: ServiceContext, r: EntitlementRun): Promise<void> {
  const g = jobGrant(ctx, {
    purpose: 'org_mode.job.channels.entitlement',
    job: 'channel-apply',
    orgId: r.orgId,
    mode: r.mode,
    target: r.templateId,
    tables: ['channel_apply_runs'],
  });
  const now = ctx.clock.now();
  const blocked = JSON.stringify(r.blockedBefore);
  g.update('channel_apply_runs', {
    set: { from_blocked: blocked, updated_at: now },
    where: { template_id: r.templateId, state: 'pending', from_blocked: null },
  });
  g.insertSelect(
    'channel_apply_runs',
    [
      'id',
      'template_id',
      'state',
      'from_channels',
      'from_revision',
      'from_blocked',
      'requested_by',
      'due_at',
      'created_at',
      'updated_at',
    ],
    [
      r.runId,
      r.templateId,
      'pending',
      JSON.stringify(r.from),
      r.fromRevision,
      blocked,
      r.requestedBy,
      now,
      now,
      now,
    ],
    { when: [notExists('channel_apply_runs', { template_id: r.templateId, state: 'pending' })] },
  );
  await g.commit();
}
