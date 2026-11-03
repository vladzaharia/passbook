import { Compass } from 'lucide-react';
import type { CSSProperties } from 'react';
import { ADD_COPY } from '../../../shared/copy/add.ts';
import './phone.css';
import './phone-screens.css';
import type { PassView } from '../../../shared/pass-view/index.ts';
import { QrTile } from '../holder-qr.tsx';

/** The pass as Wallet stacks it: its colours, its art and logo, two lines and the code's tile. */
function MiniPass({ view }: { view: PassView }) {
  const c = view.colors;
  const art = view.images.artwork ?? view.images.background;
  const logo = view.images.primaryLogo ?? view.images.logo;
  const style = { '--mp-bg': c.background, '--mp-fg': c.foreground } as CSSProperties;
  return (
    <span className="wl-mp" style={style}>
      {art ? <img src={art.src} alt="" className="wl-mp-art" /> : null}
      {logo ? (
        <img src={logo.src} alt="" className="wl-mp-logo" />
      ) : (
        <span className="wl-mp-name">{view.logoText ?? view.organizationName}</span>
      )}
      <i className="wl-mp-line" />
      <i className="wl-mp-line" />
      {view.layout.barcode ? (
        <i className="wl-mp-code" data-square={view.layout.barcode.square || undefined} />
      ) : null}
    </span>
  );
}

const hostOf = (url: string) => /^https?:\/\/([^/]+)/.exec(url)?.[1] ?? url;

/**
 * b's iPhone, drawn in CSS (add-b.css): titanium edge, bezel, the Dynamic Island. `scan`: the
 * Camera app frames the add QR (the real one: large, flat, on white); the line sweeps, the code
 * is recognised, the Add sheet rises under it. `wallet`: the pass in the stack, already added.
 */
export function Phone({
  screen,
  view,
  publicUrl,
  qrLabel,
}: {
  screen: 'scan' | 'wallet';
  view: PassView;
  publicUrl: string | null;
  qrLabel: string;
}) {
  return (
    <div className="wl-ph" data-screen={screen}>
      <div className="wl-ph-glass">
        {screen === 'scan' && publicUrl ? (
          <div className="wl-ph-cam">
            <div className="wl-ph-target">
              <QrTile value={publicUrl} label={qrLabel} className="wl-ph-qr">
                <span aria-hidden className="wl-ph-scan" />
              </QrTile>
              <span aria-hidden className="wl-ph-lock">
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>
            <span aria-hidden className="wl-ph-chip">
              <Compass />
              {hostOf(publicUrl)}
            </span>
            <span aria-hidden className="wl-ph-shutter" />
            <span aria-hidden className="wl-ph-sheet">
              <span className="wl-ph-bar">
                <span>{ADD_COPY.cancel}</span>
                <b>{ADD_COPY.add}</b>
              </span>
              <MiniPass view={view} />
            </span>
          </div>
        ) : (
          <div aria-hidden className="wl-ph-wallet">
            <MiniPass view={view} />
            <i className="wl-ph-tab" />
            <i className="wl-ph-tab" />
            <i className="wl-ph-tab" />
          </div>
        )}
        <span aria-hidden className="wl-ph-status">
          <b>9:41</b>
          <i className="wl-ph-island" />
          <i className="wl-ph-cell" />
        </span>
      </div>
    </div>
  );
}
