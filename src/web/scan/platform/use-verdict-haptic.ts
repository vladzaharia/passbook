import { useEffect } from 'react';
import type { ScanOutcome } from '../machine/types.ts';
import { buzz } from './haptics.ts';

/**
 * One buzz per verdict: it fires when a new server verdict is held, never on a re-render. The
 * device's own verdicts are silent, except a system one (a problem to flag) and a read it saved
 * offline (a check-in the door took).
 */
export function useVerdictHaptic(outcome: ScanOutcome | null): void {
  useEffect(() => {
    if (!outcome || outcome.replay) return;
    if (outcome.kind === 'queued') buzz('ok');
    else if (!outcome.local || outcome.kind === 'system') buzz(outcome.kind);
  }, [outcome]);
}
