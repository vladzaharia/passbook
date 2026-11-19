import { useEffect, useRef, useState } from 'react';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';

export const BEAT_GAP_MS = 2000;

export interface MonitorBeat {
  key: number;
  beat: 'shake' | 'nod' | null;
}

/**
 * The monitor's buddy (BM 17.2): one `shake` for a new refusal or hold, one `nod` for this
 * monitor's own override or mark-out, at most one per 2 s, the newest wins. Rows that were there
 * when the screen opened are a replay and play nothing.
 */
export function useMonitorBeat(rows: ScanLiveRow[], own: number): MonitorBeat {
  const [beat, setBeat] = useState<MonitorBeat>({ key: 0, beat: null });
  const opened = useRef(Date.now());
  const seen = useRef(new Set<string>());
  const last = useRef(0);
  const ownSeen = useRef(own);
  const fire = (kind: 'shake' | 'nod') => {
    const now = Date.now();
    if (now - last.current < BEAT_GAP_MS) return;
    last.current = now;
    setBeat((b) => ({ key: b.key + 1, beat: kind }));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `fire` only reads refs and a setter.
  useEffect(() => {
    let alert = false;
    for (const row of rows) {
      if (seen.current.has(row.id)) continue;
      seen.current.add(row.id);
      if (row.at >= opened.current && (row.kind === 'refused' || row.kind === 'heads_up'))
        alert = true;
    }
    if (alert) fire('shake');
  }, [rows]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    if (own === ownSeen.current) return;
    ownSeen.current = own;
    fire('nod');
  }, [own]);
  return beat;
}
