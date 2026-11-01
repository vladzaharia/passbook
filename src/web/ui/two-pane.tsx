import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

export interface TwoPaneProps {
  children: ReactNode;
  /** 20rem column: summary, counts, danger actions, live preview. */
  aside: ReactNode;
  /** Where the aside moves beside the main column: xl (1280, detail pages) or lg (1024, wizards). */
  asideFrom?: 'lg' | 'xl';
  /** The aside sticks below the top bar while the main column scrolls. */
  stickyAside?: boolean;
  /** The aside's landmark name; the shell's sidebar is another complementary landmark. */
  asideLabel?: string;
  className?: string;
}

/** A main column plus a 20rem aside; stacked below the breakpoint (aside after the main column). */
export function TwoPane({
  children,
  aside,
  asideFrom = 'xl',
  stickyAside,
  asideLabel = 'Summary',
  className,
}: TwoPaneProps) {
  return (
    <div
      className={cn(
        'grid min-w-0 gap-6',
        asideFrom === 'lg'
          ? 'lg:grid-cols-[minmax(0,1fr)_20rem]'
          : 'xl:grid-cols-[minmax(0,1fr)_20rem]',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
      <aside
        aria-label={asideLabel}
        className={cn(
          'flex min-w-0 flex-col gap-6',
          stickyAside &&
            (asideFrom === 'lg'
              ? 'lg:sticky lg:top-[calc(5rem+env(safe-area-inset-top))] lg:self-start'
              : 'xl:sticky xl:top-[calc(5rem+env(safe-area-inset-top))] xl:self-start'),
        )}
      >
        {aside}
      </aside>
    </div>
  );
}
