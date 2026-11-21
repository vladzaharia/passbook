import { HOLDER_COPY } from './copy/holder.ts';
import { isInAppBrowser } from './in-app.ts';

/** Which add path a visitor has (ux-principles.md, Apple rules). */
export type PassDevice = 'iphone' | 'mac' | 'android' | 'galaxy' | 'other';

export interface DeviceInfo {
  device: PassDevice;
  /** An app's own web view (Google, Instagram, LinkedIn…): Safari has to open the page to add. */
  inApp: boolean;
}

/**
 * The shared device rule for guidance and QR placement. iPadOS can report a Mac user agent:
 * the browser passes its touch points and a touch Mac is treated as an iPad (`other`); the Worker
 * cannot distinguish it and says `mac`. Old iPad agents and Windows are `other`. Android phones
 * are `android`, Samsung's own (an SM- model or a Samsung device name, not just SamsungBrowser) `galaxy`: no Apple add path, so the pages drop the
 * Apple badge and QR for them.
 */
export function passDevice(ua: string | undefined, touchPoints?: number): DeviceInfo {
  const text = ua ?? '';
  const device: PassDevice = /iPhone|iPod/.test(text)
    ? 'iphone'
    : isDesktopMac(text, touchPoints)
      ? 'mac'
      : /Android/.test(text)
        ? /\bSM-[A-Z]\d|\bSAMSUNG(?!Browser)/i.test(text)
          ? 'galaxy'
          : 'android'
        : 'other';
  return { device, inApp: isInAppBrowser(text) };
}

/**
 * A Mac, not an iPad: iPadOS Safari sends the Mac's agent, and only its touch points tell them
 * apart. Self-contained, so the SSR pages run this same function in the browser (MAC_REVEAL_SCRIPT).
 */
export function isDesktopMac(ua: string, touchPoints?: number): boolean {
  return /Macintosh/.test(ua) && (touchPoints || 0) < 2;
}

/**
 * The SSR pages cannot see touch points, so a Mac agent may be an iPad: they render the safe
 * variant (no Mac-only parts) and this script, nonced, shows the `data-mac-only` parts on a Mac.
 */
export const MAC_REVEAL_SCRIPT = `if((${isDesktopMac.toString()})(navigator.userAgent,navigator.maxTouchPoints))document.querySelectorAll('[data-mac-only]').forEach(function(e){e.hidden=false})`;

/** The badge adds the pass right here. */
export const canAddToWallet = (device: PassDevice): boolean =>
  device === 'iphone' || device === 'mac';

/** An Android phone: Apple's badge and QR cannot work there, so the pages leave them out. */
export const isAndroid = (device: PassDevice): boolean =>
  device === 'android' || device === 'galaxy';

/**
 * The add QR shows wherever this is not the phone: a camera scan opens /p in Safari on the iPhone,
 * whose badge adds the pass there. A Mac gets it too: its own add needs Safari and iCloud's Wallet
 * sync, the scan needs neither.
 */
export const showsAddQr = (device: PassDevice): boolean =>
  device !== 'iphone' && !isAndroid(device);

/**
 * Apple's rule for pages with the badge: say how to add where this browser cannot. A device that
 * cannot add goes to an iPhone or a Mac; an in-app web view on one that can goes to Safari.
 */
export function addLine({ device, inApp }: DeviceInfo): string | null {
  if (!canAddToWallet(device)) return HOLDER_COPY.openOnApple;
  return inApp ? HOLDER_COPY.openInSafari : null;
}
