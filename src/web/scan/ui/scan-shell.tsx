import type { ReactNode } from 'react';
import '../../styles/motion.css';
import '../display/display.css';
import '../display/display-rows.css';
import './scan.css';
import './scan-capsule.css';
import './scan-dock.css';
import { type Announcement, LiveAnnouncer } from './live-announcer.tsx';
import { type Tint, VerdictRing, VerdictTint } from './verdict-tint.tsx';

export interface ScanShellProps {
  /** The camera feed, the reader stage or nothing; always behind the tint. */
  camera?: ReactNode;
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
  tint = 'none',
  card,
  cardMode = 'result',
  dock,
  buddy,
  capsule,
  announcement = null,
}: ScanShellProps) {
  return (
    <main aria-label="Scanner" className="scan-shell" lang="en">
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
      <VerdictRing tint={tint} />
      <LiveAnnouncer message={announcement} />
    </main>
  );
}
