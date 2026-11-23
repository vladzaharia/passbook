import type { EntitlementValue } from '../../../shared/contracts/entitlements.ts';
import { entitlementImpact } from '../../../shared/entitlement-impact.ts';
import { jobGrant } from '../../platform/authority.ts';
import { inList } from '../../platform/authority-expr.ts';
import { ENTITLEMENT_EXPIRY_PURPOSE } from '../../platform/authority-tables.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { onEntitlementsChanged } from '../channels/entitlement-apply.ts';
import { loadPresetValues } from './presets-service.ts';
import { BATCH, expiredOrgs, storedOverrides } from './repo-entitlement-expiry.ts';
import { orgEntitlementsRow } from './repo-entitlements.ts';
import { parseStored, resolve } from './service-entitlements.ts';

/**
 * Minute hook `entitlements.override_expiry`. An override that expires changes the org's features with no
 * save, so nothing journaled it. This removes the expired overrides and makes a revision for the change in
 * one batch, audited as the system, then queues the same `channel.entitlement` runs a platform save does.
 * Idempotent: the rows are gone after the batch, and a revision that moved under it (a save) skips the org
 * until the next tick, which reads the new state.
 */
export async function expireEntitlementOverrides(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  const orgs = await expiredOrgs(ctx.env.DB, now, BATCH);
  if (orgs.length === 0) return;
  const presets = await loadPresetValues(ctx);
  for (const { org_id: orgId } of orgs) {
    const row = await orgEntitlementsRow(ctx.env.DB, orgId);
    if (!row) continue;
    const stored = await storedOverrides(ctx.env.DB, orgId);
    const every = new Map<string, { value: EntitlementValue }>();
    const standing = new Map<string, { value: EntitlementValue }>();
    const expired: string[] = [];
    for (const o of stored) {
      const value = parseStored(ctx, o.key, o.value);
      if (o.expires_at !== null && o.expires_at <= now) expired.push(o.key);
      if (value === undefined) continue;
      every.set(o.key, { value });
      if (o.expires_at === null || o.expires_at > now) standing.set(o.key, { value });
    }
    const base = presets.get(row.preset) ?? {};
    const was = resolve(base, every);
    const after = resolve(base, standing);
    const impact = entitlementImpact(was, after);
    const revision = row.revision + 1;
    const g = jobGrant(ctx, {
      purpose: ENTITLEMENT_EXPIRY_PURPOSE,
      job: 'entitlement-expiry',
      orgId,
      codes: { lineage: 'ENTITLEMENTS_CHANGED' },
    });
    g.update('org_entitlements', {
      set: { updated_at: now },
      inc: ['revision'],
      where: { revision: row.revision },
      require: 'one',
    });
    g.delete('org_entitlement_overrides', { where: { key: inList(expired) } });
    grantedAudit(g, ctx, {
      actorType: 'system',
      orgId,
      action: 'org.entitlements_update',
      targetType: 'org',
      targetId: orgId,
      detail: {
        via: 'expiry',
        expired,
        changes: Object.fromEntries(
          impact.changes.map((c) => [c.key, { from: c.from ?? null, to: c.to ?? null }]),
        ),
        off: impact.counts.off,
        down: impact.counts.down,
        on: impact.counts.on,
        up: impact.counts.up,
        version: revision,
      },
    });
    try {
      await g.commit();
    } catch (error) {
      if (error instanceof ConflictError && error.code === 'ENTITLEMENTS_CHANGED') {
        ctx.log.info('org.override_expiry_skipped', { orgId, code: 'ENTITLEMENTS_CHANGED' });
        continue;
      }
      throw error;
    }
    await onEntitlementsChanged(ctx, orgId, was, after, 'system', revision);
    ctx.log.info('org.override_expired', { orgId, count: expired.length });
  }
}
