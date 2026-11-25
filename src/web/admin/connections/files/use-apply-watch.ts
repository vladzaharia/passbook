import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { ConnectionRunSchema } from '@/shared/contracts/connections.ts';
import { connectionKeys } from '../api.ts';
import { filesKey } from './files-api.ts';

type Run = z.infer<typeof ConnectionRunSchema>;
/** After Apply or Sync now the run may not be listed yet: wait this long for it before giving up. */
const GRACE_MS = 30_000;
const POLL_MS = 2_000;
const CLOCK_SKEW_MS = 2_000;

/**
 * Whether the revision in use (`applied` is its flag) is being applied right now, and a refresh every 2 s while it is. The
 * revision reads Applied when a run finishes the file; a run seen failing ends the wait.
 */
export function useApplyWatch(connectionId: string, applied: boolean, runs: readonly Run[]) {
  const qc = useQueryClient();
  const [since, setSince] = useState<number>();
  const [grace, setGrace] = useState(false);
  const running = runs.some((r) => r.outcome === 'running');
  const ended =
    since !== undefined &&
    runs.some((r) => r.startedAt >= since - CLOCK_SKEW_MS && r.outcome !== 'running');
  const applying = !applied && (running || (grace && !ended));

  useEffect(() => {
    if (!grace) return;
    const t = setTimeout(() => setGrace(false), GRACE_MS);
    return () => clearTimeout(t);
  }, [grace]);
  useEffect(() => {
    if (!applying) return;
    const t = setInterval(() => {
      void qc.invalidateQueries({ queryKey: filesKey(connectionId) });
      void qc.invalidateQueries({ queryKey: connectionKeys.detail(connectionId) });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [applying, qc, connectionId]);

  return {
    applying,
    /** A run was just started for this file. */
    begin() {
      setSince(Date.now());
      setGrace(true);
    },
  };
}
