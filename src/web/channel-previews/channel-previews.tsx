import { lazy, type ReactNode, Suspense, useState } from 'react';
import { chainLevelOf } from '@/shared/channels.ts';
import type { ChannelStatus, EffectiveChannels } from '@/shared/contracts/channels.ts';
import { CHANNEL_LABEL, channelReasonText } from '@/shared/copy/channels.ts';
import { PREVIEW_COPY, PREVIEW_LABEL } from '@/shared/copy/previews.ts';
import { cn } from '../lib/cn.ts';
import { useContainerWidth } from '../lib/container-width.ts';
import { SegmentedControl } from '../ui/segmented-control.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import type { PreviewFace } from './face-pair.tsx';
import { LockedPreview, type OffLevel } from './locked-preview.tsx';
import './channel-switch.css';
import { PREVIEW_CHANNELS, type PreviewChannel, type PreviewSource } from './types.ts';
import { useWalletPreviews } from './use-wallet-previews.ts';

export interface ChannelPreviewsProps {
  /** The pass, its template and files; null until the built pass arrives. */
  source: PreviewSource | null;
  /** The Apple pane: each page draws its own card, with its own motion and toggles. */
  apple: ReactNode;
  /** The Paper pane: pluggable, so the paper design can change without touching the switcher. */
  paper: ReactNode;
  /**
   * Effective channels of a pass or template. One the template or pass turns off stays as a quiet
   * tab with its reason; one PassBook, the plan or the organization stops has no tab.
   */
  channels?: EffectiveChannels | undefined;
  /** Shown with the empty state when every channel is off: where to turn one on. */
  emptyAction?: ReactNode;
  /** A line above one channel's pane, e.g. a channel the template turns off that the designer still edits. */
  notes?: Partial<Record<PreviewChannel, string>> | undefined;
  /** The action on an off channel's pane: a link to the level that turns it off. */
  lockedAction?: ((info: { channel: PreviewChannel; level: OffLevel }) => ReactNode) | undefined;
  /** The page picks the channel (and draws its own switcher): only that channel's pane shows. */
  value?: PreviewChannel | undefined;
  /** Google and Samsung list what the wallet drops beside the card; off where the page has its own list. */
  walletNotes?: boolean | undefined;
  /** The Front / Back choice of the wallet cards, when the page keeps it (a shared hash, say). */
  face?: PreviewFace | undefined;
  onFace?: ((face: PreviewFace) => void) | undefined;
  className?: string;
}

/** The narrow-column menu pulls Radix's popper and dialog; a wide column never needs it. */
const Select = lazy(() => import('../ui/select.tsx').then((m) => ({ default: m.Select })));

/** Its art registry is only needed when no channel is on. */
const EmptyState = lazy(() =>
  import('../ui/empty-state.tsx').then((m) => ({ default: m.EmptyState })),
);

/** Both pull the router (and, for Mobile, the portal) with them: loaded only when their channel opens. */
const WalletChannel = lazy(() =>
  import('./wallet-channel.tsx').then((m) => ({ default: m.WalletChannel })),
);
const MobilePreview = lazy(() =>
  import('./mobile-preview.tsx').then((m) => ({ default: m.MobilePreview })),
);

/** The level that turns a channel off, when it is the template's or the pass's: the author can turn it back on. */
const offLevel = (s: ChannelStatus | undefined): OffLevel | undefined => {
  if (s?.on !== false) return undefined;
  const level = chainLevelOf(s.source, s.reason);
  return level === 'template' || level === 'pass' ? level : undefined;
};

/** Past three tabs the segments tighten (channel-switch.css); a column under about this much a tab gets a menu. */
const TAB_MIN = { tight: 60, kit: 80 } as const;

/**
 * One switcher for every way a pass reaches a holder: Apple, Google, Samsung, Mobile and Paper.
 * Only channels the organization can use have a tab. One the template or pass turns off is a quiet,
 * hatched tab; its pane says so and links to where it turns back on.
 */
