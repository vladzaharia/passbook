import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../../lib/cn.ts';
import type { TreeRow as Row } from './tree-model.ts';
import type { RowState } from './tree-row.tsx';
import { TreeRow } from './tree-row.tsx';
import { useTreeKeys } from './use-tree-keys.ts';

/** Above this many visible rows only the ones in view are drawn. */
const VIRTUAL_ABOVE = 500;
const OVERSCAN = 12;
const VIEW_ROWS = 14;

const rowHeight = () =>
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 44 : 36;

export interface ResponseTreeProps {
  label: string;
  rows: readonly Row[];
  open: ReadonlySet<string>;
  setOpen: (pointer: string, open: boolean) => void;
  focus: string;
  setFocus: (pointer: string) => void;
  selected: string | null;
  roles: ReadonlyMap<string, string[]>;
  suggested: ReadonlySet<string>;
  found: string | null;
  /** A click or Enter on a node. */
  onPick: (row: Row) => void;
  /** Shift+F10: to the node's actions. */
  onActions: (row: Row) => void;
}

/** A WAI-ARIA tree of the sampled response: roving tabindex, virtualized when long. */
export function ResponseTree(p: ResponseTreeProps) {
  const box = useRef<HTMLDivElement>(null);
  const inside = useRef(false);
  const [top, setTop] = useState(0);
  const virtual = p.rows.length > VIRTUAL_ABOVE;
  const h = useMemo(rowHeight, []);
  const focusAt = Math.max(
    0,
    p.rows.findIndex((r) => r.pointer === p.focus),
  );

  const onKeyDown = useTreeKeys({
    rows: p.rows,
    focus: p.focus,
    open: p.open,
    setFocus: p.setFocus,
    setOpen: p.setOpen,
    activate: p.onPick,
    actions: p.onActions,
  });

  // Keys move the focus ring: the matching row takes DOM focus when the tree already has it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run when the focused row changes
  useEffect(() => {
    if (!inside.current) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-row="${focusAt}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [p.focus, focusAt]);

  const first = virtual ? Math.max(0, Math.floor(top / h) - OVERSCAN) : 0;
  const last = virtual ? Math.min(p.rows.length, first + VIEW_ROWS + 2 * OVERSCAN) : p.rows.length;
  const drawn: number[] = [];
  for (let i = first; i < last; i++) drawn.push(i);
  if (virtual && (focusAt < first || focusAt >= last)) drawn.push(focusAt);

  return (
    <div
      ref={box}
      role="tree"
      aria-label={p.label}
      aria-multiselectable="true"
      className={cn('rx-tree', virtual && 'rx-tree-virtual')}
      onKeyDown={onKeyDown}
      onFocus={() => {
        inside.current = true;
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) inside.current = false;
      }}
      onScroll={virtual ? (e) => setTop(e.currentTarget.scrollTop) : undefined}
    >
      <div style={virtual ? { height: p.rows.length * h, position: 'relative' } : undefined}>
        {drawn.map((i) => {
          const row = p.rows[i];
          if (!row) return null;
          const state: RowState = {
            open: p.open.has(row.pointer),
            focused: i === focusAt,
            selected: p.selected === row.pointer,
            roles: p.roles.get(row.pointer) ?? [],
            suggested: p.suggested.has(row.pointer),
            found: p.found === row.pointer,
          };
          return (
            <TreeRow
              key={row.pointer}
              row={row}
              state={state}
              index={i}
              style={
                virtual
                  ? { position: 'absolute', top: i * h, height: h, left: 0, right: 0 }
                  : undefined
              }
              onClick={p.onPick}
              onToggle={(r) => p.setOpen(r.pointer, !p.open.has(r.pointer))}
              onFocus={(r) => p.setFocus(r.pointer)}
            />
          );
        })}
      </div>
    </div>
  );
}
