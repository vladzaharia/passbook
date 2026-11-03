import { escapeHtml } from './html.ts';

export const APPLE_BADGE_ALT = 'Add to Apple Wallet';

export const appleBadgeSrc = (locale: string, variant: 'black' | 'outline') =>
  `/apple/badge/${locale}/${variant}.svg`;

/**
 * Apple's badge as static HTML: black on light, outline on dark. Like the SPA badge
 * (apple-wallet-badge.tsx), a page theme (html[data-theme]) picks the artwork; without one,
 * <picture> follows the system. Never animated.
 */
export function appleWalletBadgeHtml({
  href,
  locale = 'en',
  theme,
}: {
  href: string;
  locale?: string;
  theme?: 'light' | 'dark' | undefined;
}): string {
  const forced = theme === 'dark' ? 'outline' : theme === 'light' ? 'black' : undefined;
  const source = forced
    ? ''
    : `<source srcset="${appleBadgeSrc(locale, 'outline')}" media="(prefers-color-scheme: dark)">`;
  return `<a class="awb" href="${escapeHtml(href)}"><picture>${source}<img src="${appleBadgeSrc(locale, forced ?? 'black')}" alt="${APPLE_BADGE_ALT}" height="44"></picture></a>`;
}
