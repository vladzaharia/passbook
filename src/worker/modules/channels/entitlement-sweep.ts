import { entitlementTransition } from '../../../shared/channels.ts';
import {
  ENTITLEMENT_KEYS,
  type EntitlementKey,
  parseEntitlementValue,
} from '../../../shared/contracts/entitlements.ts';
import { countQueries } from '../../jobs/query-counter.ts';
import { type Entitlements, entitlementsOf } from '../../platform/entitlements.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { presetRows } from '../orgs/repo-entitlements.ts';
import { onEntitlementsChanged } from './entitlement-apply.ts';
import { passScopes } from './repo-entitlement-runs.ts';
import {
  jobArrived,
  latestEntitlementAudit,
  recentEntitlementOrgs,
  type SweepCursor,
} from './repo-entitlement-sweep.ts';

/** Each change is checked for this long after its grace, then left alone. */
const WINDOW_MS = 600_000;
/** A change younger than this still has its job in flight. */
const GRACE_MS = 120_000;
const SWEEP_LIMIT = 200;
/** The minute hooks share one invocation's 1,000 D1 queries: this hook stops starting orgs past this many. */
export const SWEEP_QUERY_CAP = 200;

/** Where the last capped tick stopped; the next tick within the window carries on from it. */
let resume: { cursor: SweepCursor; at: number } | null = null;

/** Forgets where the last capped tick stopped (tests share the isolate). */
export const resetSweepCursor = (): void => {
  resume = null;
};

/**
 * Minute hook `entitlements.journal_sweep`. A crash between an entitlement commit and the queue send loses the
 * `channel.entitlement` job (no outbox exists). For orgs changed in a ten-minute window after the grace, this
 * rebuilds the newest change from its audit row (before = the audit's `from` values over the live ones) and
 * queues it again when a template with live passes has no run, in any state, covering the revision. Healthy
 * changes drop out in SQL. Repeats are safe: the handler skips covered revisions.
 */
export async function sweepEntitlementJournal(
  ctx: ServiceContext,
  queryCap = SWEEP_QUERY_CAP,
): Promise<void> {
  const counter = countQueries(ctx.env);
  const counted: ServiceContext = { ...ctx, env: counter.env };
  const db = counter.env.DB;
  const now = ctx.clock.now();
  const metas = await presetRows(db);
  const cursor = resume && now - resume.at < WINDOW_MS ? resume.cursor : null;
  resume = null;
  const orgs = await recentEntitlementOrgs(
    db,
    now - GRACE_MS - WINDOW_MS,
    now - GRACE_MS,
    SWEEP_LIMIT,
    now,
    cursor,
  );
  for (const [i, org] of orgs.entries()) {
    if (counter.count() >= queryCap) {
      const last = orgs[i - 1] ?? null;
      if (last) resume = { cursor: { updatedAt: last.updated_at, orgId: last.org_id }, at: now };
      ctx.log.warn('channels.entitlement_sweep_capped', {
        code: 'CRON_BUDGET',
        queries: counter.count(),
        left: orgs.length - i,
      });
      break;
    }
    // An org an edit has not moved yet is journaled by the write that is coming (it queues its own job).
    const meta = metas.find((m) => m.preset === org.preset);
    if (meta && org.preset_revision < meta.revision) continue;
    const [audit] = await latestEntitlementAudit(db, org.org_id);
    const detail = audit?.detail ? (JSON.parse(audit.detail) as Record<string, unknown>) : null;
    if (detail?.version !== org.revision) continue;
    const changes = (detail.changes ?? {}) as Record<string, { from?: unknown }>;
    const after = await entitlementsOf(counted, org.org_id);
    const was: Entitlements = { ...after };
    for (const key of ENTITLEMENT_KEYS) {
      const change = changes[key];
      if (!change) continue;
      const value = parseEntitlementValue(key as EntitlementKey, change.from);
      if (value === undefined) delete was[key];
      else was[key] = value;
    }
    if (entitlementTransition(was, after).length === 0) continue;
    let missing = false;
    for (const { mode, templateId } of await passScopes(db, org.org_id))
      if (!(await jobArrived(db, org.org_id, mode, templateId, org.revision))) missing = true;
    if (!missing) continue;
    ctx.log.warn('channels.entitlement_requeued', {
      orgId: org.org_id,
      revision: org.revision,
      code: 'CHANNEL_ENTITLEMENT_REQUEUED',
    });
    await onEntitlementsChanged(
      counted,
      org.org_id,
      was,
      after,
      'system',
      org.revision,
      detail.gap === true,
    );
  }
}
