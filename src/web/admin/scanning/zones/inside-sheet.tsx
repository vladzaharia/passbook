import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { UserRoundX } from 'lucide-react';
import { useState } from 'react';
import type { ScanInsideRow } from '@/shared/contracts/scan-occupancy.ts';
import { markOutConfirm } from '@/web/lib/confirms.ts';
import { formatDateTime } from '@/web/lib/format.ts';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Sheet,
  SheetContent,
  Skeleton,
  toast,
} from '@/web/ui/index.ts';
import type { InsideApi } from './inside-api.ts';

const FLAG = { long_stay: 'Long stay', pass_ended: 'Pass ended' } as const;

/** Who is inside one zone, with Mark as out. Opens only when the console has an inside API. */
export function InsideSheet({
  api,
  zoneId,
  zoneName,
  canManage,
  onClose,
}: {
  api: InsideApi;
  zoneId: string;
  zoneName: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const place = `zone:${zoneId}`;
  const client = useQueryClient();
  const key = ['admin', 'scanning', 'zones', 'inside', zoneId] as const;
  const [out, setOut] = useState<ScanInsideRow>();
  const inside = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.list(place, pageParam),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });
  const rows = inside.data?.pages.flatMap((p) => p.items) ?? [];
  const total = inside.data?.pages[0]?.total ?? 0;
  return (
    <>
      <Sheet open onOpenChange={(open) => !open && onClose()}>
        <SheetContent title={`Inside ${zoneName}`} className="sm:w-[480px]">
          <div className="grid gap-4 p-4">
            {inside.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : inside.isError ? (
              <ErrorState
                inline
                subject="who is inside"
                error={inside.error}
                onRetry={() => inside.refetch()}
              />
            ) : rows.length === 0 ? (
              <EmptyState inline art="building" title="Nobody inside" />
            ) : (
              <>
                <p role="status" className="text-sm text-fg-muted">
                  {total} inside now.
                </p>
                <table className="w-full text-sm">
                  <caption className="sr-only">People inside {zoneName}</caption>
                  <thead className="sr-only">
                    <tr>
                      <th scope="col">Holder</th>
                      <th scope="col">Since</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((row) => (
                      <tr key={row.passId}>
                        <th scope="row" className="py-3 pr-2 text-left font-medium text-fg-strong">
                          {row.holder ?? 'No holder'}
                          <span className="block text-xs font-normal text-fg-muted">
                            Since {formatDateTime(row.since)}
                            {row.flags.map((f) => ` · ${FLAG[f]}`).join('')}
                          </span>
                        </th>
                        <td className="py-3 text-right">
                          {canManage ? (
                            <Button
                              variant="outline"
                              size="sm"
                              iconStart={<UserRoundX aria-hidden />}
                              onClick={() => setOut(row)}
                            >
                              Mark as out
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {inside.hasNextPage ? (
                  <Button
                    variant="ghost"
                    loading={inside.isFetchingNextPage}
                    onClick={() => void inside.fetchNextPage()}
                  >
                    Load more
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
      {out ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setOut(undefined)}
          {...markOutConfirm(out.holder ?? 'this pass', zoneName)}
          onConfirm={async () => {
            await api.markOut(out.passId, place);
            toast.success('Marked as out');
            await client.invalidateQueries({ queryKey: key });
          }}
        />
      ) : null}
    </>
  );
}
