import { useMemo } from 'react';
import type { EffectiveChannels } from '@/shared/contracts/channels.ts';
import { CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { TEMPLATE_BRAND_COPY } from '@/shared/copy/template-brand.ts';
import type { PassTarget } from '@/shared/pass-view/index.ts';
import { ChannelPreviews } from '../../../channel-previews/channel-previews.tsx';
import type { PreviewChannel, PreviewSource } from '../../../channel-previews/types.ts';
import { useSettings } from '../../settings/queries.ts';
import { useOrgTimeZone } from '../../settings/use-org-time-zone.ts';
import { useTemplateChannels } from '../channels/api.ts';
import type { DraftAsset } from './model.ts';
import { ownParts } from './ops-brand.ts';
import type { PaperPatch } from './ops-paper.ts';
import { useOrgBrand } from './org-brand.ts';
import { PaperPreview } from './paper-preview.tsx';
import { DesignerPreview } from './preview.tsx';

const NO_INPUT = {};

/**
 * The designer's preview stage: every channel from the draft, the card from the dry run and the
 * printed ticket with its layout editor on Paper. Google and Samsung compile the draft's own
 * wallets block in the browser.
 */
export function DesignerStage({
  manifest,
  templateId,
  orgId,
  onPaper,
  target,
  ...card
}: {
  manifest: Record<string, unknown>;
  templateId?: string | undefined;
  orgId?: string | undefined;
  onPaper?: ((patch: PaperPatch) => void) | undefined;
  target?: PassTarget | undefined;
  passJson: Record<string, unknown> | null | undefined;
  assets: readonly DraftAsset[];
  assetBase: string;
  checking: boolean;
  stripUrl?: string | null;
}) {
  const { passJson, assets, assetBase } = card;
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
  const channels = useTemplateChannels(templateId ?? '', orgId ?? '', Boolean(templateId && orgId));
  // The designer edits every channel's design, so what only the template turned off stays open, with
  // a note that follows the Channels and brand tab; what the organization, plan or PassBook withholds
  // has no tab. The paper pane says so itself.
  const effective = useMemo(() => {
    const all = channels.data?.effective;
    if (!all) return undefined;
    return Object.fromEntries(
      Object.entries(all).map(([c, s]) => [c, s.source === 'template' ? { ...s, on: true } : s]),
    ) as EffectiveChannels;
  }, [channels.data]);
  const notes = useMemo(() => {
    const all = channels.data?.effective;
    if (!all) return undefined;
    return Object.fromEntries(
      (Object.keys(all) as (keyof typeof all)[])
        .filter((c) => c !== 'nfc' && c !== 'paper' && !all[c].on && all[c].source === 'template')
        .map((c) => [
          c,
          scanLine(TEMPLATE_BRAND_COPY.designer.channelOff, { channel: CHANNEL_LABEL[c] }),
        ]),
    ) as Partial<Record<PreviewChannel, string>>;
  }, [channels.data]);
  const source = useMemo<PreviewSource | null>(
    () =>
      passJson
        ? {
            passJson,
            assetBaseUrl: assetBase,
            assetNames: assets.map((a) => a.name),
            manifest,
            assets,
            input: (manifest.sample as PreviewSource['input'] | undefined) ?? NO_INPUT,
            ...(typeof website === 'string' && website ? { website } : {}),
            timeZone,
          }
        : null,
    [passJson, assets, assetBase, manifest, website, timeZone],
  );
  return (
    <ChannelPreviews
      source={source}
      channels={effective}
      notes={notes}
      apple={
        <DesignerPreview
          {...card}
          assetOverrides={assetOverrides}
          {...(target ? { target } : {})}
        />
      }
      paper={
        <PaperPreview
          passJson={passJson}
          manifest={manifest}
          templateId={templateId}
          orgId={orgId}
          timeZone={timeZone}
          assets={card.assets}
          assetBase={card.assetBase}
          onEdit={onPaper}
        />
      }
    />
  );
}
