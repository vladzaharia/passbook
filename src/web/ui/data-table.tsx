import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type OnChangeFn,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { SkeletonRows } from './skeleton.tsx';

declare module '@tanstack/react-table' {
  interface ColumnMeta<TData, TValue> {
    /** Hide the column below this breakpoint. */
    hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
    /** Keep the cell on one line and truncate it (set a title in the cell). */
    nowrap?: boolean;
    /** Right-align numbers. */
    numeric?: boolean;
    /** Leave the column out of the stacked (below md) layout. */
    stackHidden?: boolean;
  }
}

const HIDE_BELOW = {
  sm: 'max-sm:hidden',
  md: 'max-md:hidden',
  lg: 'max-lg:hidden',
  xl: 'max-xl:hidden',
} as const;

export interface DataTableProps<T> {
  columns: ColumnDef<T, never>[];
  data: readonly T[];
  caption: string;
  getRowId?: (row: T) => string;
  /** Controlled sorting keeps the sort in the URL. */
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  /** True when the server sorts; the table then shows rows as given. */
  manualSorting?: boolean;
  loading?: boolean;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  /** Rows are rendered as a window of this scroll height. Needed above ~200 rows. */
  virtualHeight?: number;
  rowHeight?: number;
  className?: string;
  /** Inside a card: no border or radius of its own. */
  bare?: boolean;
  /**
   * Below md, render rows as stacked blocks (first column is the title, other columns
   * become label and value lines). Turn off for wide record tables that scroll instead.
   */
  stack?: boolean;
}

function SortIcon({ dir }: { dir: false | 'asc' | 'desc' }) {
  if (dir === 'asc') return <ArrowUp aria-hidden className="size-3.5" />;
  if (dir === 'desc') return <ArrowDown aria-hidden className="size-3.5" />;
  return <ArrowUpDown aria-hidden className="size-3.5 opacity-50" />;
}

/** True below md. Only one layout is mounted so links and roles are not duplicated. */
function useNarrow(): boolean {
  const query = '(max-width: 767.98px)';
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function DataTable<T>({
  columns,
  data,
  caption,
  getRowId,
  sorting,
  onSortingChange,
  manualSorting,
  loading,
  empty,
  onRowClick,
  virtualHeight,
  rowHeight = 44,
  className,
  bare,
  stack = true,
}: DataTableProps<T>) {
  const narrow = useNarrow() && stack;
  const table = useReactTable<T>({
    data: data as T[],
    columns: columns as ColumnDef<T>[],
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
    // Undefined options would override TanStack's internal state handling, so spread conditionally.
    ...(sorting ? { state: { sorting } } : {}),
    ...(onSortingChange ? { onSortingChange } : {}),
    manualSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: manualSorting ? undefined : getSortedRowModel(),
  });
  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade((f) => (f.start === start && f.end === end ? f : { start, end }));
  }, []);
  useEffect(() => {
    measure();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measure]);
  const virtualizer = useVirtualizer({
    count: virtualHeight ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });

  if (loading && data.length === 0) return <SkeletonRows label={`Loading ${caption}`} />;
  if (data.length === 0 && empty) return <>{empty}</>;

  const virtual = virtualHeight ? virtualizer.getVirtualItems() : null;
  const visible = virtual ? virtual.map((v) => rows[v.index]!) : rows;
  const padTop = virtual?.length ? virtual[0]!.start : 0;
  const padBottom = virtual?.length
    ? virtualizer.getTotalSize() - virtual[virtual.length - 1]!.end
    : 0;
  const span = table.getVisibleLeafColumns().length;

  const metaOf = (c: { columnDef: { meta?: unknown } }) =>
    (c.columnDef.meta ?? {}) as NonNullable<ColumnDef<T>['meta']>;
  const stackCols = table.getVisibleLeafColumns().filter((c) => !metaOf(c).stackHidden);
  const [titleCol, ...restCols] = stackCols;
  const frame = bare ? '' : 'rounded-lg border border-border';

  return (
    <>
      {narrow && titleCol ? (
        <ul
          aria-label={caption}
          className={cn('divide-y divide-border md:hidden', frame, className)}
        >
          {rows.map((row) => {
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
                className={cn(
                  'flex items-start gap-3 px-4 py-3',
                  onRowClick && 'cursor-pointer active:bg-state-hover-tint',
                )}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="min-w-0 text-sm">{render(titleCol.id)}</div>
                  {lines.map((c) => (
                    <div key={c.id} className="flex min-w-0 items-baseline gap-2 text-xs">
                      <span className="w-20 shrink-0 text-fg-muted">
                        {c.columnDef.header as string}
                      </span>
                      <span className="min-w-0 text-fg">{render(c.id)}</span>
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
      ) : null}
      <div className={cn('relative min-w-0', narrow && titleCol && 'hidden', className)}>
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
                'bg-surface-raised',
                virtualHeight && 'sticky top-0 z-10 shadow-[0_1px_0_var(--pk-border-subtle)]',
              )}
            >
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id} className="border-b border-border">
                  {group.headers.map((header) => {
                    const sortable = header.column.getCanSort();
                    const dir = header.column.getIsSorted();
                    const meta = metaOf(header.column);
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={
                          dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined
                        }
                        className={cn(
                          'h-10 px-3 font-medium whitespace-nowrap text-fg-muted',
                          meta.numeric && 'text-right',
                          meta.hideBelow && HIDE_BELOW[meta.hideBelow],
                        )}
                      >
                        {header.isPlaceholder ? null : sortable ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className="-mx-1 inline-flex min-h-6 items-center gap-1 rounded-sm px-1 hover:text-fg-strong"
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            <SortIcon dir={dir} />
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {padTop > 0 ? (
                <tr aria-hidden>
                  <td colSpan={span} style={{ height: padTop }} />
                </tr>
              ) : null}
              {visible.map((row) => (
                <tr
                  key={row.id}
                  style={virtualHeight ? { height: rowHeight } : undefined}
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
                          'px-3 py-2 align-middle text-fg',
                          (meta.nowrap || !stack) && 'whitespace-nowrap',
                          meta.nowrap && 'max-w-56 truncate',
                          meta.numeric && 'text-right tabular-nums',
                          meta.hideBelow && HIDE_BELOW[meta.hideBelow],
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              ))}
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
    </>
  );
}

function EdgeFade({ side, show }: { side: 'start' | 'end'; show: boolean }) {
  if (!show) return null;
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-y-px w-8 from-surface-raised to-transparent',
        side === 'start'
          ? 'left-px rounded-l-lg bg-gradient-to-r'
          : 'right-px rounded-r-lg bg-gradient-to-l',
      )}
    />
  );
}
