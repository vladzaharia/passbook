import { useCallback, useMemo, useState } from 'react';
import { setFiltersInUrl } from '../../bench/url.ts';
import type { BenchSelection } from '../../bench/use-selection.ts';
import type { IndexOp } from './index-pane.tsx';

/**
 * The index's selection is the address's `?op=`. A pick drops the launch's other params (`sample`,
 * `from`, `prefill`): they belonged to the operation that was open.
 */
export function useOpSelection(
  all: readonly IndexOp[],
  shown: readonly IndexOp[],
  id: string | null,
): BenchSelection<IndexOp> {
  const [open, setOpen] = useState(false);
  const select = useCallback((next: string | null, opts: { open?: boolean } = {}) => {
    setFiltersInUrl({ op: next, sample: null, from: null, prefill: null });
    setOpen(next === null ? false : (opts.open ?? true));
  }, []);
  const step = useCallback(
    (by: 1 | -1) => {
      const at = shown.findIndex((o) => o.id === id);
      const next = shown[Math.min(shown.length - 1, Math.max(0, at === -1 ? 0 : at + by))];
      if (next && next.id !== id) select(next.id, { open: false });
    },
    [shown, id, select],
  );
  return useMemo(
    () => ({
      selectedId: id,
      selected: all.find((o) => o.id === id) ?? null,
      pinned: null,
      open: open && id !== null,
      select,
      step,
      setOpen,
    }),
    [all, id, open, select, step],
  );
}
