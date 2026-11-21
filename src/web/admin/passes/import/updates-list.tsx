import { ArrowRight } from 'lucide-react';
import { type CSSProperties, useEffect, useState } from 'react';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { Badge, Button, Skeleton } from '../../../ui/index.ts';
import { useCheckRows } from './api-run.ts';

const FIRST = 4;

/** Per-pass diffs of the updates: the field, what it was, what it becomes. */
export function UpdatesList({ id, orgId, total }: { id: string; orgId: string; total: number }) {
  const rows = useCheckRows(id, orgId, total > 0);
  const [all, setAll] = useState(false);
  const updates = (rows.data?.pages ?? [])
    .flatMap((p) => p.items)
    .filter((r) => r.action === 'update');
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = rows;
  const want = all ? total : FIRST;
  useEffect(() => {
    if (updates.length < want && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [updates.length, want, hasNextPage, isFetchingNextPage, fetchNextPage]);
  if (total === 0) return null;
  if (rows.isPending) return <Skeleton className="m-4 h-24" />;
  const shown = all ? updates : updates.slice(0, FIRST);
  return (
    <div>
      <ul className="wl-stagger divide-y divide-border">
        {shown.map((r, i) => (
          <li
            key={r.row}
            style={{ '--i': i } as CSSProperties}
            className="grid items-start gap-x-6 gap-y-2 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:px-6"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-fg-strong">
                {r.externalId ?? C.match.row(r.row)}
              </p>
              <p className="text-xs text-fg-muted">{C.match.row(r.row)}</p>
            </div>
            <ul className="flex min-w-0 flex-col gap-1.5">
              {(r.changes ?? []).map((c) => (
                <li
                  key={c.key}
                  className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] items-baseline gap-3 text-sm"
                >
                  <span className="truncate text-fg-muted">{c.label}</span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                    <s className="text-fg-muted">{c.from ?? C.check.empty}</s>
                    <ArrowRight aria-hidden className="size-3.5 text-fg-muted" />
                    <span className="rounded bg-success-subtle px-1.5 font-medium text-fg-strong">
                      {c.to ?? C.check.empty}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            {r.changes?.length ? (
              <Badge tone="info" className="justify-self-start">
                {C.check.fieldsChanged(r.changes.length)}
              </Badge>
            ) : null}
          </li>
        ))}
      </ul>
      {!all && total > FIRST ? (
        <div className="border-t border-border px-4 py-3 sm:px-6">
          <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
            {C.check.showAllN(total)}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
