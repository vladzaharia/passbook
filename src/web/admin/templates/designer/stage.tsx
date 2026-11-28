import { lazy, Suspense, useMemo } from 'react';
import {
  CHANNELS,
  type ChannelStatus,
  type EffectiveChannels,
} from '@/shared/contracts/channels.ts';
import { CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { TEMPLATE_BRAND_COPY } from '@/shared/copy/template-brand.ts';
import { WALLETS_COPY } from '@/shared/copy/wallets.ts';
import type { PassTarget } from '@/shared/pass-view/index.ts';
import { ChannelPreviews } from '../../../channel-previews/channel-previews.tsx';
import type { PreviewChannel } from '../../../channel-previews/types.ts';
import { Button } from '../../../ui/button.tsx';
import { Skeleton } from '../../../ui/skeleton.tsx';
import { useOrgTimeZone } from '../../settings/use-org-time-zone.ts';
import { useTemplateChannels } from '../channels/reads.ts';
import { useDesignerMaybe } from './context.tsx';
import { useDesignerHost } from './host.tsx';
import type { DraftAsset } from './model.ts';
import type { PaperPatch } from './ops-paper.ts';
import { DesignerPreview } from './preview.tsx';
import { useStageSource } from './stage-source.ts';

/** Print and the paper editor load when the Paper channel opens. */
const PaperPreview = lazy(() =>
  import('./paper-preview.tsx').then((m) => ({ default: m.PaperPreview })),
);

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
  const { source, assetOverrides } = useStageSource({
    manifest,
    passJson,
    assets,
    assetBase,
    orgId,
  });
  const timeZone = useOrgTimeZone(orgId);
  const peek = useDesignerHost().extras?.Peek;
  const openWallets = useDesignerMaybe()?.openWallets;
  const walletAction = openWallets
    ? (target: 'google' | 'samsung') => (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => openWallets(target)}
        >
          {WALLETS_COPY.report.editInWallets}
        </Button>
      )
    : undefined;
  const channels = useTemplateChannels(templateId ?? '', orgId ?? '', Boolean(templateId && orgId));
  // The designer edits every channel's design, so what only the template turned off stays open, with
  // a note that follows the Channels and brand tab; what the organization, plan or PassBook withholds
  // has no tab. The paper pane says so itself.
  const { unreleased } = useDesignerHost();
  const effective = useMemo(() => {
    const all = channels.data?.effective;
    if (!all && !unreleased?.size) return undefined;
    const held = (c: string): ChannelStatus | undefined =>
      unreleased?.has(c as 'google' | 'samsung')
        ? { on: false, source: 'platform', reason: 'not_released' }
        : undefined;
    const base =
      all ?? Object.fromEntries(CHANNELS.map((c) => [c, { on: true, source: 'platform' }]));
    return Object.fromEntries(
      Object.entries(base).map(([c, s]) => [
        c,
        held(c) ?? (s.source === 'template' ? { ...s, on: true } : s),
      ]),
    ) as EffectiveChannels;
  }, [channels.data, unreleased]);
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
  const previews = (
    <ChannelPreviews
      source={source}
      channels={effective}
      notes={notes}
      walletAction={walletAction}
      apple={
        <DesignerPreview
          {...card}
          assetOverrides={assetOverrides}
          {...(target ? { target } : {})}
        />
      }
      paper={
        <Suspense fallback={<Skeleton className="aspect-[210/297] w-full rounded-xl" />}>
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
        </Suspense>
      }
    />
  );
  if (!peek) return previews;
  const Peek = peek;
  return (
    <div className="relative">
      {previews}
      <Peek source={source} />
    </div>
  );
}
