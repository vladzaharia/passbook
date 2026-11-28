import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { useDocumentTitle } from '../lib/route-focus.tsx';
import { useScopeCrumb } from '../lib/scope-context.ts';

export interface Crumb {
  label: string;
  /** Route path; omit for the current page. */
  to?: string;
  /** Optional query parameters for the destination. */
  search?: Record<string, unknown>;
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
                  to={item.to}
                  search={item.search}
                  className="inline-flex min-h-6 items-center rounded-sm hover:text-fg-strong hover:underline pointer-coarse:min-h-11 pointer-coarse:min-w-11"
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

export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  breadcrumbs?: readonly Crumb[];
  /** Pills, then version or connector; sits under the title. */
  meta?: ReactNode;
  /** At most three visible; the rest go in a More menu. */
  actions?: ReactNode;
  /** A 40 px EntityAvatar left of the h1 (users, orgs). */
  avatar?: ReactNode;
  className?: string;
}

/** An email as a title may wrap after its @, so the domain stays whole. */
function breakAfterAt(title: string) {
  const at = title.indexOf('@');
  if (at < 1 || title.includes(' ')) return title;
  return (
    <>
      {title.slice(0, at + 1)}
      <wbr />
      {title.slice(at + 1)}
    </>
  );
}

/**
 * The page h1 and the tab title. Route changes move focus here (lib/route-focus.tsx). Pages use the
 * full main width; blocks cap their own (FormGrid, prose, dialogs).
 */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  meta,
  actions,
  avatar,
  className,
}: PageHeaderProps) {
  useDocumentTitle(title);
  // Detail pages lead with the console scope: Northwind › Templates › Spring.
  const root = useScopeCrumb();
  const crumbs =
    breadcrumbs?.length && root && breadcrumbs[0]?.label !== root.label
      ? [root, ...breadcrumbs]
      : breadcrumbs;
  return (
    <header className={cn('mb-6 flex min-w-0 flex-col gap-3', className)}>
      {crumbs?.length ? <Breadcrumbs items={crumbs} /> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {avatar}
          <div className="min-w-0">
            <h1 tabIndex={-1} className="text-2xl font-semibold tracking-[-0.015em] text-fg-strong">
              {breakAfterAt(title)}
            </h1>
            {description ? (
              <p className="mt-1 max-w-[65ch] text-sm text-fg-muted">{description}</p>
            ) : null}
            {meta ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
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
