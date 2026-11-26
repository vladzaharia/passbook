import { useCallback, useEffect, useRef, useState } from 'react';
import { type OperationFilter, OperationsHttpError, useOperationsClient } from './client.ts';
import { pollDelay } from './poll.ts';
import { cachedOperation, seedOperation, useCachedOperation } from './store.ts';
import { isTerminal, type Operation } from './types.ts';

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * One operation, polled with backoff until it ends. A start mutation seeds it with `seedOperation`
 * so the first paint needs no request. An unchanged poll costs a 304.
 */
export function useOperation(id: string | null): {
  operation: Operation | undefined;
  error: unknown;
  /** The operation cannot be read (404): unknown, or not yours. */
  missing: boolean;
  refetch: () => void;
} {
  const client = useOperationsClient();
  const operation = useCachedOperation(id);
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState(false);
  const [kick, setKick] = useState(0);
  const terminal = operation ? isTerminal(operation.status) : false;
  useEffect(() => {
    // `kick` restarts the loop (refetch, a retry).
    void kick;
    if (!id || terminal) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const born = Date.now();
    let etag: string | null = cachedOperation(id)
      ? `"${id}:${cachedOperation(id)?.revision}"`
      : null;
    const tick = async () => {
      let retryAfterMs: number | null = null;
      try {
        const res = await client.get(id, { etag, signal: ctl.signal });
        etag = res.etag;
        if (res.operation) seedOperation(res.operation);
        setError(null);
        setMissing(false);
        if (res.operation && isTerminal(res.operation.status)) return;
      } catch (e) {
        if (ctl.signal.aborted) return;
        if (e instanceof OperationsHttpError) {
          if (e.status === 404) {
            setMissing(true);
            return;
          }
          retryAfterMs = e.retryAfterMs;
        }
        setError(e);
      }
      const now = cachedOperation(id);
      timer = setTimeout(
        tick,
        pollDelay({
          sinceStartMs: Date.now() - born,
          hidden: hidden(),
          floorMs: now?.pollAfterMs ?? 0,
          retryAfterMs,
        }),
      );
    };
    void tick();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [id, terminal, client, kick]);
  const refetch = useCallback(() => setKick((k) => k + 1), []);
  return { operation, error, missing, refetch };
}

/** The operations a filter names (the tray: `{ active: true, mine: true }`), polled every 5 s while one is active. */
export function useOperations(
  filter: OperationFilter,
  { intervalMs = 5000 }: { intervalMs?: number } = {},
): { operations: readonly Operation[]; ready: boolean; refetch: () => void } {
  const client = useOperationsClient();
  const [operations, setOperations] = useState<readonly Operation[]>([]);
  const [ready, setReady] = useState(false);
  const [kick, setKick] = useState(0);
  const key = JSON.stringify(filter);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the filter's contents.
  useEffect(() => {
    void kick;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let active = false;
      try {
        const items = await client.list(filterRef.current, ctl.signal);
        if (ctl.signal.aborted) return;
        for (const op of items) seedOperation(op);
        setOperations(items);
        setReady(true);
        active = items.some((op) => !isTerminal(op.status));
      } catch {
        if (ctl.signal.aborted) return;
        // A failed poll leaves the last list; the next tick tries again.
        active = true;
      }
      // Only while something runs: a start mutation seeds the cache and calls refetch.
      if (active) timer = setTimeout(tick, hidden() ? 30_000 : intervalMs);
    };
    void tick();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [client, key, intervalMs, kick]);
  return { operations, ready, refetch: useCallback(() => setKick((k) => k + 1), []) };
}

/** The active operation on a target (the sandbox chip's ring), or undefined. */
export function useActiveOperation(target: { type: string; id: string }): Operation | undefined {
  const { operations } = useOperations({ active: true, target });
  return operations.find((op) => !isTerminal(op.status));
}
