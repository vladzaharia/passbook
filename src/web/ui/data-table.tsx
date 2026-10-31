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
import { type ReactNode, useRef } from 'react';
import { cn } from '../lib/cn.ts';
import { SkeletonRows } from './skeleton.tsx';

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
}

function SortIcon({ dir }: { dir: false | 'asc' | 'desc' }) {
  if (dir === 'asc') return <ArrowUp aria-hidden className="size-3.5" />;
  if (dir === 'desc') return <ArrowDown aria-hidden className="size-3.5" />;
  return <ArrowUpDown aria-hidden className="size-3.5 opacity-50" />;
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
}: DataTableProps<T>) {
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

  return (
    <section
      ref={scrollRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region
      tabIndex={0}
      aria-label={caption}
      style={virtualHeight ? { maxHeight: virtualHeight } : undefined}
      className={cn('overflow-auto rounded-lg border border-border', className)}
    >
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-surface-raised">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className="border-b border-border">
              {group.headers.map((header) => {
                const sortable = header.column.getCanSort();
                const dir = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={
                      dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined
                    }
                    className="h-10 px-3 font-medium whitespace-nowrap text-fg-muted"
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
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-3 py-2 align-middle text-fg">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
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
  );
}
