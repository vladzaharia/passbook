import type { ReactNode } from 'react';
import type { AddMode } from '../../../shared/add-direction.ts';
import type { DeviceInfo } from '../../../shared/device.ts';
import type { PassView } from '../../../shared/pass-view/index.ts';

/** What each exploration's add block gets from the view (direction-view.tsx). */
export interface AddAreaProps {
  mode: Exclude<AddMode, 'off'>;
  device: DeviceInfo;
  /** The /p URL the QR encodes; set wherever the mode can show the QR. */
  publicUrl: string | null;
  qrLabel: string;
  /** Apple's badge, built once with the page's theme and the card's dip. */
  badge: ReactNode;
  /** Apple's line where this browser cannot add (shared/device.ts addLine). */
  line: string | null;
  view: PassView;
}

/**
 * Beside the QR, the badge only where it adds: the Mac. /p cannot tell an iPad from a Mac by its
 * user agent; `wl-mac-only` hides it on a touch screen (add.css).
 */
export const macBeside = (p: Pick<AddAreaProps, 'device'>) => p.device.device === 'mac';
