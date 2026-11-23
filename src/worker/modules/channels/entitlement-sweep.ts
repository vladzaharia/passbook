import { entitlementTransition } from '../../../shared/channels.ts';
import {
  ENTITLEMENT_KEYS,
  type EntitlementKey,
  parseEntitlementValue,
} from '../../../shared/contracts/entitlements.ts';
import { type Entitlements, entitlementsOf } from '../../platform/entitlements.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { onEntitlementsChanged } from './entitlement-apply.ts';
import { passScopes, revisionCovered } from './repo-entitlement-runs.ts';
import { latestEntitlementAudit, recentEntitlementOrgs } from './repo-entitlement-sweep.ts';

const HOUR = 3_600_000;
/** A change younger than this still has its job in flight. */
const GRACE_MS = 120_000;
const SWEEP_LIMIT = 25;

/**
 * Minute hook `entitlements.journal_sweep`. A crash between an entitlement commit and the queue send loses the
 * `channel.entitlement` job (no outbox exists). For orgs changed in the last hour, this rebuilds the newest
 * change from its audit row (before = the audit's `from` values over the live ones) and queues it again when
 * a template with live passes has no run covering the revision. Repeats are safe: the handler skips covered revisions.
 */
export async function sweepEntitlementJournal(ctx: ServiceContext): Promise<void> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  for (const org of await recentEntitlementOrgs(db, now - HOUR, now - GRACE_MS, SWEEP_LIMIT)) {
    const [audit] = await latestEntitlementAudit(db, org.org_id);
    const detail = audit?.detail ? (JSON.parse(audit.detail) as Record<string, unknown>) : null;
    if (detail?.version !== org.revision) continue;
    const changes = (detail.changes ?? {}) as Record<string, { from?: unknown }>;
    const after = await entitlementsOf(ctx, org.org_id);
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
      if (!(await revisionCovered(db, org.org_id, mode, templateId, org.revision))) missing = true;
    if (!missing) continue;
    ctx.log.warn('channels.entitlement_requeued', {
      orgId: org.org_id,
      revision: org.revision,
      code: 'CHANNEL_ENTITLEMENT_REQUEUED',
    });
    await onEntitlementsChanged(ctx, org.org_id, was, after, 'system', org.revision);
  }
}
