import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/cn.ts';
import { Badge } from '../../../ui/index.ts';
import type { TreeRow as Row } from './tree-model.ts';

export interface RowState {
  open: boolean;
  focused: boolean;
  /** The node the selection pane shows. */
  selected: boolean;
  /** Roles this node has been picked for. */
  roles: readonly string[];
  /** Detected but not picked. */
  suggested: boolean;
  /** Plays the one-shot "found it" on this node. */
  found: boolean;
}

export const KIND_CLASS: Record<Row['kind'], string> = {
  string: 'text-success',
  number: 'text-info',
  boolean: 'text-warning',
  null: 'text-fg-muted',
  object: 'text-fg-muted',
  array: 'text-fg-muted',
};

export function TreeRow({
  row,
  state,
  index,
  style,
  onClick,
  onToggle,
  onFocus,
}: {
  row: Row;
  state: RowState;
  index: number;
  style?: React.CSSProperties | undefined;
  onClick: (row: Row) => void;
  onToggle: (row: Row) => void;
  onFocus: (row: Row) => void;
}) {
  const picked = state.roles.length > 0;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the tree container handles the keys (roving focus)
    <div
      role="treeitem"
      tabIndex={state.focused ? 0 : -1}
      aria-level={row.depth}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-expanded={row.expandable ? state.open : undefined}
      aria-selected={picked || state.selected}
      aria-label={`${row.key}, ${row.preview}${state.roles.length ? `, ${state.roles.join(', ')}` : ''}`}
      data-row={index}
      data-picked={picked ? '' : undefined}
      data-selected={state.selected ? '' : undefined}
      data-found={state.found ? '' : undefined}
      className="rx-row"
      style={{ ...style, paddingInlineStart: `${(row.depth - 1) * 1.1 + 0.25}rem` }}
      onClick={() => onClick(row)}
      onFocus={() => onFocus(row)}
    >
      <span
        aria-hidden
        className={cn('rx-chev', !row.expandable && 'invisible', state.open && 'rx-chev-open')}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(row);
        }}
      >
        <ChevronRight className="size-4" />
      </span>
      <span className="rx-key">{row.key}</span>
      <span className={cn('rx-val', KIND_CLASS[row.kind])} aria-hidden>
        {row.kind === 'array' && row.total !== undefined && row.total > row.count
          ? `[] ${row.count} of ${row.total}`
          : row.preview}
      </span>
      {state.roles.map((r) => (
        <Badge key={r} tone="accent" className="rx-role" aria-hidden>
          {r}
        </Badge>
      ))}
      {state.suggested && !picked ? (
        <span className="rx-suggest" aria-hidden>
          suggested
        </span>
      ) : null}
    </div>
  );
}
