import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';
import { MAIN_ID } from '../../lib/route-focus.tsx';
import { OfflineBanner } from '../offline-banner.tsx';

/** Content width: holder pages read as one column, the console takes the room it has. */
const WIDTH = { holder: 'max-w-5xl', console: '', full: '' } as const;

export interface AppShellProps {
  /** Top bar contents. Omitted on /login, whose page draws its own band. */
  bar?: ReactNode;
  /** A column left of the page from lg (the admin sidebar). */
  sidebar?: ReactNode;
  /** In flow under the bar and the offline bar, in the same sticky block (the Test mode band). */
  band?: ReactNode;
  width: keyof typeof WIDTH;
  /** Holder pages follow the iOS text size (Dynamic Type, base.css .wl-portal). */
  holder: boolean;
  children: ReactNode;
}

/**
 * Every page's frame. A sticky top bar, 56 px with its border, on the page surface; the offline
 * bar under it, sticking with it and pushing the page down; then main. One gutter (1rem, 1.5rem
 * from 640) for the bar and main, and every safe-area edge padded.
 */
export function AppShell({ bar, sidebar, band, width, holder, children }: AppShellProps) {
  const column = (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="sticky top-0 z-20">
        {bar ? (
          <header className="relative z-10 border-b border-border bg-surface-page pt-[env(safe-area-inset-top)]">
            <div
              className={cn(
                'mx-auto flex h-[calc(3.5rem-1px)] w-full items-center gap-2 px-safe',
                WIDTH[width],
              )}
            >
              {bar}
            </div>
          </header>
        ) : null}
        <OfflineBanner
          className={bar ? undefined : 'h-auto min-h-8 pt-[env(safe-area-inset-top)]'}
        />
        {band}
      </div>
      <main
        id={MAIN_ID}
        tabIndex={-1}
        className={cn(
          'mx-auto w-full flex-1 px-safe pb-[max(1.5rem,env(safe-area-inset-bottom))]',
          // A SaveBar is fixed over the bottom: its room goes at the end of the page.
          'has-[[data-save-bar]]:pb-[calc(6rem+env(safe-area-inset-bottom))]',
          bar ? 'pt-6' : 'pt-[env(safe-area-inset-top)]',
          WIDTH[width],
        )}
      >
        {children}
      </main>
    </div>
  );
  return (
    <div
      className={cn(
        'min-h-dvh [--wl-gutter:1rem] sm:[--wl-gutter:1.5rem]',
        sidebar ? 'lg:grid lg:grid-cols-[15rem_1fr]' : 'flex flex-col',
        holder && 'wl-portal',
      )}
    >
      {sidebar ? (
        <div className="hidden border-r border-border bg-surface-raised lg:block">{sidebar}</div>
      ) : null}
      {column}
    </div>
  );
}
