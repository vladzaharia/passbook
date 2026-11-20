import { useEffect, useState } from 'react';
import type { ScanApi } from '../../api/scan-api.ts';
import type { ScanOutcome } from '../../machine/types.ts';
import { scanId } from '../../platform/id.ts';

/** Settles a pass for the record: a read that changes nothing until an action is taken. */
export function useResolved(api: ScanApi, passId: string, delayMs: number) {
  const [state, setState] = useState<{ outcome: ScanOutcome | null; failed: boolean }>({
    outcome: null,
    failed: false,
  });
  useEffect(() => {
    const ac = new AbortController();
    setState((s) => ({
      outcome: s.outcome?.card?.passId === passId ? s.outcome : null,
      failed: false,
    }));
    const timer = setTimeout(() => {
      api
        .resolve(
          { idempotencyKey: scanId(), input: { passId, method: 'manual' }, clientTs: Date.now() },
          { signal: ac.signal },
        )
        .then(
          (outcome) => !ac.signal.aborted && setState({ outcome, failed: false }),
          () => !ac.signal.aborted && setState({ outcome: null, failed: true }),
        );
    }, delayMs);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [api, passId, delayMs]);
  return state;
}
