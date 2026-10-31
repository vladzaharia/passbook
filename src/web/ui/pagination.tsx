import { Button } from './button.tsx';

export interface LoadMoreProps {
  hasMore: boolean;
  loading?: boolean;
  onLoadMore: () => void;
  shown?: number;
}

/** Cursor pagination: the API returns nextCursor, never page numbers. */
export function LoadMore({ hasMore, loading, onLoadMore, shown }: LoadMoreProps) {
  if (!hasMore && shown === undefined) return null;
  return (
    <div className="flex items-center justify-between gap-3 pt-3 text-sm text-fg-muted">
      <span>{shown === undefined ? '' : `${shown} shown${hasMore ? '' : ' (all)'}`}</span>
      {hasMore ? (
        <Button variant="outline" size="sm" loading={loading} onClick={onLoadMore}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}
