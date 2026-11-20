import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One read that repeats: on mount, every `every` ms, when `kick` changes (a hub pulse) and when the
 * page is shown again. The last good answer stays while a read fails; `failed` says it did.
 * Nothing runs while `active` is false or the device is offline.
 */
export function usePolled<T>(
  read: (signal: AbortSignal) => Promise<T>,
  {
    active,
    online,
    every,
    kick,
  }: { active: boolean; online: boolean; every: number; kick: number },
) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(read);
  latest.current = read;
  const inflight = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    inflight.current?.abort();
    const own = new AbortController();
    inflight.current = own;
    try {
      const next = await latest.current(own.signal);
      if (own.signal.aborted) return;
      setData(next);
      setFailed(false);
    } catch {
      // A read that was replaced is not a failure; any other leaves the last answer and says so.
      if (!own.signal.aborted) setFailed(true);
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `kick` is the reason to read again
  useEffect(() => {
    if (!active || !online) return;
    void load();
    const t = setInterval(() => void load(), every);
    const shown = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', shown);
      inflight.current?.abort();
    };
  }, [active, online, every, load, kick]);
  return { data, failed, reload: load };
}
