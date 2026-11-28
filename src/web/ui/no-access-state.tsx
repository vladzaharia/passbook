import type { ReactNode } from 'react';
import { StateView } from './state-view.tsx';

/**
 * A place this person cannot open here, said once: the lock, one line, the nearest way on. Never a
 * 403 page and never a disabled control (design §6). A StateView adapter; slate, not an error.
 */
export function NoAccessState({
  title,
  description,
  actions,
  heading = false,
  titleClassName,
}: {
  title: string;
  description?: ReactNode;
  /** Outline buttons: the nearest allowed place first, then the way out. */
  actions?: ReactNode;
  /** The page's h1 (a deep link that lands here). */
  heading?: boolean;
  titleClassName?: string;
}) {
  return (
    <StateView
      size="stage"
      state="no-access"
      art="lock"
      mood="curious"
      heading={heading}
      titleClassName={titleClassName}
      title={title}
      line={description}
      action={
        actions ? (
          <div className="flex flex-wrap justify-center gap-2 max-sm:flex-col">{actions}</div>
        ) : undefined
      }
    />
  );
}
