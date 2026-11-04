import type { ReactNode } from 'react';
import type { ImageView } from '../../shared/pass-view/index.ts';
import type { PassHeading } from './add/heading.ts';

export interface HolderHeadingProps {
  heading: PassHeading;
  /** The pass's icon: a square drawn for Wallet's notifications, the org's mark here. */
  icon?: ImageView | undefined;
  /** The portal's breadcrumbs (router links); /p has none. */
  crumbs?: ReactNode;
  /** The state a pass cannot be added in (Voided, Expired) and the last update. */
  meta?: ReactNode;
  /** Refresh and More in the portal; /p's way to My passes. */
  actions?: ReactNode;
}

/**
 * The pass page's header, one for the portal and /p (SSR-safe): the org's mark and name over what
 * the pass is (the h1); the holder's name stays a field. The actions end the row at its right, or
 * wrap under the title on a phone.
 */
export function HolderHeading({ heading, icon, crumbs, meta, actions }: HolderHeadingProps) {
  const split = heading.kind !== null && heading.org !== '';
  return (
    <header className="wl-hh mb-6 flex min-w-0 flex-col gap-3">
      {crumbs}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-start gap-3.5">
          {icon ? <img src={icon.src} srcSet={icon.srcset} alt="" className="wl-hh-icon" /> : null}
          <div className="min-w-0">
            {split ? (
              <p className="truncate text-sm font-medium text-fg-muted">{heading.org}</p>
            ) : null}
            <h1
              tabIndex={-1}
              className="text-2xl font-semibold tracking-[-0.015em] text-fg-strong [overflow-wrap:anywhere]"
            >
              {split ? heading.kind : heading.title}
            </h1>
            {meta ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-muted">
                {meta}
              </div>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex items-center gap-2 max-sm:w-full">{actions}</div> : null}
      </div>
    </header>
  );
}
