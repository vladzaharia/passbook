import { type MouseEventHandler, useSyncExternalStore } from 'react';
import { cn } from '../lib/cn.ts';

const ALT = 'Add to Apple Wallet';
const src = (locale: string, variant: 'black' | 'outline') =>
  `/apple/badge/${locale}/${variant}.svg`;

/** html[data-theme] (admin choice): undefined follows the system through <picture>. */
function useDocTheme(): string | undefined {
  return useSyncExternalStore(
    (notify) => {
      const mo = new MutationObserver(notify);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return () => mo.disconnect();
    },
    () => document.documentElement.dataset.theme,
    () => undefined,
  );
}

export interface AppleWalletBadgeProps {
  href: string;
  /** A plain label beside the badge for bundles: "All passes (3)". Never badge-like. */
  label?: string;
  /** The page language; Apple's artwork per locale. */
  locale?: string;
  /** Runs as the download starts (the pass card dips towards the badge; the badge never moves). */
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  className?: string;
}

/**
 * Apple's badge artwork, unmodified: black on light grounds, outline on dark. 44 px tall (40 on
 * fine pointers), clear space of at least 0.1 × height. No transition, animation, glow, press scale
 * or dimming (ux-principles.md, Apple rules).
 */
export function AppleWalletBadge({
  href,
  label,
  locale = 'en',
  onClick,
  className,
}: AppleWalletBadgeProps) {
  const theme = useDocTheme();
  const forced = theme === 'dark' ? 'outline' : theme === 'light' ? 'black' : undefined;
  return (
    <a
      href={href}
      onClick={onClick}
      className={cn(
        'inline-flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg p-1.5 text-sm font-medium text-fg-strong',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        className,
      )}
    >
      <picture className="block shrink-0">
        {forced ? null : (
          <source srcSet={src(locale, 'outline')} media="(prefers-color-scheme: dark)" />
        )}
        <img
          src={src(locale, forced ?? 'black')}
          alt={ALT}
          height={44}
          className="block h-11 w-auto pointer-fine:h-10"
        />
      </picture>
      {label ? <span>{label}</span> : null}
    </a>
  );
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The same badge as static HTML: SSR pages (picture, SVG) and email (PNG at @2x, absolute URL,
 * width 168, no animation).
 */
export function appleWalletBadgeHtml({
  href,
  locale = 'en',
  email,
}: {
  href: string;
  locale?: string;
  /** Absolute origin for email: the PNG export is used, sized for mail clients. */
  email?: { origin: string };
}): string {
  if (email) {
    const png = `${email.origin}/apple/badge/${locale}/black@2x.png`;
    return `<a href="${escapeHtml(href)}" style="display:inline-block;padding:4px;text-decoration:none"><img src="${escapeHtml(png)}" alt="${ALT}" width="168" style="display:block;width:168px;height:auto;border:0"></a>`;
  }
  return `<a class="awb" href="${escapeHtml(href)}"><picture><source srcset="${src(locale, 'outline')}" media="(prefers-color-scheme: dark)"><img src="${src(locale, 'black')}" alt="${ALT}" height="44"></picture></a>`;
}
