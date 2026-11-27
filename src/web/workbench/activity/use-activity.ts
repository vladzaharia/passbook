import { useCallback, useEffect, useState } from 'react';
import { useOperationsClient } from '../../ui/operation/client.ts';
import { seedOperation } from '../../ui/operation/store.ts';
import { isTerminal, type Operation } from '../../ui/operation/types.ts';

type Phase = 'loading' | 'ready' | 'failed';

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * The context's Test operations, newest first, through the host's token client. Polled every 5 s
 * while one runs (30 s in a hidden tab); a stop or retry calls `refetch`. A failed first read is
 * `failed`; a later failure keeps the last list.
 */
export function useActivity(orgId: string): {
  items: readonly Operation[];
  phase: Phase;
  refetch: () => void;
} {
  const client = useOperationsClient();
  const [state, setState] = useState<{ items: readonly Operation[]; phase: Phase }>({
    items: [],
    phase: 'loading',
  });
  const [kick, setKick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `kick` is the retry and the refetch.
  useEffect(() => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let again = true;
      try {
        const all = await client.list({ orgId }, ctl.signal);
        if (ctl.signal.aborted) return;
        const items = all.filter((op) => op.mode === 'test' && op.orgId === orgId);
        for (const op of items) seedOperation(op);
        setState({ items, phase: 'ready' });
        again = items.some((op) => !isTerminal(op.status));
      } catch {
        if (ctl.signal.aborted) return;
        setState((s) => (s.phase === 'ready' ? s : { items: [], phase: 'failed' }));
        again = false;
      }
      if (again) timer = setTimeout(tick, hidden() ? 30_000 : 5000);
    };
    void tick();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [client, orgId, kick]);
  const refetch = useCallback(() => setKick((k) => k + 1), []);
  return { ...state, refetch };
}
