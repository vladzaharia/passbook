import { Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';
import { HOLDER_COPY } from '../../../shared/copy/holder.ts';
import type { BuddyProps } from '../../ui/art/buddy-art.tsx';
import { QrTile } from '../holder-qr.tsx';
import './add.css';

/** The buddy as the page draws it: the app's (its scene in view, click replay) or /p's (on load). */
export type RenderBuddy = (props: BuddyProps) => ReactNode;

/**
 * The scan: the add QR on the buddy's sign, the ways to add beside it (under it on a phone). One
 * for the pass page's add block (the portal and /p) and My passes' QR dialog. With `buddy` it sits
 * on the sign (M) and points its teal pass at the code; without, the sign keeps no room above it.
 * The ways start with the iPhone's scan; `children` follow it.
 */
export function Scan({
  url,
  label,
  buddy,
  children,
}: {
  /** The /p page the QR encodes: the iPhone that scans it adds with the badge there. */
  url: string;
  label: string;
  buddy?: RenderBuddy;
  children?: ReactNode;
}) {
  return (
    <div className="wl-add-scan">
      <div className="wl-sign">
        {buddy?.({ size: 'lg', scene: 'nudge', at: 'end', className: 'wl-add-buddy' })}
        <QrTile value={url} label={label} />
      </div>
      <div className="wl-ways">
        <div className="wl-way">
          <p className="wl-way-label">
            <Smartphone aria-hidden />
            {HOLDER_COPY.iphone}
          </p>
          <p className="text-sm text-fg-muted">{HOLDER_COPY.scanLine}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
