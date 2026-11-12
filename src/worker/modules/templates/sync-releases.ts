import type { Grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { BakedTemplate } from './baked-types.ts';
import {
  APPLE_ADAPTER_CAPABILITIES,
  APPLE_ADAPTER_REVISION,
  AUDIENCE_POLICY_REVISION,
  candidateHash,
} from './release-content.ts';
import { bakedHeadGeneration } from './repo-grant-checks.ts';
import { eventIdsForRelease, invalidateEventCache } from './repo-release-effects.ts';
import {
  addBakedRelease,
  type BakedSystemRelease,
  bakedHeadOf,
  wantsBakedRelease,
} from './repo-sync-release.ts';

export type Step = (g: Grant) => void;

/** One grant's checks and the writes that follow them. */
export interface Unit {
  checks: Check[];
  steps: Step[];
}

export interface PlannedReleases {
  checks: Check[];
  steps: Step[];
}

/**
 * The system releases one baked template needs in each mode: only where the scope's head differs from
 * the build, guarded by the head generation this sync read (a racing sync is refused, then re-read).
 */
export async function planBakedReleases(
  ctx: ServiceContext,
  input: {
    template: BakedTemplate;
    orgId: string | null;
    contentHash: string;
    replaceHead: boolean;
    allowLegacyBackfill: boolean;
    now: number;
  },
): Promise<PlannedReleases> {
  const { template: t, orgId, contentHash, now } = input;
  const db = ctx.env.DB;
  const planned: PlannedReleases = { checks: [], steps: [] };
  for (const mode of ['live', 'test'] as const) {
    const snapshot = {
      templateId: t.id,
      orgId,
      mode,
      provider: 'apple' as const,
      version: t.version,
      contentHash,
      adapterRevision: APPLE_ADAPTER_REVISION,
      adapterCapabilities: APPLE_ADAPTER_CAPABILITIES,
      audiencePolicyRevision: AUDIENCE_POLICY_REVISION,
      authorId: null,
      versionAuthorId: null,
      createdAt: now,
    };
    const release: BakedSystemRelease = {
      id: ctx.ids.id(),
      templateId: t.id,
      orgId,
      mode,
      version: t.version,
      contentHash,
      candidateHash: await candidateHash(snapshot),
      adapterRevision: APPLE_ADAPTER_REVISION,
      adapterCapabilities: APPLE_ADAPTER_CAPABILITIES,
      audiencePolicyRevision: AUDIENCE_POLICY_REVISION,
      replaceExistingHead: input.replaceHead,
      allowLegacyBackfill: input.allowLegacyBackfill,
      createdAt: now,
    };
    const head = await bakedHeadOf(db, t.id, orgId, mode);
    if (!wantsBakedRelease(head, release)) continue;
    const eventIds = await eventIdsForRelease(db, t.id, mode, orgId);
    planned.checks.push(bakedHeadGeneration(t.id, orgId, mode, head?.generation ?? 0));
    planned.steps.push((g) => {
      addBakedRelease(g, ctx, release, head);
      invalidateEventCache(g, eventIds, mode);
    });
  }
  return planned;
}
