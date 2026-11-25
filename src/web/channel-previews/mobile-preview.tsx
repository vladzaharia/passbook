import { useMemo } from 'react';
import type { EffectiveChannels } from '@/shared/contracts/channels.ts';
import type { WalletOffer } from '@/shared/contracts/me.ts';
import { PREVIEW_COPY } from '@/shared/copy/previews.ts';
import type { DeviceInfo } from '@/shared/device.ts';
import '../wallet-previews/wallet-previews.css';
import { usePassView } from '../admin/passes/pass-preview.tsx';
import { PassCardStage } from '../pass-card/index.tsx';
import { passHeading } from '../portal/add/heading.ts';
import { HolderHeading } from '../portal/holder-heading.tsx';
import { HolderPassView } from '../portal/holder-pass-view.tsx';
import { PassDetails } from '../portal/pass-details.tsx';
import { PhoneFrame } from './phone-frame.tsx';
import type { PreviewSource } from './types.ts';

const OFFER = (provider: WalletOffer['provider']): WalletOffer => ({
  provider,
  href: '#',
  installation: 'unknown',
});

/**
 * The holder's pass page (/p) as a phone shows it: the same HolderPassView and PassDetails the
 * public page and the portal render, in a phone-width frame. Nothing in it is live.
 */
export function MobilePreview({
  source,
  channels,
}: {
  source: PreviewSource;
  /** What each channel offers this pass; absent means all on. */
  channels?: EffectiveChannels | undefined;
}) {
  const view = usePassView(
    source.passJson,
    source.assetBaseUrl,
    source.assetNames,
    false,
    source.assetUrls,
  );
  const now = useMemo(() => new Date(), []);
  const device: DeviceInfo = {
    device: channels?.apple.on === false ? 'android' : 'iphone',
    inApp: false,
  };
  const on = (c: 'google' | 'samsung' | 'paper' | 'mobile') => channels?.[c].on !== false;
  const offers = (['google', 'samsung'] as const).filter(on).map(OFFER);
  if (!view)
    return (
      <p role="alert" className="text-sm text-danger">
        {PREVIEW_COPY.failed}
      </p>
    );
  const heading = passHeading(view.description, [view.organizationName], view.organizationName);
  return (
    <div className="flex w-full flex-col items-center gap-3" data-testid="mobile-preview">
      <div className="wp-phone-shell">
        <PhoneFrame title={PREVIEW_COPY.mobileFrame}>
          <div
            className="wp-phone-page px-4 pt-5 pb-8 [--wl-gutter:1rem]"
            // Nothing is live: a click on a link or the badge goes nowhere.
            onClickCapture={(e) => {
              if ((e.target as Element).closest('a')) e.preventDefault();
            }}
            style={{ background: 'var(--pk-surface-page)', minHeight: '100dvh' }}
          >
            <HolderHeading heading={heading} bare />
            <HolderPassView
              pass={
                <PassCardStage view={view} tilt={false} glow={false} testBand={source.testBand} />
              }
              passTitle={heading.title}
              orgName={view.organizationName}
              state="active"
              device={device}
              downloadHref="#"
              walletOffers={offers}
              barcodeHref={on('mobile') ? '#' : undefined}
              printHref={on('paper') ? '#' : undefined}
              publicUrl={null}
              channels={channels}
              details={
                <PassDetails
                  passJson={source.passJson}
                  view={view}
                  locale={navigator.language}
                  now={now}
                />
              }
            />
          </div>
        </PhoneFrame>
      </div>
    </div>
  );
}
