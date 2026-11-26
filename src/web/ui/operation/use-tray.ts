import { useCallback, useEffect, useRef, useState } from 'react';
import { isOperationActive } from '../../lib/status-operations.ts';
import { toast } from '../toaster.tsx';
import { useOperationsClient } from './client.ts';
import { isOperationOnScreen, seedOperation, useMineOperations } from './store.ts';
import type { Operation } from './types.ts';

const HOUR = 3_600_000;

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * Stop and Retry for one operation, through the client: the answer goes back into the cache, a
 * failure is a toast. Panels and sheets take `onStop` and `onRetry` from here.
 */
export function useOperationActions(): {
  stop: (op: Operation) => Promise<void>;
  retry: (op: Operation) => Promise<void>;
  retrying: boolean;
} {
  const client = useOperationsClient();
  const [retrying, setRetrying] = useState(false);
  const stop = useCallback(
    async (op: Operation) => {
      try {
        seedOperation(await client.cancel(op.id), { mine: true });
      } catch (e) {
        toast.error(e, 'Could not stop');
      }
    },
    [client],
  );
  const retry = useCallback(
    async (op: Operation) => {
      setRetrying(true);
      try {
        seedOperation(await client.retry(op.id), { mine: true });
      } catch (e) {
        toast.error(e, 'Could not retry');
      } finally {
        setRetrying(false);
      }
    },
    [client],
  );
  return { stop, retry, retrying };
}

/**
 * What the tray shows: what the person started, active first, finished ones for an hour. It
 * fetches once on mount to resume a reload, then polls `active=true&mine=true` every 5 s only
 * while it holds an active row (a start mutation seeds the cache with `trackOperation`, so no poll
 * has to find it). An operation that leaves the active list is read once by id to learn its end.
 * Ends the person did not watch become a toast.
 */
export function useTray({
  notify = true,
  onOpen,
}: {
  notify?: boolean;
  /** Where a Done toast's View goes. */
  onOpen?: (op: Operation) => void;
}) {
  const client = useOperationsClient();
  const all = useMineOperations();
  const active = all.filter((op) => isOperationActive(op.status));
  const hasActive = active.length > 0;
  const [seenAt, setSeenAt] = useState(0);
  const { retry } = useOperationActions();

  useEffect(() => {
    const ctl = new AbortController();
    client
      .list({ active: true, mine: true }, ctl.signal)
      .then((items) => {
        for (const op of items) seedOperation(op, { mine: true });
      })
      // The tray is a convenience: a failed first look leaves it hidden until a start seeds it.
      .catch(() => undefined);
    return () => ctl.abort();
  }, [client]);

  const live = useRef(all);
  live.current = all;
  useEffect(() => {
    if (!hasActive) return;
    const ctl = new AbortController();
    const tick = async () => {
      try {
        const items = await client.list({ active: true, mine: true }, ctl.signal);
        const listed = new Set(items.map((op) => op.id));
        for (const op of items) seedOperation(op, { mine: true });
        for (const op of live.current) {
          if (!isOperationActive(op.status) || listed.has(op.id)) continue;
          const res = await client.get(op.id, { signal: ctl.signal });
          if (res.operation) seedOperation(res.operation, { mine: true });
        }
      } catch {
        // The next tick tries again.
      }
    };
    const timer = setInterval(() => void tick(), hidden() ? 30_000 : 5000);
    return () => {
      clearInterval(timer);
      ctl.abort();
    };
  }, [hasActive, client]);

  // Completion toasts: an end the person started and is not looking at.
  const watching = useRef(new Set<string>());
  const told = useRef(new Set<string>());
  useEffect(() => {
    for (const op of all) {
      if (isOperationActive(op.status)) {
        watching.current.add(op.id);
        continue;
      }
      if (!watching.current.has(op.id) || told.current.has(op.id)) continue;
      told.current.add(op.id);
      if (!notify || isOperationOnScreen(op.id)) continue;
      if (op.status === 'succeeded')
        toast.action(op.text, { label: 'View', onClick: () => onOpen?.(op) });
      else if (op.status === 'failed')
        toast.error(op.error?.message ?? 'Something went wrong.', op.text, {
          label: 'Retry',
          onClick: () => void retry(op),
        });
    }
  }, [all, notify, onOpen, retry]);

  const recent = all.filter(
    (op) => !isOperationActive(op.status) && Date.now() - (op.finishedAt ?? op.updatedAt) < HOUR,
  );
  const unseen = recent.filter((op) => (op.finishedAt ?? op.updatedAt) > seenAt);
  return {
    active,
    recent,
    unseen: unseen.length,
    markSeen: () => setSeenAt(Date.now()),
  };
}
