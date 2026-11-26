import { useEffect, useState } from 'react';
import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';

const LOGS = '/api/v1/developer/logs';

/** The last calls a key made, newest first. */
export async function fetchKeyCalls(
  keyId: string,
  fetchFn: typeof fetch = (i, n) => fetch(i, n),
): Promise<RequestLogEntry[]> {
  const res = await fetchFn(`${LOGS}?keyId=${encodeURIComponent(keyId)}&limit=5&portal=hide`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`The log did not load (${res.status}).`);
  const body = (await res.json()) as { items?: RequestLogEntry[] };
  return Array.isArray(body.items) ? body.items.slice(0, 5) : [];
}

export type KeyCalls =
  | { state: 'loading' }
  | { state: 'failed'; retry: () => void }
  | { state: 'ready'; items: RequestLogEntry[] };

/** One read per key shown; a failure offers its retry. */
export function useKeyCalls(keyId: string): KeyCalls {
  const [result, setResult] = useState<{ id: string; calls: KeyCalls } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry's own trigger.
  useEffect(() => {
    let live = true;
    fetchKeyCalls(keyId).then(
      (items) => live && setResult({ id: keyId, calls: { state: 'ready', items } }),
      () =>
        live &&
        setResult({ id: keyId, calls: { state: 'failed', retry: () => setAttempt((n) => n + 1) } }),
    );
    return () => {
      live = false;
    };
  }, [keyId, attempt]);
  return result?.id === keyId ? result.calls : { state: 'loading' };
}
