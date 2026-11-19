import { canAddToWallet, type DeviceInfo, passDevice } from '../../shared/device.ts';

/**
 * This browser under the shared device rule (shared/device.ts): its touch points tell an iPad. A
 * phone-width window that can add to Wallet is the phone itself: it leads with the badge, never a
 * QR it cannot scan.
 */
export function browserDevice(): DeviceInfo {
  const info = passDevice(navigator.userAgent, navigator.maxTouchPoints);
  const narrow = window.matchMedia?.('(max-width: 639.98px)').matches === true;
  return narrow && canAddToWallet(info.device) ? { ...info, device: 'iphone' } : info;
}

/**
 * Installed to the home screen: a link in the email opens Safari, not this app, so the code
 * leads, on the sign-in page and in the email.
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true
  );
}
