import type { ColumnDef } from '@tanstack/react-table';
import { type ReactNode, useRef } from 'react';

type Render = (props: never) => ReactNode;

function columnKey<T>(column: ColumnDef<T, never>, index: number): string {
  return column.id ?? ('accessorKey' in column ? String(column.accessorKey) : String(index));
}

/**
 * flexRender mounts a cell or header function as a component, so one rebuilt on every render
 * (columns declared in the page body) would remount every cell: focus, open menus and animations
 * reset. Each column gets one forwarding function that calls its latest definition.
 */
export function useStableColumns<T>(columns: ColumnDef<T, never>[]): ColumnDef<T>[] {
  const latest = useRef(columns);
  latest.current = columns;
  const forwards = useRef(new Map<string, Render>());
  return columns.map((column, index) => {
    const key = columnKey(column, index);
    const stable: Partial<Record<'cell' | 'header', Render>> = {};
    for (const part of ['cell', 'header'] as const) {
      if (typeof column[part] !== 'function') continue;
      const id = `${key}:${part}`;
      let forward = forwards.current.get(id);
      if (!forward) {
        forward = (props: never) => {
          const current = latest.current.find((c, i) => columnKey(c, i) === key) ?? column;
          const render = current[part] as Render | undefined;
          return typeof render === 'function' ? render(props) : null;
        };
        forwards.current.set(id, forward);
      }
      stable[part] = forward;
    }
    return { ...column, ...stable } as ColumnDef<T>;
  });
}
