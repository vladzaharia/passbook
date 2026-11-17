import { countAfterGoalChange, keptGoalOf, withKeptGoal } from '../../../passkit/stamps/rules.ts';
import type { Personalization, StampsManifest } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from './builder.ts';
import type { FieldSources, Pass } from './repo-map.ts';
import { liveVersions } from './repo-ops.ts';
import { stampsView } from './stamps-view.ts';

export type StampMove = (
  current: Pick<Pass, 'templateVersion' | 'personalization' | 'fieldSources'>,
) => { personalization?: Personalization; fieldSources?: FieldSources };

const none: StampMove = () => ({});

/**
 * What moving a card to template version `target.version` does to its stamps; one plan for every
 * path that moves a pass to another version (release reissue, PATCH, transfer).
 *
 * "Keep their rewards ready": a version saved with `stamps.keepReady` tops a ready card up by how
 * far the goal grew beyond the highest goal the card was ever topped up to. That goal is recorded
 * on the pass, so a rollback and a second release add nothing, and a rollback never takes stamps
 * away. A card above the new version's maximum fails with STAMPS_ABOVE_MAX; stamps are never
 * dropped. Each card is read with its own version's input; the lookup is sync so it runs inside a
 * publish retry. A pass already on the target is left alone.
 */
export async function stampMovePlan(
  ctx: ServiceContext,
  target: { orgId: string; templateId: string; version: string },
  from: readonly string[],
): Promise<StampMove> {
  const { orgId, templateId, version } = target;
  const resolved = (await resolveTemplate(ctx, orgId, templateId, version)).manifest;
  const next = resolved.stamps;
  if (!next) return none;
  const maximum = stampsView(resolved, {})?.maximum;
  const olds = new Map<string, StampsManifest>();
  for (const v of new Set(from)) {
    if (v === version) continue;
    const old = (await resolveTemplate(ctx, orgId, templateId, v)).manifest.stamps;
    if (old) olds.set(v, old);
  }
  return (current) => {
    const old = olds.get(current.templateVersion);
    if (current.templateVersion === version || !old) return {};
    const read = current.personalization[old.input];
    const count = typeof read === 'number' ? read : 0;
    const kept = keptGoalOf(current.fieldSources);
    const raised = countAfterGoalChange(count, old.goal, next.goal, next.keepReady === true, kept);
    if (maximum !== undefined && raised > maximum)
      throw new ConflictError(
        `The card has ${raised} stamps; this version allows ${maximum}. Raise the maximum or redeem first.`,
        'STAMPS_ABOVE_MAX',
      );
    if (raised === count) return {};
    return {
      personalization: { ...current.personalization, [next.input]: raised },
      fieldSources: withKeptGoal(current.fieldSources, next.goal, 'manual' as const),
    };
  };
}

/** The plan for a release: every version the scope's live cards sit on. */
export async function releaseMovePlan(
  ctx: ServiceContext,
  release: { orgId: string; mode: Mode; templateId: string; version: string },
): Promise<StampMove> {
  return stampMovePlan(ctx, release, await liveVersions(ctx.env.DB, release));
}
