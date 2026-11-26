import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ChannelPreviews } from '../../channel-previews/channel-previews.tsx';
import type { PreviewSource } from '../../channel-previews/types.ts';
import type { WalletPreviews } from '../../channel-previews/use-wallet-previews.ts';
import { CHANNELS, type Channel, type Face } from './hash.ts';
import { ApplePane, PaperPane, Skel, WalletPane } from './panes.tsx';
import { Seg } from './seg.tsx';
import type { Freshness } from './use-playground.ts';

const CHANNEL_LABEL: Record<Channel, string> = {
  all: 'All',
  apple: 'Apple',
  google: 'Google',
  samsung: 'Samsung',
  paper: 'Paper',
};
/** The tallest a printed page draws: beside the cards, and alone. */
const ALL_PAPER_H = 420;
const ONE_PAPER_H = 640;
const CAPTION = {
  apple: 'Apple Wallet',
  google: 'Google Wallet',
  samsung: 'Samsung Wallet',
  paper: 'Paper',
} as const;

/** "Updated 0.3 s ago", re-read every second while it is the newest thing on screen. */
function Age({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, (now - at) / 1000);
  return (
    <>
      {s < 60
        ? `Updated ${s < 10 ? s.toFixed(1) : Math.round(s)} s ago`
        : 'Updated over a minute ago'}
    </>
  );
}

export function Stage({
  source,
  wallets,
  channel,
  face,
  freshness,
  updatedAt,
  stale,
  paperImage,
  onChannel,
  onFace,
}: {
  source: PreviewSource | null;
  wallets: WalletPreviews;
  channel: Channel;
  face: Face;
  freshness: Freshness;
  updatedAt: number;
  /** The visitor edited, but the previews are the sample's: nothing renders without a sandbox. */
  stale: boolean;
  paperImage: { src: string; width: number; height: number } | undefined;
  onChannel: (c: Channel) => void;
  onFace: (f: Face) => void;
}) {
  const appleOf = (label?: string) =>
    source ? (
      <ApplePane source={source} face={face} onFace={onFace} label={label} />
    ) : (
      <Skel ratio="320/420" />
    );
  const paperOf = (maxHeight: number) => (
    <PaperPane source={source} image={paperImage} maxHeight={maxHeight} />
  );
  return (
    <section className="stage-wrap" aria-label="Previews">
      <div className="wrap-row g3">
        <Seg
          label="Channel"
          value={channel}
          onChange={onChannel}
          options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))}
        />
        <span className="xs muted push row g1 status" role="status">
          {freshness === 'updating' ? (
            <>
              <RefreshCw aria-hidden="true" className="spin" />
              Updating
            </>
          ) : freshness === 'fresh' ? (
            <>
              <RefreshCw aria-hidden="true" />
              <Age at={updatedAt} />
            </>
          ) : freshness === 'error' ? (
            'Not updated'
          ) : stale ? (
            'Showing the sample. Edit in your sandbox to preview changes.'
          ) : (
            'Sample'
          )}
        </span>
      </div>
      <div className="stage stage-grid chanwrap">
        {channel === 'all' ? (
          <section
            className="chan"
            data-testid="all-channels"
            aria-label="All channels"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: scrolls sideways on a phone, so the keyboard must reach it
            tabIndex={0}
          >
            <figure data-channel="apple">
              {appleOf('Apple side')}
              <figcaption>{CAPTION.apple}</figcaption>
            </figure>
            <figure data-channel="google">
              <WalletPane
                target="google"
                previews={wallets}
                face={face}
                onFace={onFace}
                label="Google side"
              />
              <figcaption>{CAPTION.google}</figcaption>
            </figure>
            <figure data-channel="samsung">
              <WalletPane
                target="samsung"
                previews={wallets}
                face={face}
                onFace={onFace}
                label="Samsung side"
              />
              <figcaption>{CAPTION.samsung}</figcaption>
            </figure>
            <figure data-channel="paper">
              {paperOf(ALL_PAPER_H)}
              <figcaption>{CAPTION.paper}</figcaption>
            </figure>
          </section>
        ) : (
          <div className="one">
            <ChannelPreviews
              source={source}
              apple={appleOf()}
              paper={paperOf(ONE_PAPER_H)}
              value={channel}
              walletNotes={false}
              face={face}
              onFace={onFace}
            />
          </div>
        )}
      </div>
    </section>
  );
}
