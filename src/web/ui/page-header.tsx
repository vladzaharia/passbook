import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { cn } from '../lib/cn.ts';

export interface Crumb {
  label: string;
  /** Route path; omit for the current page. */
  to?: string;
}

export function Breadcrumbs({ items, className }: { items: readonly Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-1 text-xs text-fg-muted">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={item.to ?? item.label} className="flex items-center gap-1">
              {item.to && !last ? (
                <Link
                  to={item.to as never}
                  className="inline-flex min-h-6 items-center rounded-sm hover:text-fg-strong hover:underline"
                >
                  {item.label}
                </Link>
              ) : (
                <span aria-current={last ? 'page' : undefined}>{item.label}</span>
              )}
              {last ? null : <ChevronRight aria-hidden className="size-3" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export type PageWidth = 'full' | 'detail';

/** One width per page type (docs/design/ui-consistency.md): detail and form pages use max-w-3xl. */
export const PAGE_WIDTH: Record<PageWidth, string> = {
  full: '',
  detail: 'max-w-3xl',
};

/** Wraps a page's blocks (tab panels included) to the page type's width. */
export function PageBody({
  width = 'detail',
  className,
  children,
}: {
  width?: PageWidth;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-6', PAGE_WIDTH[width], className)}>
      {children}
    </div>
  );
}

export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  breadcrumbs?: readonly Crumb[];
  /** Pills, then version or connector; sits under the title. */
  meta?: ReactNode;
  /** At most three visible; the rest go in a More menu. */
  actions?: ReactNode;
  /** Match the page body so actions sit next to the content they act on. */
  width?: PageWidth;
  className?: string;
}

/** The page h1. Route changes move focus here (see lib/route-focus.tsx). */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  meta,
  actions,
  width = 'full',
  className,
}: PageHeaderProps) {
  useEffect(() => {
    document.title = `${title} · Wallet`;
  }, [title]);
  return (
    <header className={cn('mb-6 flex min-w-0 flex-col gap-3', PAGE_WIDTH[width], className)}>
      {breadcrumbs?.length ? <Breadcrumbs items={breadcrumbs} /> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 tabIndex={-1} className="text-2xl font-semibold text-fg-strong">
            {title}
          </h1>
          {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
          {meta ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
              {meta}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 max-sm:w-full">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
