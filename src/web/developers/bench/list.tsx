import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import type { StatusTone } from './status-chip.tsx';
import type { BenchSelection } from './use-selection.ts';
import './list.css';

/** A row's four places: lead (time, method), title (path, event; truncates), meta, trail (status, duration). */
export interface BenchRowParts {
  lead?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trail?: ReactNode;
}

const KEYS: Record<string, 1 | -1 | 'first' | 'last' | 'open'> = {
  ArrowDown: 1,
  j: 1,
  ArrowUp: -1,
  k: -1,
  Home: 'first',
  End: 'last',
  Enter: 'open',
};

/** A DOM id from any item id: the option `aria-activedescendant` points at. */
const optionId = (base: string, id: string) => `${base}-${id.replace(/[^\w-]/g, '_')}`;

function Row({
  base,
  id,
  parts,
  tone,
  selected,
  fresh,
  pinned,
  onPick,
}: {
  base: string;
  id: string;
  parts: BenchRowParts;
  tone: StatusTone;
  selected: boolean;
  fresh: boolean;
  pinned?: boolean;
  onPick: (id: string) => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox takes the keys (one Tab stop, aria-activedescendant)
    <div
      id={optionId(base, id)}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      className="bench-row"
      data-tone={tone}
      data-fresh={fresh || undefined}
      data-pinned={pinned || undefined}
      onClick={() => onPick(id)}
    >
      {parts.lead !== undefined ? <span className="bench-row-lead">{parts.lead}</span> : null}
      <span className="bench-row-title">
        <span className="bench-row-tt">{parts.title}</span>
        {pinned ? <span className="bench-row-pin">{BENCH_COPY.list.pinned}</span> : null}
      </span>
      {parts.meta !== undefined ? <span className="bench-row-meta">{parts.meta}</span> : null}
      {parts.trail !== undefined ? <span className="bench-row-trail">{parts.trail}</span> : null}
    </div>
  );
}

/**
 * The bench's one list: a listbox with one Tab stop, the selection as its active option. ↑ ↓ (or
 * j k), Home and End move it; Enter and a press open the inspector. Each row has a 3 px tick in its
 * status tone. A row id in `fresh` has just arrived (live): it rises in, then glows. Under 560 px of
 * width the rows take two lines. The footer counts and loads more.
 */
export function BenchList<T>({
  label,
  items,
  idOf,
  row,
  tone,
  selection,
  fresh,
  footer,
  empty,
}: {
  label: string;
  items: readonly T[];
  idOf: (item: T) => string;
  row: (item: T) => BenchRowParts;
  tone?: (item: T) => StatusTone;
  selection: BenchSelection<T>;
  fresh?: ReadonlySet<string>;
  footer?: { count: ReactNode; onMore?: () => void; loading?: boolean };
  /** Shown in place of the rows when there are none (a BenchState). */
  empty?: ReactNode;
}) {
  const base = useId().replace(/:/g, '');
  const box = useRef<HTMLDivElement>(null);
  const { selectedId, pinned, select, step } = selection;
  const order = [...(pinned ? [idOf(pinned)] : []), ...items.map(idOf)];

  useEffect(() => {
    if (!selectedId) return;
    const el = document.getElementById(optionId(base, selectedId));
    if (el && 'scrollIntoView' in el) el.scrollIntoView({ block: 'nearest' });
  }, [selectedId, base]);

  const onKey = (e: KeyboardEvent) => {
    const act = KEYS[e.key];
    if (act === undefined || e.metaKey || e.ctrlKey || e.altKey || order.length === 0) return;
    e.preventDefault();
    if (act === 'open') {
      if (selectedId) select(selectedId, { open: true });
    } else if (act === 'first' || act === 'last') {
      const id = act === 'first' ? order[0] : order[order.length - 1];
      if (id) select(id, { open: false });
    } else if (selectedId === null) {
      const first = order[0];
      if (first) select(first, { open: false });
    } else step(act);
  };
  const pick = (id: string) => {
    select(id, { open: true });
    box.current?.focus({ preventScroll: true });
  };

  if (order.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="bench-list">
      <div
        ref={box}
        role="listbox"
        tabIndex={0}
        aria-label={label}
        aria-activedescendant={selectedId ? optionId(base, selectedId) : undefined}
        className="bench-lb"
        onKeyDown={onKey}
      >
        {pinned ? (
          <Row
            base={base}
            id={idOf(pinned)}
            parts={row(pinned)}
            tone={tone?.(pinned) ?? 'neutral'}
            selected={idOf(pinned) === selectedId}
            fresh={false}
            pinned
            onPick={pick}
          />
        ) : null}
        {items.map((item) => {
          const id = idOf(item);
          return (
            <Row
              key={id}
              base={base}
              id={id}
              parts={row(item)}
              tone={tone?.(item) ?? 'neutral'}
              selected={id === selectedId}
              fresh={fresh?.has(id) ?? false}
              onPick={pick}
            />
          );
        })}
      </div>
      {footer ? (
        <div className="bench-list-f">
          <span className="bench-list-n">{footer.count}</span>
          {footer.onMore ? (
            <button
              type="button"
              className="btn outline sm"
              disabled={footer.loading}
              aria-busy={footer.loading || undefined}
              onClick={footer.onMore}
            >
              {BENCH_COPY.list.more}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
