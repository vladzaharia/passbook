/**
 * The scan store: holds the state, runs the reducer, executes its commands over injected ports,
 * re-arms one timer for the next deadline, and keeps the buddy's delayed beat.
 */
import { SCAN_TIMING } from '../timing.ts';
import { createRunner } from './commands.ts';
import { nextDeadline } from './deadlines.ts';
import type { ScanDeps } from './ports.ts';
import { type ScanView, viewOf } from './present.ts';
import { reduce } from './reduce.ts';
import type { BuddyBeat, Cmd, ScanEvent, ScanState } from './types.ts';

export interface ScanSnapshot {
  state: ScanState;
  view: ScanView;
  /** The store clock at the last change. Views derive time-based hints from it. */
  now: number;
}

export interface ScanStore {
  getSnapshot(): ScanSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(event: ScanEvent): void;
  /** Resends unsure entries now (also runs on a timer, on online and on visible). */
  retryUnsure(): void;
  dispose(): void;
}

/** Beats at the read start at once; result beats wait `BEAT_DELAY` after the verdict. */
const IMMEDIATE: ReadonlySet<BuddyBeat | 'cut'> = new Set(['cut', 'lock', 'look']);

export function createScanStore(deps: ScanDeps, initial: ScanState): ScanStore {
  let state = initial;
  let visible = true;
  let shown: { beat: BuddyBeat | null; key: string } = { beat: null, key: '0' };
  let beatCount = 0;
  let beatTimer: unknown = null;
  let tickTimer: unknown = null;
  let retryTimer: unknown = null;
  let pollTimer: unknown = null;
  let snapshot: ScanSnapshot | null = null;
  let disposed = false;
  let busy = false;
  const queue: ScanEvent[] = [];
  const listeners = new Set<() => void>();

  const publish = () => {
    snapshot = null;
    for (const l of listeners) l();
  };

  const runner = createRunner(deps, {
    state: () => state,
    dispatch: (e) => dispatch(e),
    beat: (beat) => setBeat(beat),
  });

  function setBeat(beat: BuddyBeat | 'cut') {
    if (beatTimer !== null) deps.clock.clearTimeout(beatTimer);
    beatTimer = null;
    const apply = () => {
      beatTimer = null;
      shown = { beat: beat === 'cut' ? null : beat, key: String(++beatCount) };
      publish();
    };
    if (IMMEDIATE.has(beat)) apply();
    else beatTimer = deps.clock.setTimeout(apply, SCAN_TIMING.BEAT_DELAY);
  }

  function rearm() {
    if (tickTimer !== null) deps.clock.clearTimeout(tickTimer);
    tickTimer = null;
    const now = deps.clock.now();
    const at = nextDeadline(state, now);
    if (at !== null && !disposed)
      tickTimer = deps.clock.setTimeout(
        () => {
          tickTimer = null;
          dispatch({ type: 'tick' });
        },
        Math.max(at - now, 16),
      );
    const wantsRetry = state.unsure.some((u) => u.state === 'retrying') && state.online;
    if (wantsRetry && retryTimer === null && !disposed)
      retryTimer = deps.clock.setTimeout(() => {
        retryTimer = null;
        retry();
        rearm();
      }, SCAN_TIMING.UNSURE_RETRY_EVERY);
    const wantsPoll =
      deps.api.stats !== undefined &&
      state.started &&
      state.online &&
      state.block === null &&
      visible;
    if (wantsPoll && pollTimer === null && !disposed)
      pollTimer = deps.clock.setTimeout(() => {
        pollTimer = null;
        poll();
        rearm();
      }, SCAN_TIMING.COUNTS_POLL);
  }

  function poll() {
    if (state.loop.s !== 'ready' || !deps.api.stats) return;
    const ac = new AbortController();
    const { dayStart } = deps.base();
    deps.api
      .stats({ signal: ac.signal, ...(dayStart !== undefined ? { dayStart } : {}) })
      .then((counts) => dispatch({ type: 'counts', counts }))
      .catch((error: unknown) => {
        const info = deps.toFail(error);
        if (info.error === 'revoked' || info.error === 'suspended' || info.error === 'signed_out')
          dispatch({ type: 'fail', key: '', ...info });
      });
  }

  function retry() {
    runner.retryUnsure().catch((error: unknown) => {
      // A retry that cannot even start is not worth a verdict: the next round tries again.
      void error;
    });
  }

  function dispatch(event: ScanEvent) {
    if (disposed) return;
    queue.push(event);
    if (busy) return;
    busy = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift() as ScanEvent;
        if (next.type === 'visible') visible = next.visible;
        const before = state;
        const result = reduce(state, next, { now: deps.clock.now(), id: deps.ids.id });
        state = result.state;
        if (before.block !== 'revoked' && state.block === 'revoked') {
          deps.wipe();
          deps.unsure.clear().catch((error: unknown) => void error);
        }
        runner.run(result.cmds as Cmd[]);
        if ((next.type === 'online' && next.online) || (next.type === 'visible' && next.visible))
          retry();
      }
    } finally {
      busy = false;
    }
    rearm();
    publish();
  }

  rearm();

  return {
    getSnapshot() {
      snapshot ??= { state, view: viewOf(state, shown), now: deps.clock.now() };
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    retryUnsure: retry,
    dispose() {
      disposed = true;
      for (const t of [beatTimer, tickTimer, retryTimer, pollTimer])
        if (t !== null) deps.clock.clearTimeout(t);
      listeners.clear();
    },
  };
}
