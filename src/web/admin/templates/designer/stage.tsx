import { useMemo } from 'react';
import type { EffectiveChannels } from '@/shared/contracts/channels.ts';
import { ChannelPreviews } from '../../../channel-previews/channel-previews.tsx';
import type { PreviewSource } from '../../../channel-previews/types.ts';
import { useTemplateChannels } from '../channels/api.ts';
import type { DraftAsset } from './model.ts';
import type { PaperPatch } from './ops-paper.ts';
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
  ...card
}: {
  manifest: Record<string, unknown>;
  templateId?: string | undefined;
  orgId?: string | undefined;
  onPaper?: ((patch: PaperPatch) => void) | undefined;
  passJson: Record<string, unknown> | null | undefined;
  assets: readonly DraftAsset[];
  assetBase: string;
  checking: boolean;
  stripUrl?: string | null;
}) {
  const { passJson, assets, assetBase } = card;
  const channels = useTemplateChannels(templateId ?? '', orgId ?? '', Boolean(templateId && orgId));
  // The designer edits every channel's design, so what only the template turned off stays open;
  // what the organization or platform withholds is disabled.
  const effective = useMemo(() => {
    const all = channels.data?.effective;
    if (!all) return undefined;
    return Object.fromEntries(
      Object.entries(all).map(([c, s]) => [c, s.source === 'template' ? { ...s, on: true } : s]),
    ) as EffectiveChannels;
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
          }
        : null,
    [passJson, assets, assetBase, manifest],
  );
  return (
    <ChannelPreviews
      source={source}
      channels={effective}
      apple={<DesignerPreview {...card} />}
      paper={
        <PaperPreview
          passJson={passJson}
          manifest={manifest}
          templateId={templateId}
          orgId={orgId}
          assets={card.assets}
          assetBase={card.assetBase}
          onEdit={onPaper}
        />
      }
    />
  );
}
