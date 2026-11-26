import type { CSSProperties } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { cn } from '../../../lib/cn.ts';
import { CountUp } from '../../../ui/index.ts';

export type CheckFilter = 'all' | 'create' | 'update' | 'unchanged' | 'errors';

const TILES = [
  { id: 'create', label: C.check.tileNew, dot: 'bg-success' },
  { id: 'update', label: C.check.tileUpdates, dot: 'bg-info' },
  { id: 'unchanged', label: C.check.tileSame, dot: 'bg-fg-subtle' },
  { id: 'errors', label: C.check.tileFix, dot: 'bg-danger' },
] as const;

/** The check's four counts; each is a filter, and pressing it again shows everything. */
export function CheckTiles({
  counts,
  filter,
  onFilter,
  sameLabel = C.check.tileSame,
  compact = false,
}: {
  counts: NonNullable<PassImportDto['counts']>;
  filter: CheckFilter;
  onFilter: (f: CheckFilter) => void;
  /** Connections read the third tile as "Not issued". */
  sameLabel?: string;
  /** Two to a row at any width: a narrow aside. */
  compact?: boolean;
}) {
  return (
    <div className="@container">
      <ul className={cn('wl-deal grid grid-cols-2 gap-3', !compact && '@xl:grid-cols-4')}>
        {TILES.map((t, i) => {
          const on = filter === t.id;
          const n = counts[t.id];
          return (
            <li key={t.id} style={{ '--i': i } as CSSProperties}>
              <button
                type="button"
                aria-pressed={on}
                disabled={n === 0}
                onClick={() => onFilter(on ? 'all' : t.id)}
                className={cn(
                  'flex w-full flex-col items-start gap-1 rounded-lg border bg-surface-raised p-4 text-left wl-colors',
                  'hover:not-disabled:border-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                  'disabled:cursor-default',
                  on ? 'border-accent shadow-[0_0_0_1px_var(--pk-accent)]' : 'border-border',
                  t.id === 'errors' && n > 0 && !on && 'border-danger/40',
                )}
              >
                <CountUp
                  value={n}
                  className={cn(
                    'text-3xl font-semibold text-fg-strong',
                    t.id === 'errors' && n > 0 && 'text-danger',
                  )}
                />
                <span className="flex items-center gap-2 text-sm text-fg-muted">
                  <span aria-hidden className={cn('size-2 rounded-full', t.dot)} />
                  {t.id === 'unchanged' ? sameLabel : t.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
