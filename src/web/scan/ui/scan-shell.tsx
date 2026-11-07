import type { CSSProperties, ReactNode } from 'react';
import type { NativeScannerCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
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
  '--duo-desk-left': string;
  '--duo-desk-top': string;
  '--duo-desk-width': string;
  '--duo-desk-height': string;
  '--duo-desk-bottom': string;
};

function duoStyle(layout?: NativeScannerCapabilities['layout']): DuoStyle {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  const division = layout?.posture === 'half-folded' ? layout.division : null;
  let scan: PaneBox = { x: 0, y: 0, width: width / 2, height };
  let desk: PaneBox = { x: width / 2, y: 0, width: width / 2, height };
  if (division && division.height >= division.width) {
    const deskX = division.x + division.width;
    scan = { x: 0, y: 0, width: division.x, height };
    desk = { x: deskX, y: 0, width: Math.max(1, width - deskX), height };
  } else if (division) {
    const deskY = division.y + division.height;
    scan = { x: 0, y: 0, width, height: division.y };
    desk = { x: 0, y: deskY, width, height: Math.max(1, height - deskY) };
  }
  return {
    '--duo-scan-left': `${scan.x}px`,
    '--duo-scan-top': `${scan.y}px`,
    '--duo-scan-width': `${Math.max(1, scan.width)}px`,
    '--duo-scan-height': `${Math.max(1, scan.height)}px`,
    '--duo-scan-bottom': `${Math.max(0, height - scan.y - scan.height)}px`,
    '--duo-desk-left': `${desk.x}px`,
    '--duo-desk-top': `${desk.y}px`,
    '--duo-desk-width': `${Math.max(1, desk.width)}px`,
    '--duo-desk-height': `${Math.max(1, desk.height)}px`,
    '--duo-desk-bottom': `${Math.max(0, height - desk.y - desk.height)}px`,
  };
}

export interface ScanShellProps {
  /** The camera feed, the reader stage or nothing; always behind the tint. */
  camera?: ReactNode;
  surface?: 'phone' | 'operator' | 'duo';
  layout?: NativeScannerCapabilities['layout'];
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
}: ScanShellProps) {
  return (
    <main
      aria-label="Scanner"
      className="scan-shell"
      data-surface={surface}
      style={surface === 'duo' ? duoStyle(layout) : undefined}
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
