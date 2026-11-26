import { useMemo } from 'react';
import type { PreviewSource } from '../../../channel-previews/types.ts';
import { useSettings } from '../../settings/queries.ts';
import { useOrgTimeZone } from '../../settings/use-org-time-zone.ts';
import { previewAssetMap } from './images.ts';
import type { DraftAsset } from './model.ts';
import { ownParts } from './ops-brand.ts';
import { useOrgBrand } from './org-brand.ts';

const NO_INPUT = {};

/**
 * What the draft's channel previews draw from: the dry run's pass, the draft's manifest and files,
 * the organization's own logo and icon where the manifest follows it, its website (the Samsung app
 * link) and its time zone. The stage and the Wallets tab both compile from this.
 */
export function useStageSource({
  manifest,
  passJson,
  assets,
  assetBase,
  orgId,
}: {
  manifest: Record<string, unknown>;
  passJson: Record<string, unknown> | null | undefined;
  assets: readonly DraftAsset[];
  assetBase: string;
  orgId: string | undefined;
}) {
  const org = useOrgBrand(orgId);
  // Where the manifest follows the organization, its logo and icon draw as a build would use them.
  const assetOverrides = useMemo(() => {
    const own = ownParts({ manifest } as never);
    const out: Record<string, string> = {};
    for (const slot of ['logo', 'icon'] as const) {
      const image = org[slot];
      if (!image || own.includes(slot)) continue;
      for (const suffix of ['', '@2x', '@3x']) out[`${slot}${suffix}.png`] = image.url;
    }
    return out;
  }, [org, manifest]);
  // The Samsung app link is the organization's website when it has one: the preview shows what a pass gets.
  const website = useSettings(`org:${orgId}`, Boolean(orgId)).data?.items.find(
    (i) => i.key === 'org.website',
  )?.value;
  const timeZone = useOrgTimeZone(orgId);
  const source = useMemo<PreviewSource | null>(
    () =>
      passJson
        ? {
            passJson,
            assetBaseUrl: assetBase,
            assetNames: assets.map((a) => a.name),
            // A file added in this draft has no address yet: it reaches a wallet card as a data URL.
            assetUrls: previewAssetMap(assets, assetBase),
            manifest,
            assets,
            input: (manifest.sample as PreviewSource['input'] | undefined) ?? NO_INPUT,
            ...(typeof website === 'string' && website ? { website } : {}),
            timeZone,
          }
        : null,
    [passJson, assets, assetBase, manifest, website, timeZone],
  );
  return { source, assetOverrides };
}
