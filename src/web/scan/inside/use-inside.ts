import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ApiError } from '../../lib/errors.ts';
import { removeWithTransition } from '../../lib/motion.ts';
import { toast } from '../../ui/toaster.tsx';
import { toFail } from '../api/to-fail.ts';
import type { FailInfo } from '../machine/ports.ts';
import { scanId } from '../platform/id.ts';
import { SCAN_TIMING } from '../timing.ts';
import { fill } from '../ui/copy.ts';
import { ACCESS_COPY } from '../ui/copy-access.ts';
import { initialInside, insideReducer } from './inside-model.ts';
import { INSIDE_Q_MAX, type InsideApiPort, type InsideRow } from './inside-types.ts';

export interface InsideNotify {
  undo(message: string, onUndo: () => unknown): void;
  error(error: unknown, title: string): void;
  info(message: string): void;
}

const realNotify: InsideNotify = {
  undo: (message, onUndo) => void toast.undo(message, onUndo),
  error: (error, title) => void toast.error(error, title),
  info: (message) => void toast.info(message),
};

/** Failures that end the person's right to the list: the machine shows its own block for them. */
const BLOCKING = new Set(['revoked', 'suspended', 'signed_out', 'staff_required']);

const PAGE = 50;

/**
 * The list behind Who's in. It loads while `active`, follows the search box (250 ms) and the place
 * filter, pages with a cursor, refreshes every 15 s, and marks someone out with an Undo toast. A
 * list that cannot refresh stays, so offline shows the last one. Roll call extends it: it reads
 * `state` and adds its own row action.
 */
export function useInside({
  api,
  active,
  online,
  onFail,
  notify = realNotify,
  failOf = toFail,
}: {
  api: InsideApiPort;
  active: boolean;
  online: boolean;
  /** A failure that blocks the scanner (signed out, revoked). */
  onFail?: (info: FailInfo) => void;
  notify?: InsideNotify;
  failOf?: (error: unknown) => FailInfo;
}) {
  const [state, dispatch] = useReducer(insideReducer, undefined, initialInside);
  const seq = useRef(0);
  const live = useRef(state);
  live.current = state;
  // Callers pass fresh closures every render; the list must not reload because of that.
  const hooks = useRef({ onFail, notify, failOf });
  hooks.current = { onFail, notify, failOf };

  const load = useCallback(
    async (opts: { append?: boolean; keep?: boolean } = {}) => {
      const s = live.current;
      const mine = ++seq.current;
      const ac = new AbortController();
      try {
        const list = await api.inside(
          {
            ...(s.place ? { place: s.place } : {}),
            ...(s.q.trim() ? { q: s.q.trim().slice(0, INSIDE_Q_MAX) } : {}),
            ...(opts.append && s.next ? { cursor: s.next } : {}),
            limit: opts.keep ? Math.min(100, Math.max(PAGE, s.rows.length)) : PAGE,
          },
          { signal: ac.signal },
        );
        if (mine === seq.current) dispatch({ t: 'loaded', list, append: Boolean(opts.append) });
      } catch (error) {
        if (mine !== seq.current) return;
        const info = hooks.current.failOf(error);
        if (BLOCKING.has(info.error)) hooks.current.onFail?.(info);
        dispatch({ t: 'failed' });
      }
    },
    [api],
  );

  // A new query waits for the typing to stop; the first load and a place change do not.
  const key = `${state.place ?? ''}|${state.q}`;
  const firstKey = useRef(key);
  useEffect(() => {
    if (!active || !online) return;
    const wait = state.q && key !== firstKey.current ? SCAN_TIMING.SEARCH_DEBOUNCE : 0;
    firstKey.current = key;
    const t = setTimeout(() => void load(), wait);
    return () => clearTimeout(t);
  }, [active, online, key, state.q, load]);

  useEffect(() => {
    if (!active || !online) return;
    const t = setInterval(() => void load({ keep: true }), SCAN_TIMING.COUNTS_POLL);
    return () => clearInterval(t);
  }, [active, online, load]);

  const markOut = useCallback(
    async (row: InsideRow) => {
      const name = row.holder ?? ACCESS_COPY.inside.unnamed;
      removeWithTransition(() => dispatch({ t: 'removed', passId: row.passId }));
      try {
        const done = await api.markOut({
          idempotencyKey: scanId(),
          passId: row.passId,
          place: row.place,
        });
        const inNow = done.counts.place?.inNow ?? done.occupancy?.inNow;
        if (inNow != null) dispatch({ t: 'count', place: row.place, inNow });
        if (done.scanId)
          hooks.current.notify.undo(fill(ACCESS_COPY.inside.markedOut, { name }), async () => {
            await api.undoMarkOut(done.scanId ?? '', scanId());
            await load({ keep: true });
          });
        void load({ keep: true });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'NOT_INSIDE') {
          // Someone else got there first: the row stays gone.
          hooks.current.notify.info(fill(ACCESS_COPY.inside.alreadyOut, { name }));
          void load({ keep: true });
          return;
        }
        dispatch({ t: 'restored', row });
        const info = hooks.current.failOf(error);
        if (BLOCKING.has(info.error)) hooks.current.onFail?.(info);
        hooks.current.notify.error(error, 'Could not mark as out');
      }
    },
    [api, load],
  );

  return {
    state,
    setQuery: (q: string) => dispatch({ t: 'query', q }),
    setPlace: (place: string | null) => dispatch({ t: 'query', place }),
    more: () => load({ append: true }),
    retry: () => load(),
    markOut,
  };
}
