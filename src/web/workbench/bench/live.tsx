import { useEffect, useState } from 'react';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { usePollPaused } from '../../lib/use-poll-paused.ts';
import { BenchSlot } from './slots.tsx';
import './state.css';

const C = BENCH_COPY.live;

/** Listening while it polls, Paused when you paused it or left the tab, Offline when the network is gone. */
export type LiveState = 'listening' | 'paused' | 'limited' | 'offline';

/** The browser's own online state, followed. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener('online', on);
    addEventListener('offline', off);
    return () => {
      removeEventListener('online', on);
      removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** The state to show, from the tool's own `paused` and the network. */
export function useLiveState(paused: boolean): LiveState {
  const online = useOnline();
  const limited = usePollPaused();
  return !online ? 'offline' : paused ? 'paused' : limited ? 'limited' : 'listening';
}

/**
 * The tool's live mark in the context strip (Logs, Webhooks): an 8 px dot and its word. The dot
 * pulses (a 1.6 s ring) only while listening; Paused and Offline are still and offer Resume.
 * `inPlace` draws it where it stands instead of the strip's slot.
 */
export function LiveIndicator({
  state,
  onResume,
  inPlace = false,
}: {
  state: LiveState;
  onResume?: () => void;
  inPlace?: boolean;
}) {
  const mark = (
    <span className="bench-live" data-state={state}>
      <span className="bench-live-d" aria-hidden="true" />
      <span className="bench-live-t" role="status">
        {C[state]}
      </span>
      {state !== 'listening' && onResume ? (
        <button type="button" className="bench-live-r" onClick={onResume}>
          {C.resume}
        </button>
      ) : null}
    </span>
  );
  return inPlace ? mark : <BenchSlot name="status">{mark}</BenchSlot>;
}
