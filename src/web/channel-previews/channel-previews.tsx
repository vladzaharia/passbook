import { type ReactNode, useState } from 'react';
import type { EffectiveChannels } from '@/shared/contracts/channels.ts';
import { CHANNEL_COPY, channelReason } from '@/shared/copy/channels.ts';
import { PREVIEW_COPY, PREVIEW_LABEL } from '@/shared/copy/previews.ts';
import { cn } from '../lib/cn.ts';
import { useContainerWidth } from '../lib/container-width.ts';
import { Callout, SegmentedControl, Select, Skeleton } from '../ui/index.ts';
import { MobilePreview } from './mobile-preview.tsx';
import { PREVIEW_CHANNELS, type PreviewChannel, type PreviewSource } from './types.ts';
import { useWalletPreviews } from './use-wallet-previews.ts';
import { WalletChannel } from './wallet-channel.tsx';

export interface ChannelPreviewsProps {
  /** The pass, its template and files; null until the built pass arrives. */
  source: PreviewSource | null;
  /** The Apple pane: each page draws its own card, with its own motion and toggles. */
  apple: ReactNode;
  /** The Paper pane: pluggable, so the paper design can change without touching the switcher. */
  paper: ReactNode;
  /** A pass's effective channels: only the ones on are shown, the rest are listed with why. */
  channels?: EffectiveChannels | undefined;
  className?: string;
}

/**
 * One switcher for every way a pass reaches a holder: Apple, Google, Samsung, Mobile and Paper.
 * On a pass only its effective channels show and the others say why they are off.
 */
export function ChannelPreviews({
  source,
  apple,
  paper,
  channels,
  className,
}: ChannelPreviewsProps) {
  const shown = PREVIEW_CHANNELS.filter((c) => channels?.[c]?.on !== false);
  const off = PREVIEW_CHANNELS.filter((c) => channels?.[c]?.on === false);
  const [picked, setPicked] = useState<PreviewChannel>('apple');
  const current = shown.includes(picked) ? picked : shown[0];
  const [width, measure] = useContainerWidth();
  // Five segments need about 19 rem; a narrower column gets the same choice as a menu.
  const compact = width > 0 && width < 300;
  const options = shown.map((value) => ({ value, label: PREVIEW_LABEL[value] }));
  const wallets = useWalletPreviews(source, current === 'google' || current === 'samsung');
  if (!current) return <Callout tone="warning">{CHANNEL_COPY.nothingOn}</Callout>;
  return (
    <div ref={measure} className={cn('flex w-full min-w-0 flex-col items-center gap-4', className)}>
      {compact ? (
        <Select
          label={PREVIEW_COPY.switcher}
          options={options}
          value={current}
          onValueChange={(v) => setPicked(v as PreviewChannel)}
          className="w-full"
        />
      ) : (
        <SegmentedControl
          label={PREVIEW_COPY.switcher}
          options={options}
          value={current}
          onValueChange={setPicked}
          block
          className="wp-switch"
        />
      )}
      <div className="w-full min-w-0" data-channel={current}>
        {current === 'apple' ? apple : null}
        {current === 'google' || current === 'samsung' ? (
          <WalletChannel
            target={current}
            previews={source ? wallets : { state: 'loading' }}
            testBand={source?.testBand}
          />
        ) : null}
        {current === 'mobile' ? (
          source ? (
            <MobilePreview source={source} channels={channels} />
          ) : (
            <Skeleton className="mx-auto aspect-[9/16] w-full max-w-xs rounded-3xl" />
          )
        ) : null}
        {current === 'paper' ? paper : null}
      </div>
      {off.length > 0 ? (
        <section className="w-full" aria-label={PREVIEW_COPY.offTitle}>
          <h4 className="mb-1 text-xs font-semibold text-fg-muted">{PREVIEW_COPY.offTitle}</h4>
          <ul className="flex flex-col gap-0.5 text-sm text-fg-muted">
            {off.map((c) => {
              const reason = channels?.[c]?.reason;
              return <li key={c}>{reason ? channelReason(c, reason) : PREVIEW_LABEL[c]}</li>;
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
