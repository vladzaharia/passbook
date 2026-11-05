import type { ReactNode } from 'react';
import { type DeviceInfo, showsAddQr } from '../../../shared/device.ts';

/**
 * What the add block does. scan: the QR leads (not the phone). phone: the badge leads (the
 * iPhone; a page with no public URL). added: on a device already, so a quiet line, adding again on
 * request. off: voided or expired, nothing to add.
 */
export type AddMode = 'scan' | 'phone' | 'added' | 'off';

export function addMode(
  state: 'active' | 'voided' | 'expired' | 'removed',
  device: DeviceInfo,
  inWallet: boolean,
  publicUrl: string | null,
): AddMode {
  if (state !== 'active') return 'off';
  if (inWallet) return 'added';
  return publicUrl !== null && showsAddQr(device.device) ? 'scan' : 'phone';
}

/** What the add block gets from the view (holder-pass-view.tsx). */
export interface AddAreaProps {
  mode: Exclude<AddMode, 'off'>;
  device: DeviceInfo;
  /** The /p URL the QR encodes; null where there is none. */
  publicUrl: string | null;
  qrLabel: string;
  /** Apple's badge, built once with the page's theme and the card's dip. */
  badge: ReactNode;
  /** Apple's line where this browser cannot add (shared/device.ts addLine). */
  line: string | null;
}

/**
 * Beside the QR, the badge only where it adds: the Mac. /p cannot tell an iPad from a Mac by its
 * user agent; `wl-mac-only` hides it on a touch screen (add.css).
 */
export const macBeside = (p: Pick<AddAreaProps, 'device'>) => p.device.device === 'mac';
