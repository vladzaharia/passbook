import { stampKey } from '../../../passkit/stamps/key.ts';
import { isGoal } from '../../../passkit/stamps/rules.ts';
import type { AssetEntry, StampsManifest, TemplateManifest } from '../../../passkit/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { sha256BytesHex } from './package/hash.ts';
import type { StampOptions } from './package/stamps.ts';
import { readReleaseAsset } from './release-content.ts';
import { listVersions } from './repo.ts';
import { upstreamReadable } from './repo-fork-updates.ts';
import type { Resolved } from './version-files.ts';

/** The sample's count on the card (0 to goal): the strip the build check and a dry run draw. */
export function sampleCount(manifest: TemplateManifest): number {
  const block = manifest.stamps;
  if (!block || !isGoal(block.goal)) return 0;
  const n = manifest.sample?.[block.input];
  return typeof n === 'number' && Number.isFinite(n)
    ? Math.max(0, Math.min(Math.floor(n), block.goal))
    : 0;
}

/** Whether the earlier version's art and base strips hash to `key` (SHA-256 of their bytes). */
async function sameBytes(
  ctx: ServiceContext,
  earlier: StampsManifest,
  assets: readonly AssetEntry[],
  key: string,
): Promise<boolean> {
  const digests = new Map<string, string>();
  const names = [
    earlier.art.filled,
    earlier.art.empty,
    earlier.art.reward,
    earlier.art.rewardEarned,
    'strip@2x.png',
    'strip@3x.png',
  ];
  for (const name of names) {
    const asset = typeof name === 'string' ? assets.find((a) => a.name === name) : undefined;
    if (asset) digests.set(asset.name, await sha256BytesHex(await readReleaseAsset(ctx, asset)));
  }
  return (await stampKey(earlier, (name) => digests.get(name))) === key;
}

/**
 * Stamp strips for a designer save. A dry run draws the sample only. A version whose key matches an
 * earlier version's carries that version's strips (recorded in `carried`, so no bytes are copied);
 * otherwise the save draws every count.
 */
export function stampsForSave(
  ctx: ServiceContext,
  templateId: string,
  manifest: TemplateManifest,
  dryRun: boolean,
  carried: Resolved['carried'],
  carry = true,
  upstreamId?: string,
): StampOptions | undefined {
  const block = manifest.stamps;
  if (!block || !isGoal(block.goal)) return undefined;
  const sample = [sampleCount(manifest)];
  return {
    ...(dryRun ? { counts: sample } : {}),
    sample,
    carry: carry
      ? async (key, sha1Of) => {
          const first = await stampKey(block, sha1Of);
          const own = await listVersions(ctx.env.DB, templateId);
          // A fork also reuses the strips of an upstream it may read: the merge copies them under the fork.
          const lineage =
            upstreamId && (await upstreamReadable(ctx.env.DB, upstreamId, templateId))
              ? await listVersions(ctx.env.DB, upstreamId)
              : [];
          for (const v of [...own, ...lineage]) {
            const earlier = v.manifest.stamps;
            if (!earlier || !isGoal(earlier.goal)) continue;
            const sha1 = new Map(v.assets.map((a) => [a.name, a.sha1]));
            // Versions store SHA-1s: they find the candidate, the bytes' SHA-256 confirm it.
            if ((await stampKey(earlier, (name) => sha1.get(name))) !== first) continue;
            if (!(await sameBytes(ctx, earlier, v.assets, key))) continue;
            const strips = v.assets.filter((a) => a.stamps !== undefined);
            if (strips.length !== 2 * (earlier.goal + 1)) continue;
            for (const a of strips) carried.set(a.name, { sha1: a.sha1, source: a.source });
            return strips.map(({ source: _source, ...a }) => a);
          }
          return null;
        }
      : undefined,
  };
}
