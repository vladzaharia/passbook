import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { isOrgScoped } from '../lib/nav.ts';
import { useOrgScope } from '../lib/org-filter.tsx';
import { Button } from './button.tsx';

/** The slice of a TanStack useInfiniteQuery result that cursor paging needs. */
interface CursorPages {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError?: boolean;
  fetchNextPage: () => Promise<unknown>;
}

export interface LoadMoreProps {
  /**
   * A cursor-paged list: pass the useInfiniteQuery result. Load more fetches the next page; a
   * failed page shows "Could not load more." and the button retries.
   */
  query?: CursorPages;
  /** Without `query`: the same, by hand. A list that fits one page passes neither. */
  hasMore?: boolean;
  loading?: boolean;
  onLoadMore?: () => void;
  shown?: number;
  /** Singular and plural: ['pass', 'passes']. */
  noun?: readonly [string, string];
  /** Append the top-bar org scope: "19 passes in Northwind". */
  scoped?: boolean;
}

function ScopeName() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const scope = useOrgScope();
  const name =
    isOrgScoped(pathname) && !scope.isLoading && !scope.isError
      ? scope.membership?.orgName
      : undefined;
  return name ? <> in {name}</> : null;
}

/**
 * The list footer: "<n> <noun>" left, Load more right. Cursor pagination: no page numbers. After
 * a page lands the new count is announced, and focus that the busy button dropped comes back to
 * it (or to the count, when that was the last page) instead of the top of the document.
 */
export function LoadMore({
  query,
  hasMore = query?.hasNextPage ?? false,
  loading = query?.isFetchingNextPage ?? false,
  onLoadMore = () => void query?.fetchNextPage(),
  shown,
  noun = ['item', 'items'],
  scoped,
}: LoadMoreProps) {
  const count = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // A page the user asked for: set on click, settled once loading has come and gone.
  const asked = useRef<'no' | 'asked' | 'loading'>('no');
  const [announced, setAnnounced] = useState('');
  const failed = Boolean(query?.isFetchNextPageError) && !loading;
  const label = shown === undefined ? null : `${shown} ${shown === 1 ? noun[0] : noun[1]}`;
  useEffect(() => {
    if (loading) {
      if (asked.current === 'asked') asked.current = 'loading';
      return;
    }
    if (asked.current !== 'loading') return;
    asked.current = 'no';
    setAnnounced(failed ? 'Could not load more.' : (label ?? ''));
    // A busy button drops focus; give it back without jumping to the top of the page.
    if (document.activeElement === document.body) (button.current ?? count.current)?.focus();
  }, [loading, failed, label]);
  if (!hasMore && !shown) return null;
  return (
    <div className="flex items-center justify-between gap-3 pt-3 text-sm text-fg-muted">
      <span ref={count} tabIndex={-1} className="tabular-nums outline-none">
        {label}
        {label && scoped ? <ScopeName /> : null}
        {failed ? <span className="text-danger"> Could not load more.</span> : null}
      </span>
      <span role="status" className="sr-only">
        {announced}
      </span>
      {hasMore ? (
        <Button
          ref={button}
          variant="outline"
          size="sm"
          loading={loading}
          onClick={() => {
            asked.current = 'asked';
            onLoadMore();
          }}
        >
          {failed ? 'Try again' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
}
