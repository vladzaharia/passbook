import type { MouseEventHandler } from 'react';
import { APPLE_BADGE_ALT, appleBadgeSrc } from '../../shared/apple-badge.ts';
import { cn } from '../lib/cn.ts';

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
 * Apple's badge artwork, unmodified: the black art on every ground. 44 px tall (40 on fine
 * pointers), clear space of at least 0.1 × height. No transition, animation, glow, press scale or
 * dimming (ux-principles.md, Apple rules).
 */
export function AppleWalletBadge({
  href,
  label,
  locale = 'en',
  onClick,
  className,
}: AppleWalletBadgeProps) {
  return (
    <a
      href={href}
      onClick={onClick}
      data-awb=""
      className={cn(
        'inline-flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg p-1.5 text-sm font-medium text-fg-strong',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        className,
      )}
    >
      <img
        src={appleBadgeSrc(locale)}
        alt={APPLE_BADGE_ALT}
        height={44}
        className="block h-11 w-auto shrink-0 pointer-fine:h-10"
      />
      {label ? <span>{label}</span> : null}
    </a>
  );
}
