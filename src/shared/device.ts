import { HOLDER_COPY } from './copy/holder.ts';
import { isInAppBrowser } from './in-app.ts';

/** Which add path a visitor has (ux-principles.md, Apple rules). */
export type PassDevice = 'iphone' | 'mac' | 'other';

export interface DeviceInfo {
  device: PassDevice;
  /** An app's own web view (Google, Instagram, LinkedIn…): Safari has to open the page to add. */
  inApp: boolean;
}

/**
 * The shared device rule for guidance and QR placement. iPadOS can report a Mac user agent:
 * the browser passes its touch points and a touch Mac is treated as an iPad (`other`); the Worker
 * cannot distinguish it and says `mac`. Old iPad agents, Android and Windows are `other`.
 * This classification does not hide wallet choices on the pass page.
 */
export function passDevice(ua: string | undefined, touchPoints?: number): DeviceInfo {
  const text = ua ?? '';
  const device: PassDevice = /iPhone|iPod/.test(text)
    ? 'iphone'
    : /Macintosh/.test(text) && (touchPoints ?? 0) < 2
      ? 'mac'
      : 'other';
  return { device, inApp: isInAppBrowser(text) };
}

/** The badge adds the pass right here. */
export const canAddToWallet = (device: PassDevice): boolean => device !== 'other';

/**
 * The add QR shows wherever this is not the phone: a camera scan opens /p in Safari on the iPhone,
 * whose badge adds the pass there. A Mac gets it too: its own add needs Safari and iCloud's Wallet
 * sync, the scan needs neither.
 */
export const showsAddQr = (device: PassDevice): boolean => device !== 'iphone';

/**
 * Apple's rule for pages with the badge: say how to add where this browser cannot. A device that
 * cannot add goes to an iPhone or a Mac; an in-app web view on one that can goes to Safari.
 */
export function addLine({ device, inApp }: DeviceInfo): string | null {
  if (!canAddToWallet(device)) return HOLDER_COPY.openOnApple;
  return inApp ? HOLDER_COPY.openInSafari : null;
}
