import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { z } from 'zod';
import type { ConnectionRunSchema } from '@/shared/contracts/connections.ts';
import { connectionKeys } from '../api.ts';
import { filesKey } from './files-api.ts';

type Run = z.infer<typeof ConnectionRunSchema>;
/** After Apply or Sync now the run may not be listed yet: wait this long for it before giving up. */
const GRACE_MS = 30_000;
const POLL_MS = 2_000;
const CLOCK_SKEW_MS = 2_000;

// Whoever starts a run for a file (Apply, Sync now in the card or the header, Create) says so here, so
// the File tab has one Applying state however the run began, even across a navigation.
const started = new Map<string, number>();
const listeners = new Set<() => void>();
export function markApplyStarted(connectionId: string): void {
  started.set(connectionId, Date.now());
  for (const l of listeners) l();
}
/** Forgets every started run: a new session of the page, or a test. */
export function forgetApplyStarts(): void {
  started.clear();
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/**
 * Whether the revision in use (`applied` is its flag) is being applied right now, and a refresh every
 * 2 s while it is. The revision reads Applied when a run finishes the file; a run seen failing ends the wait.
 */
export function useApplyWatch(connectionId: string, applied: boolean, runs: readonly Run[]) {
  const qc = useQueryClient();
  const since = useSyncExternalStore(subscribe, () => started.get(connectionId));
  const [expired, setExpired] = useState(false);
  const running = runs.some((r) => r.outcome === 'running');
  const ended =
    since !== undefined &&
    runs.some((r) => r.startedAt >= since - CLOCK_SKEW_MS && r.outcome !== 'running');
  const applying = !applied && (running || (since !== undefined && !expired && !ended));

  useEffect(() => {
    if (since === undefined) return;
    setExpired(false);
    const t = setTimeout(() => setExpired(true), GRACE_MS);
    return () => clearTimeout(t);
  }, [since]);
  useEffect(() => {
    if (!applying) return;
    const t = setInterval(() => {
      void qc.invalidateQueries({ queryKey: filesKey(connectionId) });
      void qc.invalidateQueries({ queryKey: connectionKeys.detail(connectionId) });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [applying, qc, connectionId]);

  return { applying };
}
