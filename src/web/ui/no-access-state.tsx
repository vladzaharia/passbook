import type { ReactNode } from 'react';
import { EmptyState } from './empty-state.tsx';

/**
 * A place this person cannot open here, said once: the lock, one line, the nearest way on. Never a
 * 403 page and never a disabled control (design §6). On the stage surface, so it reads as the
 * tool's own canvas rather than an error.
 */
export function NoAccessState({
  title,
  description,
  actions,
  heading = false,
}: {
  title: string;
  description?: ReactNode;
  /** Outline buttons: the nearest allowed place first, then the way out. */
  actions?: ReactNode;
  /** The page's h1 (a deep link that lands here). */
  heading?: boolean;
}) {
  return (
    <EmptyState
      art="lock"
      mood="curious"
      surface="stage"
      heading={heading}
      title={title}
      description={description}
      action={
        actions ? (
          <div className="flex flex-wrap justify-center gap-2 max-sm:flex-col">{actions}</div>
        ) : undefined
      }
    />
  );
}
