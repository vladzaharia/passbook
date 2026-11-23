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
  const apple = source ? <ApplePane source={source} face={face} /> : <Skel ratio="320/420" />;
  const paper = <PaperPane source={source} image={paperImage} />;
  return (
    <section className="stage-wrap" aria-label="Previews">
      <div className="wrap-row g3">
        <Seg
          label="Channel"
          value={channel}
          onChange={onChannel}
          options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))}
        />
        <Seg
          label="Side"
          value={face}
          onChange={onFace}
          className="only-d"
          options={[
            { value: 'front', label: 'Front' },
            { value: 'back', label: 'Back' },
          ]}
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
              {apple}
              <figcaption>{CAPTION.apple}</figcaption>
            </figure>
            <figure data-channel="google">
              <WalletPane target="google" previews={wallets} face={face} />
              <figcaption>{CAPTION.google}</figcaption>
            </figure>
            <figure data-channel="samsung">
              <WalletPane target="samsung" previews={wallets} face={face} />
              <figcaption>{CAPTION.samsung}</figcaption>
            </figure>
            <figure data-channel="paper">
              {paper}
              <figcaption>{CAPTION.paper}</figcaption>
            </figure>
          </section>
        ) : (
          <div className="one">
            <ChannelPreviews source={source} apple={apple} paper={paper} value={channel} />
          </div>
        )}
      </div>
    </section>
  );
}
