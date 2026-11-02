import { type MouseEventHandler, useSyncExternalStore } from 'react';
import { APPLE_BADGE_ALT, appleBadgeSrc } from '../../shared/apple-badge.ts';
import { cn } from '../lib/cn.ts';

const ALT = APPLE_BADGE_ALT;
const src = appleBadgeSrc;

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
