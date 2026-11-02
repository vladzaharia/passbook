import { escapeHtml } from './html.ts';

export const APPLE_BADGE_ALT = 'Add to Apple Wallet';

export const appleBadgeSrc = (locale: string, variant: 'black' | 'outline') =>
  `/apple/badge/${locale}/${variant}.svg`;

/** Apple's badge as static HTML: black on light, outline on dark. Never animated. */
export function appleWalletBadgeHtml({
  href,
  locale = 'en',
}: {
  href: string;
  locale?: string;
}): string {
  return `<a class="awb" href="${escapeHtml(href)}"><picture><source srcset="${appleBadgeSrc(locale, 'outline')}" media="(prefers-color-scheme: dark)"><img src="${appleBadgeSrc(locale, 'black')}" alt="${APPLE_BADGE_ALT}" height="44"></picture></a>`;
}