export function ChannelPreviews({
  source,
  apple,
  paper,
  channels,
  emptyAction,
  lockedAction,
  notes,
  value,
  walletNotes,
  face,
  onFace,
  className,
}: ChannelPreviewsProps) {
  const tabs = PREVIEW_CHANNELS.filter(
    (c) => channels?.[c]?.on !== false || offLevel(channels?.[c]) !== undefined,
  );
  const shown = tabs.filter((c) => channels?.[c]?.on !== false);
  const [picked, setPicked] = useState<PreviewChannel | null>(null);
  // An off tab can be opened to read why; with nothing on at all the empty state stands instead.
  const open = picked && tabs.includes(picked) ? picked : shown[0];
  const current = value ?? (shown.length > 0 ? open : undefined);
  const [width, measure] = useContainerWidth();
  const tight = tabs.length > 3;
  const compact = width > 0 && width < tabs.length * (tight ? TAB_MIN.tight : TAB_MIN.kit);
  const options = tabs.map((value) => {
    const status = channels?.[value];
    if (status?.on !== false) return { value, label: PREVIEW_LABEL[value] };
    const hint = status.reason ? channelReasonText(status.reason) : PREVIEW_COPY.off;
    return { value, label: PREVIEW_LABEL[value], hint };
  });
  const menu = options.map((o) => ('hint' in o ? { ...o, title: o.hint } : o));
  const stopped = current ? channels?.[current] : undefined;
  const locked = stopped?.on === false;
  const level = offLevel(stopped);
  const wallets = useWalletPreviews(
    source,
    !locked && (current === 'google' || current === 'samsung'),
  );
  if (!current)
    return (
      <Suspense fallback={<Skeleton className="h-32 w-full rounded-md" />}>
        <EmptyState inline art="wallet" title={PREVIEW_COPY.nothing} action={emptyAction} />
      </Suspense>
    );
  return (
    <div ref={measure} className={cn('flex w-full min-w-0 flex-col items-center gap-4', className)}>
      {value ? null : compact ? (
        <Suspense fallback={<Skeleton className="h-9 w-full rounded-md" />}>
          <Select
            label={PREVIEW_COPY.switcher}
            options={menu}
            value={current}
            onValueChange={(v) => setPicked(v as PreviewChannel)}
            className="w-full"
          />
        </Suspense>
      ) : (
        <SegmentedControl
          label={PREVIEW_COPY.switcher}
          options={options}
          value={current}
          onValueChange={setPicked}
          block
          className={cn('mx-auto max-w-sm', tight && 'wp-switch')}
        />
      )}
      <div className="w-full min-w-0" data-channel={current}>
        {notes?.[current] ? (
          <p className="mb-3 text-center text-xs text-fg-muted">{notes[current]}</p>
        ) : null}
        {level && stopped ? (
          <LockedPreview
            channel={CHANNEL_LABEL[current]}
            reason={stopped.reason ? channelReasonText(stopped.reason) : PREVIEW_COPY.off}
            level={level}
            card={apple}
          >
            {lockedAction?.({ channel: current, level })}
          </LockedPreview>
        ) : null}
        {locked ? null : current === 'apple' ? apple : null}
        {locked ? null : current === 'google' || current === 'samsung' ? (
          <Suspense
            fallback={<Skeleton className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl" />}
          >
            <WalletChannel
              target={current}
              previews={source ? wallets : { state: 'loading' }}
              testBand={source?.testBand}
              notes={walletNotes}
              face={face}
              onFace={onFace}
            />
          </Suspense>
        ) : null}
        {locked ? null : current === 'mobile' ? (
          source ? (
            <Suspense
              fallback={<Skeleton className="mx-auto aspect-[9/16] w-full max-w-xs rounded-3xl" />}
            >
              <MobilePreview source={source} channels={channels} />
            </Suspense>
          ) : (
            <Skeleton className="mx-auto aspect-[9/16] w-full max-w-xs rounded-3xl" />
          )
        ) : null}
        {locked ? null : current === 'paper' ? paper : null}
      </div>
    </div>
  );
}
