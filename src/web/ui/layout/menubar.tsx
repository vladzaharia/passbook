import { Search } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';
import { Button } from '../button.tsx';

/** Content width: holder pages read as one column, the console takes the room it has. */
export const WIDTH = { holder: 'max-w-5xl', console: '', full: '' } as const;
export type MenubarWidth = keyof typeof WIDTH;

export interface MenubarProps {
  width: MenubarWidth;
  /** Before the brand: the drawer button of a space with a side nav. */
  start?: ReactNode;
  brand: ReactNode;
  /** The space's own nav. Never links to another space: the account menu switches those. */
  nav?: ReactNode;
  search?: ReactNode;
  /** The space's controls, left of the account menu. */
  controls?: ReactNode;
  account: ReactNode;
  /** In flow under the bar, in the same sticky block (the offline bar). */
  below?: ReactNode;
  /** `test` re-tones the bar amber (Test mode, mode.css). Never set where Test is the only mode. */
  tone?: 'test';
}

/**
 * The one top bar: admin, portal and the developer site render this component (the site at build
 * time, tools/build-developers.ts). 56 px with its border, sticky, on the page surface, one gutter
 * and every safe-area edge padded. Left the mark and the space's nav, right its controls and the
 * account menu.
 */
export function Menubar({
  width,
  start,
  brand,
  nav,
  search,
  controls,
  account,
  below,
  tone,
}: MenubarProps) {
  return (
    <div className="sticky top-0 z-20 [--wl-gutter:1rem] sm:[--wl-gutter:1.5rem]">
      <header
        data-menubar
        data-tone={tone}
        className="relative z-10 border-b border-border bg-surface-page pt-[env(safe-area-inset-top)]"
      >
        <div
          className={cn(
            'mx-auto flex h-[calc(3.5rem-1px)] w-full items-center gap-2 px-safe',
            WIDTH[width],
          )}
        >
          {start}
          {brand}
          {nav}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {search}
            {controls}
            {account}
          </div>
        </div>
      </header>
      {below}
    </div>
  );
}

/** "⌘K" on Apple platforms (iPadOS reports a Mac), "Ctrl K" elsewhere. */
export function shortcutHint(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
  return /Mac|iPhone|iPad|iPod/i.test(ua) ? '⌘K' : 'Ctrl K';
}

const SEARCH_BUTTON =
  'inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-border-strong bg-surface-raised px-3 text-sm font-normal text-fg-muted wl-colors hover:bg-state-hover-tint hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:h-11';

/** The search field from 640 px, an icon button below; `hint` is the shortcut (omitted on touch). */
export function MenubarSearch({
  label,
  hint,
  ...props
}: {
  label: string;
  hint?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'aria-label' | 'children'>) {
  return (
    <>
      <button
        type="button"
        aria-label={label}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-fg-muted wl-colors hover:bg-state-hover-tint hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus pointer-coarse:size-11 sm:hidden"
        {...props}
      >
        <Search aria-hidden className="size-4" />
      </button>
      {/* Named by its visible text, shortcut included. */}
      <button
        type="button"
        className={cn(SEARCH_BUTTON, 'max-sm:hidden sm:w-64 sm:justify-start')}
        {...props}
      >
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
        {hint ? (
          <kbd className="ml-auto rounded-sm border border-border px-1.5 font-sans text-xs">
            {hint}
          </kbd>
        ) : null}
      </button>
    </>
  );
}

export interface MenubarNavItem {
  label: string;
  href: string;
  current: boolean;
}

/** The space's own sections as plain links, from 900 px; narrower, the space's drawer carries them. */
export function MenubarNav({ label, items }: { label: string; items: readonly MenubarNavItem[] }) {
  return (
    <nav aria-label={label} className="ml-2 flex min-w-0 gap-1 max-[900px]:hidden">
      {items.map((item) => (
        <a
          key={item.href}
          href={item.href}
          aria-current={item.current ? 'page' : undefined}
          className={cn(
            'inline-flex min-h-9 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium wl-colors hover:text-fg-strong',
            item.current ? 'bg-state-hover-tint text-fg-strong' : 'text-fg-muted',
          )}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}

/** What takes the avatar's place when nobody is signed in; `children` is the link (router or plain). */
export function SignInButton({ children }: { children: ReactElement }) {
  return (
    <Button asChild variant="outline" size="sm">
      {children}
    </Button>
  );
}
