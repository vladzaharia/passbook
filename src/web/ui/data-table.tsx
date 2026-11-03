import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type CSSProperties, Fragment, type ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { BELOW_MD, useMediaQuery } from '../lib/media.ts';
import { useArrivalMode, useInsertHighlight } from '../lib/motion.ts';
import { CARD_SURFACE } from './card.tsx';
import { HIDE_BELOW } from './data-table-meta.ts';
import { EdgeFade, useEdgeFade } from './edge-fade.tsx';
import { LoadingRail, useDelayed } from './loading-rail.tsx';
import { SkeletonRows } from './skeleton.tsx';

export interface DataTableProps<T> {
  columns: ColumnDef<T, never>[];
  data: readonly T[];
  caption: string;
  getRowId?: (row: T) => string;
  /** First load with no rows yet: the skeleton shows. */
  loading?: boolean;
  /** A refetch with rows on screen (filter, refresh): rows dim and the rail runs after 150 ms. */
  fetching?: boolean;
  /** A truly empty list. */
  empty?: ReactNode;
  /** No rows match the filters (FilteredEmpty). */
  emptyFiltered?: ReactNode;
  /** Filters or a search are set, so an empty result shows `emptyFiltered`. */
  filtered?: boolean;
  /** Search and filter row; hidden when the list is truly empty. */
  toolbar?: ReactNode;
  /** Footer (LoadMore); hidden when the list is truly empty. */
  footer?: ReactNode;
  onRowClick?: (row: T) => void;
  /** Rows are rendered as a window of this scroll height. Needed above ~200 rows. */
  virtualHeight?: number;
  rowHeight?: number;
  className?: string;
  /** Inside a card: no border or radius of its own. */
  bare?: boolean;
  /**
   * Below md, render rows as stacked blocks (first column is the title, other columns become label
   * and value lines). Turn off for wide record tables that scroll instead.
   */
  stack?: boolean;
}

/**
 * Lists in server order (no sort controls). The first load staggers in once; refetches keep the
 * rows (keepPreviousData), dim them after 150 ms and run the loading rail. New rows get the insert
 * highlight; rows carry data-row-id for removeWithTransition.
 */
