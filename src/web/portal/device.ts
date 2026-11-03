import { type DeviceInfo, passDevice } from '../../shared/device.ts';

/** This browser under the shared device rule (shared/device.ts): its touch points tell an iPad. */
export const browserDevice = (): DeviceInfo =>
  passDevice(navigator.userAgent, navigator.maxTouchPoints);

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
