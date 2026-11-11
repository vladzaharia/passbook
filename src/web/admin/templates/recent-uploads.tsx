import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn.ts';
import { formatDateTime } from '../../lib/format.ts';
import { Card, CardHeader, ListRow, ListRows, StatusPill } from '../../ui/index.ts';
import { useRecentUploads } from './api.ts';

const STATUS: Record<string, string> = {
  complete: 'complete',
  errored: 'failed',
  terminated: 'failed',
  running: 'processing',
  queued: 'processing',
};

const DAY = 86_400_000;

/** A failed or running import from the last day: the strip leads the page until it settles. */
export function uploadsNeedAttention(
  items: readonly { status: string; createdAt: number }[],
  now: number,
): boolean {
  return items.some(
    (u) =>
      now - u.createdAt < DAY &&
      (STATUS[u.status] === 'failed' || STATUS[u.status] === 'processing'),
  );
}

/** The last five imports: name, outcome, time and a link to the report. */
export function RecentUploads({
  orgId,
  className,
}: {
  orgId: string | undefined;
  className?: string;
}) {
  const uploads = useRecentUploads(orgId);
  const items = uploads.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Card className={cn('mt-6', className)}>
      <CardHeader title="Recent uploads" />
      <div className="px-4 py-3">
        <ListRows label="Recent uploads">
          {items.map((u) => (
            <ListRow
              key={u.uploadId}
              rowId={u.uploadId}
              title={u.name ?? 'Untitled package'}
              pills={<StatusPill status={STATUS[u.status] ?? u.status} />}
              meta={formatDateTime(u.createdAt)}
              trailing={
                <Link
                  to="/admin/templates/upload"
                  search={{ upload: u.uploadId, orgId }}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-sm text-fg pointer-coarse:min-h-11 hover:bg-state-hover-tint hover:text-fg-strong"
                >
                  Report
                  <ChevronRight aria-hidden className="size-4" />
                </Link>
              }
            />
          ))}
        </ListRows>
      </div>
    </Card>
  );
}
