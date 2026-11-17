import { countAfterGoalChange } from '../../../passkit/stamps/rules.ts';
import type { Personalization } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from './builder.ts';
import type { Pass } from './repo.ts';
import { liveVersions } from './repo-ops.ts';

export type KeepReady = (current: Pick<Pass, 'templateVersion' | 'personalization'>) => {
  personalization?: Personalization;
};

const none: KeepReady = () => ({});

/**
 * "Keep their rewards ready": a version saved with `stamps.keepReady` moves the cards that were
 * ready at their own version's goal up by the difference, so they stay ready. Planned once per
 * release; the lookup is sync so it runs inside a publish retry. A pass already on the release
 * is left alone, so a retried page never adds twice.
 */
export async function keepReadyPlan(
  ctx: ServiceContext,
  release: { orgId: string; mode: Mode; templateId: string; version: string },
): Promise<KeepReady> {
  const { orgId, templateId, version } = release;
  const next = (await resolveTemplate(ctx, orgId, templateId, version)).manifest.stamps;
  if (!next?.keepReady) return none;
  const goals = new Map<string, number>();
  for (const v of await liveVersions(ctx.env.DB, release)) {
    if (v === version) continue;
    const goal = (await resolveTemplate(ctx, orgId, templateId, v)).manifest.stamps?.goal;
    if (goal !== undefined) goals.set(v, goal);
  }
  return (current) => {
    const old = goals.get(current.templateVersion);
    const count = current.personalization[next.input];
    if (current.templateVersion === version || old === undefined || typeof count !== 'number')
      return {};
    const raised = countAfterGoalChange(count, old, next.goal, true);
    return raised === count
      ? {}
      : { personalization: { ...current.personalization, [next.input]: raised } };
  };
}