export function DataTable<T>({
  columns,
  data,
  caption,
  getRowId,
  loading,
  fetching,
  empty,
  emptyFiltered,
  filtered,
  toolbar,
  footer,
  onRowClick,
  virtualHeight,
  rowHeight = 44,
  className,
  bare,
  stack = true,
}: DataTableProps<T>) {
  const narrow = useMediaQuery(BELOW_MD) && stack;
  const table = useReactTable<T>({
    data: data as T[],
    columns: columns as ColumnDef<T>[],
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
    getCoreRowModel: getCoreRowModel(),
  });
  const rows = table.getRowModel().rows;
  const { ref: scrollRef, fade, measure } = useEdgeFade();
  const virtualizer = useVirtualizer({
    count: virtualHeight ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });
  const firstLoad = Boolean(loading) && data.length === 0;
  const arrival = useArrivalMode(firstLoad);
  const entering = virtualHeight ? false : arrival;
  const fresh = useInsertHighlight(rows.map((r) => r.id));
  const busy = useDelayed(Boolean(fetching || loading) && data.length > 0, 150);

  if (firstLoad) {
    return (
      <>
        {toolbar}
        <SkeletonRows label={`Loading ${caption}`} />
      </>
    );
  }
  if (data.length === 0) {
    if (filtered && emptyFiltered) {
      return (
        <>
          {toolbar}
          {emptyFiltered}
        </>
      );
    }
    if (empty) return <>{empty}</>;
  }

  const virtual = virtualHeight ? virtualizer.getVirtualItems() : null;
  const visible = virtual ? virtual.map((v) => rows[v.index]).filter((r) => r !== undefined) : rows;
  const first = virtual?.[0];
  const last = virtual?.[virtual.length - 1];
  const padTop = first ? first.start : 0;
  const padBottom = last ? virtualizer.getTotalSize() - last.end : 0;
  const span = table.getVisibleLeafColumns().length;

  const metaOf = (c: { columnDef: { meta?: unknown } }) =>
    (c.columnDef.meta ?? {}) as NonNullable<ColumnDef<T>['meta']>;
  const stackCols = table.getVisibleLeafColumns().filter((c) => !metaOf(c).stackHidden);
  const [titleCol, ...restCols] = stackCols;
  // On its own the table is a card (same surface and shadow); inside one it uses the card's.
  const frame = bare ? '' : CARD_SURFACE;
  const stagger = entering ? 'wl-stagger [--wl-rise:4px]' : undefined;
  const rowState = (id: string, index: number) => ({
    'data-row-id': id,
    'data-new': fresh.has(id) ? '' : undefined,
    style: entering ? ({ '--i': index } as CSSProperties) : undefined,
  });

  return (
    <>
      {toolbar}
      <div aria-busy={busy || undefined} className={cn('relative min-w-0', className)}>
        <LoadingRail show={busy} />
        {narrow && titleCol ? (
          <ul
            aria-label={caption}
            data-quiet={entering === 'quiet' || undefined}
            className={cn('wl-dim divide-y divide-border', stagger, frame)}
          >
            {rows.map((row, index) => {
              const cells = new Map(row.getVisibleCells().map((c) => [c.column.id, c]));
              const render = (id: string) => {
                const cell = cells.get(id);
                return cell ? flexRender(cell.column.columnDef.cell, cell.getContext()) : null;
              };
              const lines = restCols.filter((c) => typeof c.columnDef.header === 'string');
              const actions = restCols.filter((c) => typeof c.columnDef.header !== 'string');
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: pointer shortcut; the title is the link
                <li
                  key={row.id}
                  {...rowState(row.id, index)}
                  className={cn(
                    'flex items-start gap-3 px-4 py-3',
                    onRowClick && 'cursor-pointer active:bg-state-hover-tint',
                  )}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="min-w-0 truncate text-sm">{render(titleCol.id)}</div>
                    {lines.map((c) => (
                      <div key={c.id} className="flex min-w-0 items-baseline gap-2 text-xs">
                        <span className="w-20 shrink-0 text-fg-muted">
                          {c.columnDef.header as string}
                        </span>
                        <span className="min-w-0 truncate text-fg">{render(c.id)}</span>
                      </div>
                    ))}
                  </div>
                  {actions.length ? (
                    <div className="shrink-0">
                      {actions.map((c) => (
                        <Fragment key={c.id}>{render(c.id)}</Fragment>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="relative min-w-0">
            <section
              ref={scrollRef}
              onScroll={measure}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region
              tabIndex={0}
              aria-label={caption}
              style={virtualHeight ? { maxHeight: virtualHeight } : undefined}
              className={cn('relative overflow-auto', frame)}
            >
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">{caption}</caption>
                <thead
                  className={cn(
                    virtualHeight &&
                      'sticky top-0 z-10 bg-surface-raised shadow-[0_1px_0_var(--pk-border-subtle)]',
                  )}
                >
                  {table.getHeaderGroups().map((group) => (
                    <tr key={group.id} className="border-b border-border">
                      {group.headers.map((header) => {
                        const meta = metaOf(header.column);
                        return (
                          <th
                            key={header.id}
                            scope="col"
                            className={cn(
                              'h-10 px-3 font-medium whitespace-nowrap text-fg-muted',
                              meta.numeric && 'text-right',
                              meta.grow && 'w-full',
                              meta.hideBelow && HIDE_BELOW[meta.hideBelow],
                            )}
                          >
                            {header.isPlaceholder
                              ? null
                              : flexRender(header.column.columnDef.header, header.getContext())}
                          </th>
                        );
                      })}
                    </tr>
                  ))}
                </thead>
                <tbody
                  data-quiet={entering === 'quiet' || undefined}
                  className={cn('wl-dim', stagger)}
                >
                  {padTop > 0 ? (
                    <tr aria-hidden>
                      <td colSpan={span} style={{ height: padTop }} />
                    </tr>
                  ) : null}
                  {visible.map((row, index) => {
                    const state = rowState(row.id, index);
                    return (
                      <tr
                        key={row.id}
                        {...state}
                        style={virtualHeight ? { height: rowHeight } : state.style}
                        className={cn(
                          'border-b border-border last:border-b-0 hover:bg-state-hover-tint',
                          onRowClick && 'cursor-pointer',
                        )}
                        onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                      >
                        {row.getVisibleCells().map((cell) => {
                          const meta = metaOf(cell.column);
                          return (
                            <td
                              key={cell.id}
                              className={cn(
                                'h-11 px-3 py-2 align-middle text-fg whitespace-nowrap',
                                meta.nowrap && 'max-w-56 truncate',
                                meta.nowrap === 'wide' && 'xl:max-w-84',
                                meta.numeric && 'text-right tabular-nums',
                                meta.grow && 'w-full',
                                meta.hideBelow && HIDE_BELOW[meta.hideBelow],
                              )}
                            >
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  {padBottom > 0 ? (
                    <tr aria-hidden>
                      <td colSpan={span} style={{ height: padBottom }} />
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </section>
            <EdgeFade side="start" show={fade.start} />
            <EdgeFade side="end" show={fade.end} />
          </div>
        )}
      </div>
      {footer}
    </>
  );
}
