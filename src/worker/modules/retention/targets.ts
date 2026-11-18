// Who a multi-class retention job deletes for today: the platform pass, then a bounded batch of orgs whose
// effective days differ in any of the classes. Held or invalid orgs appear in neither.

import type { RetentionClass } from '../../../shared/privacy/data-classes.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { retentionPlan } from './plan.ts';
import { nextBatch } from './policy.ts';

export interface RetentionTargets<C extends RetentionClass> {
  platform: Record<C, number>;
  /** Org ids the platform pass must leave alone. */
  exclude: string[];
  /** Today's batch of orgs with their own days. */
  orgs: { orgId: string; days: Record<C, number> }[];
  /** Moves the rotating cursor past the `visited` orgs that ran. */
  finish(visited: number): Promise<void>;
}

/** Null when a class is blocked (invalid platform value): the job deletes nothing. */
export async function retentionTargets<C extends RetentionClass>(
  ctx: ServiceContext,
  classes: readonly C[],
): Promise<RetentionTargets<C> | null> {
  const plans = await Promise.all(classes.map((cls) => retentionPlan(ctx, cls)));
  const platform = {} as Record<C, number>;
  const skipped = new Set<string>();
  const own = new Map<string, Partial<Record<C, number>>>();
  for (const [i, plan] of plans.entries()) {
    const cls = classes[i] as C;
    if (plan.blocked) return null;
    platform[cls] = plan.platformDays;
    for (const s of plan.skipped) skipped.add(s.orgId);
    for (const o of plan.special) own.set(o.orgId, { ...own.get(o.orgId), [cls]: o.days });
  }
  const ids = [...own.keys()].filter((id) => !skipped.has(id));
  const key = `retention.cursor:${classes.join('+')}`;
  const stored = await readSystemValue(ctx.env.DB, key);
  const next = nextBatch(
    ids.map((orgId) => ({ orgId, days: 0, cutoff: 0 })),
    typeof stored === 'string' ? stored : null,
  );
  return {
    platform,
    exclude: [...ids, ...skipped].sort(),
    orgs: next.batch.map(({ orgId }) => ({
      orgId,
      days: { ...platform, ...own.get(orgId) } as Record<C, number>,
    })),
    finish: async (visited) => {
      const cursor =
        visited === next.batch.length ? next.cursor : (next.batch[visited - 1]?.orgId ?? null);
      await writeSystemValue(ctx.env.DB, key, cursor, ctx.clock.now());
    },
  };
}
