import { useMemo } from 'react';
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
      channels={channels.data?.effective}
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
