import { useOrgScope } from '../lib/org-filter.tsx';
import { useOrgOptions } from '../lib/search.ts';
import { Button } from './button.tsx';

export interface LoadMoreProps {
  hasMore: boolean;
  loading?: boolean;
  onLoadMore: () => void;
  shown?: number;
  /** Singular and plural: ['pass', 'passes']. */
  noun?: readonly [string, string];
  /** Append the top-bar org scope: "19 passes in Northwind". */
  scoped?: boolean;
}

function ScopeName() {
  const { orgId } = useOrgScope();
  const { data } = useOrgOptions(Boolean(orgId));
  const name = orgId ? data?.items.find((o) => o.id === orgId)?.name : undefined;
  return name ? <> in {name}</> : null;
}

/** The list footer: "<n> <noun>" left, Load more right. Cursor pagination: no page numbers. */
export function LoadMore({
  hasMore,
  loading,
  onLoadMore,
  shown,
  noun = ['item', 'items'],
  scoped,
}: LoadMoreProps) {
  if (!hasMore && !shown) return null;
  return (
    <div className="flex items-center justify-between gap-3 pt-3 text-sm text-fg-muted">
      <span className="tabular-nums">
        {shown === undefined ? null : (
          <>
            {shown} {shown === 1 ? noun[0] : noun[1]}
            {scoped ? <ScopeName /> : null}
          </>
        )}
      </span>
      {hasMore ? (
        <Button variant="outline" size="sm" loading={loading} onClick={onLoadMore}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}
