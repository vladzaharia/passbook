interface Nav {
  userAgent: string;
  maxTouchPoints?: number;
}

const nav = (): Nav => (typeof navigator === 'undefined' ? { userAgent: '' } : navigator);

/** iPhone or iPod (never iPad). */
export const isApplePhone = (n: Nav = nav()) => /iPhone|iPod/.test(n.userAgent);

/**
 * Devices that add passes to Wallet: iPhone, iPod and Mac. iPadOS reports a Mac user agent but
 * has touch points, so it counts as a device that cannot add (it gets the QR first).
 */
export function canAddToWallet(n: Nav = nav()): boolean {
  if (isApplePhone(n)) return true;
  return /Macintosh/.test(n.userAgent) && (n.maxTouchPoints ?? 0) < 2;
}
