import { type MouseEventHandler, useSyncExternalStore } from 'react';
import { APPLE_BADGE_ALT, appleBadgeSrc } from '../../shared/apple-badge.ts';
import { cn } from '../lib/cn.ts';

const ALT = APPLE_BADGE_ALT;
const src = appleBadgeSrc;

// /p renders the badge in the Worker, whose typecheck has no DOM lib: type the two globals used.
const dom = globalThis as unknown as {
  document: { documentElement: { dataset: Record<string, string | undefined> } };
  MutationObserver: new (
    notify: () => void,
  ) => { observe(node: unknown, options: object): void; disconnect(): void };
};

/** html[data-theme] (the account menu's choice): undefined follows the system through <picture>. */
function useDocTheme(): string | undefined {
  return useSyncExternalStore(
    (notify) => {
      const mo = new dom.MutationObserver(notify);
      mo.observe(dom.document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
      return () => mo.disconnect();
    },
    () => dom.document.documentElement.dataset.theme,
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
  /** Server rendering (/p): the page's stamped theme, which the document cannot report yet. */
  theme?: 'light' | 'dark' | undefined;
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
  theme: stamped,
  className,
}: AppleWalletBadgeProps) {
  const theme = useDocTheme() ?? stamped;
  const forced = theme === 'dark' ? 'outline' : theme === 'light' ? 'black' : undefined;
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
