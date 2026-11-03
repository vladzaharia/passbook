/** Apple's badge artwork: the kit AppleWalletBadge renders it for the portal and /p alike. */
export const APPLE_BADGE_ALT = 'Add to Apple Wallet';

export const appleBadgeSrc = (locale: string, variant: 'black' | 'outline') =>
  `/apple/badge/${locale}/${variant}.svg`;
