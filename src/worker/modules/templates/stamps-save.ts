import { stampKey } from '../../../passkit/stamps/key.ts';
import { isGoal } from '../../../passkit/stamps/rules.ts';
import type { TemplateManifest } from '../../../passkit/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { StampOptions } from './package/stamps.ts';
import { listVersions } from './repo.ts';
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
): StampOptions | undefined {
  const block = manifest.stamps;
  if (!block || !isGoal(block.goal)) return undefined;
  const sample = [sampleCount(manifest)];
  return {
    ...(dryRun ? { counts: sample } : {}),
    sample,
    carry: async (key) => {
      for (const v of await listVersions(ctx.env.DB, templateId)) {
        const earlier = v.manifest.stamps;
        if (!earlier || !isGoal(earlier.goal)) continue;
        const sha1 = new Map(v.assets.map((a) => [a.name, a.sha1]));
        if ((await stampKey(earlier, (name) => sha1.get(name))) !== key) continue;
        const strips = v.assets.filter((a) => a.stamps !== undefined);
        if (strips.length !== 2 * (earlier.goal + 1)) continue;
        for (const a of strips) carried.set(a.name, { sha1: a.sha1, source: a.source });
        return strips.map(({ source: _source, ...a }) => a);
      }
      return null;
    },
  };
}
