import type { ReactNode } from 'react';
import type { ImageView } from '../../../shared/pass-view/index.ts';
import type { PassHeading } from './heading.ts';

export interface HolderHeadingProps {
  heading: PassHeading;
  /**
   * title: the pass's icon, then the whole title on one line (a). org: the org's name over the
   * kind, the icon small beside the name (b, c).
   */
  variant: 'title' | 'org';
  icon?: ImageView | undefined;
  /** The portal's breadcrumbs (router links); /p has none. */
  crumbs?: ReactNode;
  /** Status and the last update, under the h1. */
  meta?: ReactNode;
  /** Refresh and More in the portal; /p's way to My passes. */
  actions?: ReactNode;
}

/** The pass's icon as the org's mark: it is square, drawn for Wallet's notifications. */
function Icon({ icon, className }: { icon: ImageView; className: string }) {
  return <img src={icon.src} srcSet={icon.srcset} alt="" className={className} />;
}

/**
 * The pass page's header, SSR-safe (the portal and /p). The h1 says what the pass is; the
 * holder's name stays a field. Actions end at the row's right edge, or wrap under the title.
 */
export function HolderHeading({
  heading,
  variant,
  icon,
  crumbs,
  meta,
  actions,
}: HolderHeadingProps) {
  const split = variant === 'org' && heading.kind !== null;
  return (
    <header className="flex min-w-0 flex-col gap-3">
      {crumbs}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {variant === 'title' && icon ? <Icon icon={icon} className="wl-hh-icon" /> : null}
          <div className="min-w-0">
            {split ? (
              <p className="wl-hh-org flex items-center gap-2 text-sm font-medium text-fg-muted">
                {icon ? <Icon icon={icon} className="wl-hh-icon-sm" /> : null}
                <span className="min-w-0 truncate">{heading.org}</span>
              </p>
            ) : null}
            <h1
              tabIndex={-1}
              className="text-2xl font-semibold tracking-[-0.015em] text-fg-strong [overflow-wrap:anywhere]"
            >
              {split ? heading.kind : heading.title}
            </h1>
            {meta ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-muted">
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
