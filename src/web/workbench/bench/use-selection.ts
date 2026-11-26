import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { selectedId as idInUrl, selectInUrl } from './url.ts';

export interface BenchSelection<T> {
  /** The id in the address (`#id`), whether or not it is loaded. */
  selectedId: string | null;
  /** The selected item: from the list, or fetched by id and pinned. */
  selected: T | null;
  /** The item `#id` names when the list does not hold it ("Not in this view"). */
  pinned: T | null;
  /** The drawer or sheet is open (below 1180 px; from there the pane is always beside the list). */
  open: boolean;
  select: (id: string | null, opts?: { open?: boolean }) => void;
  /** The next or previous item, in the order shown (the pinned one first). */
  step: (by: 1 | -1) => void;
  setOpen: (open: boolean) => void;
}

/**
 * One selection model for every bench list: the address's `#id`. On load and on `hashchange` the id
 * is selected; if the list does not hold it, `fetchOne` reads it and it is pinned on top. A pick
 * writes the hash in place (`replaceState`), so Back steps through tools, not through rows.
 */
export function useBenchSelection<T>({
  items,
  idOf,
  fetchOne,
  ready = true,
}: {
  items: readonly T[];
  idOf: (item: T) => string;
  /** Reads one item by id (each tool has a get-by-id). */
  fetchOne?: (id: string) => Promise<T | null>;
  /** The list has loaded: only then is a missing id fetched. */
  ready?: boolean;
}): BenchSelection<T> {
  const [id, setId] = useState<string | null>(() =>
    typeof location === 'undefined' ? null : idInUrl(),
  );
  const [open, setOpen] = useState(() => id !== null);
  const [pinned, setPinned] = useState<T | null>(null);
  /** The id already read by `fetchOne`: one read per id, found or not. */
  const asked = useRef<string | null>(null);

  useEffect(() => {
    const follow = () => {
      const next = idInUrl();
      setId(next);
      if (next) setOpen(true);
    };
    addEventListener('hashchange', follow);
    return () => removeEventListener('hashchange', follow);
  }, []);

  const inList = useMemo(
    () => (id === null ? null : (items.find((item) => idOf(item) === id) ?? null)),
    [items, idOf, id],
  );
  const current = useRef(id);
  current.current = id;
  useEffect(() => {
    if (!id || inList || !ready || !fetchOne || asked.current === id) return;
    asked.current = id;
    // Kept only while that id is still the one selected.
    fetchOne(id).then(
      (item) => current.current === id && setPinned(item),
      (error: unknown) => {
        // Not readable: nothing is pinned, the hash stays, and the page's handler hears why.
        reportError(error);
      },
    );
  }, [id, inList, ready, fetchOne]);
  const shownPin = pinned && !inList && idOf(pinned) === id ? pinned : null;

  const select = useCallback((next: string | null, opts: { open?: boolean } = {}) => {
    setId(next);
    selectInUrl(next);
    setOpen(next === null ? false : (opts.open ?? true));
  }, []);
  const order = useMemo(
    () => [...(shownPin ? [idOf(shownPin)] : []), ...items.map(idOf)],
    [items, idOf, shownPin],
  );
  const step = useCallback(
    (by: 1 | -1) => {
      if (order.length === 0) return;
      const at = id === null ? -1 : order.indexOf(id);
      const next = order[Math.min(order.length - 1, Math.max(0, at === -1 ? 0 : at + by))];
      if (next !== undefined && next !== id) {
        setId(next);
        selectInUrl(next);
      }
    },
    [order, id],
  );
  return {
    selectedId: id,
    selected: inList ?? shownPin,
    pinned: shownPin,
    open: open && id !== null,
    select,
    step,
    setOpen,
  };
}
