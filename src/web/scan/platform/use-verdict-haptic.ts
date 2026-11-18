import { useEffect } from 'react';
import type { ScanOutcome } from '../machine/types.ts';
import { buzz } from './haptics.ts';

/** One buzz per verdict: it fires when a new server verdict is held, never on a re-render. */
export function useVerdictHaptic(outcome: ScanOutcome | null): void {
  useEffect(() => {
    if (outcome && !outcome.local && !outcome.replay) buzz(outcome.kind);
  }, [outcome]);
}
