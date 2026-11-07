import type { CSSProperties, ReactNode } from 'react';
import type { ScanBranding } from '../../../shared/contracts/scan-session.ts';
import type { NativeScannerCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
import { scanBrandStyle } from '../platform/scan-branding.tsx';
import '../../styles/motion.css';
import '../display/display.css';
import '../display/display-rows.css';
import './scan.css';
import './scan-capsule.css';
import './scan-dock.css';
import './scan-duo.css';
import { type Announcement, LiveAnnouncer } from './live-announcer.tsx';
import { type Tint, VerdictRing, VerdictTint } from './verdict-tint.tsx';

type PaneBox = { x: number; y: number; width: number; height: number };
type DuoStyle = CSSProperties & {
  '--duo-scan-left': string;
  '--duo-scan-top': string;
  '--duo-scan-width': string;
  '--duo-scan-height': string;
  '--duo-scan-bottom': string;
  '--duo-operator-left': string;
  '--duo-operator-top': string;
  '--duo-operator-width': string;
  '--duo-operator-height': string;
  '--duo-operator-bottom': string;
};

function duoStyle(layout?: NativeScannerCapabilities['layout']): DuoStyle {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  const duoPosture = layout?.posture === 'half-folded' || layout?.posture === 'unfolded';
  const division = duoPosture ? layout.division : null;
  let scan: PaneBox = { x: 0, y: 0, width: width / 2, height };
  let operatorPane: PaneBox = { x: width / 2, y: 0, width: width / 2, height };
  if (division && division.height >= division.width) {
    const operatorX = division.x + division.width;
    scan = { x: 0, y: 0, width: division.x, height };
    operatorPane = { x: operatorX, y: 0, width: Math.max(1, width - operatorX), height };
  } else if (division) {
    const operatorY = division.y + division.height;
    scan = { x: 0, y: 0, width, height: division.y };
    operatorPane = { x: 0, y: operatorY, width, height: Math.max(1, height - operatorY) };
  }
  return {
    '--duo-scan-left': `${scan.x}px`,
    '--duo-scan-top': `${scan.y}px`,
    '--duo-scan-width': `${Math.max(1, scan.width)}px`,
    '--duo-scan-height': `${Math.max(1, scan.height)}px`,
    '--duo-scan-bottom': `${Math.max(0, height - scan.y - scan.height)}px`,
    '--duo-operator-left': `${operatorPane.x}px`,
    '--duo-operator-top': `${operatorPane.y}px`,
    '--duo-operator-width': `${Math.max(1, operatorPane.width)}px`,
    '--duo-operator-height': `${Math.max(1, operatorPane.height)}px`,
    '--duo-operator-bottom': `${Math.max(0, height - operatorPane.y - operatorPane.height)}px`,
  };
}

export interface ScanShellProps {
  /** The camera feed, the reader stage or nothing; always behind the tint. */
  camera?: ReactNode;
  surface?: 'phone' | 'operator' | 'duo';
  layout?: NativeScannerCapabilities['layout'];
  branding?: ScanBranding | null;
  sidebar?: ReactNode;
  tint?: Tint;
  /** Boot cards and the result card, in the card layer. */
  card?: ReactNode;
  /** `boot` centres the card; `result` pins it above the dock. */
  cardMode?: 'boot' | 'result';
  dock?: ReactNode;
  /** The buddy's seat (BU draws into it). */
  buddy?: ReactNode;
  capsule?: ReactNode;
  announcement?: Announcement | null;
}

/**
 * The scanner's layers in BF z-order: camera (0), scrim and washes (0), lock and reticle (4-6, in
 * the camera), a tucking card (9), dock (10), card (11), buddy (12), capsule (20), ring (40).
 * DOM order below is paint order; z-index settles the rest. Direction B lives in this shell, the
 * result, display, desk and buddy folders only.
 */
export function ScanShell({
  camera,
  surface = 'phone',
  layout,
  sidebar,
  tint = 'none',
  card,
  cardMode = 'result',
  dock,
  buddy,
  capsule,
  announcement = null,
  branding,
}: ScanShellProps) {
  const style = {
    ...(surface === 'duo' ? duoStyle(layout) : {}),
    ...(scanBrandStyle(branding) ?? {}),
  };
  return (
    <main
      aria-label="Scanner"
      className="scan-shell"
      data-surface={surface}
      style={style}
      lang="en"
    >
      <div className="scan-layer scan-cam" data-testid="scan-camera">
        {camera}
      </div>
      <VerdictTint tint={tint} />
      <div className="scan-layer scan-card-layer" data-mode={cardMode}>
        {card}
      </div>
      {dock}
      <div aria-hidden className="scan-buddy-seat">
        {buddy}
      </div>
      {capsule}
      {sidebar}
      <VerdictRing tint={tint} />
      <LiveAnnouncer message={announcement} />
    </main>
  );
}
