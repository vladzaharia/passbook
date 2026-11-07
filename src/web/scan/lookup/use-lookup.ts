import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ScanLookupResultSchema } from '../../../shared/contracts/scan-session.ts';
import { errorMessage } from '../../lib/errors.ts';
import { ScanApiError } from '../api/errors.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { scanId } from '../platform/id.ts';

type Results = z.infer<typeof ScanLookupResultSchema>;
const searchable = (q: string) =>
  q.length >= 3 && q.length <= 120 && (!q.includes('@') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q));

export function useLookup(
  api: ScanApi,
  open: boolean,
  allowPeople: boolean,
  onCode: (code: string) => void,
) {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<Results | null>(null);
  const [picked, setPicked] = useState<ScanOutcome | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const request = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    request.current?.abort();
  }, []);
  const run = useCallback(
    async (work: (signal: AbortSignal) => Promise<void>, selection = false) => {
      cancel();
      const ac = new AbortController();
      request.current = ac;
      setBusy(true);
      setSelecting(selection);
      setError('');
      try {
        await work(ac.signal);
      } catch (cause) {
        if (!ac.signal.aborted) {
          if (cause instanceof ScanApiError && cause.status === 429)
            setRetryAt(Date.now() + (cause.retryAfterMs ?? 40_000));
          else
            setError(
              cause instanceof ScanApiError
                ? errorMessage(cause)
                : 'Could not look up this pass. Check your connection.',
            );
        }
      } finally {
        if (request.current === ac) {
          setBusy(false);
          setSelecting(false);
        }
      }
    },
    [cancel],
  );
  useEffect(() => {
    if (!retryAt) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      setSeconds(left);
      if (!left) setRetryAt(0);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [retryAt]);
  useEffect(() => {
    if (!open) {
      setQ('');
      setPicked(null);
      setResult(null);
      setError('');
      setBusy(false);
      setSelecting(false);
    }
  }, [open]);
  useEffect(() => {
    if (open && !picked && allowPeople && searchable(q.trim()) && !retryAt)
      timer.current = setTimeout(() => {
        void run(async (signal) => {
          const rows = await api.lookup({ q: q.trim() }, { signal });
          if (!signal.aborted) setResult(rows);
        });
      }, 250);
    return cancel;
  }, [api, q, open, picked, allowPeople, retryAt, run, cancel]);

  const resolve = (input: { code: string } | { passId: string }, signal: AbortSignal) =>
    api.resolve(
      { idempotencyKey: scanId(), input: { ...input, method: 'manual' }, clientTs: Date.now() },
      { signal },
    );
  function submit() {
    const query = q.trim();
    if (!query || retryAt || selecting) return;
    if (!allowPeople) {
      cancel();
      onCode(query);
      return;
    }
    void run(async (signal) => {
      const found = await resolve({ code: query }, signal);
      if (signal.aborted) return;
      if (found.reason !== 'not_found') {
        onCode(query);
        return;
      }
      if (!searchable(query)) {
        setPicked(found);
        return;
      }
      const rows = await api.lookup({ q: query }, { signal });
      if (signal.aborted) return;
      setResult(rows);
      if (rows.items.length === 1 && !rows.more) {
        const row = rows.items[0];
        if (row) {
          const selected = await resolve({ passId: row.passId }, signal);
          if (!signal.aborted) setPicked(selected);
        }
      }
    }, true);
  }
  return {
    q,
    result,
    picked,
    error,
    busy,
    selecting,
    seconds,
    submit,
    change(value: string) {
      cancel();
      setQ(value);
      setResult(null);
      setError('');
      setBusy(false);
      setSelecting(false);
    },
    pick(passId: string) {
      if (retryAt || selecting) return;
      void run(async (signal) => {
        const selected = await resolve({ passId }, signal);
        if (!signal.aborted) setPicked(selected);
      }, true);
    },
    back: () => setPicked(null),
    retry: submit,
  };
}
