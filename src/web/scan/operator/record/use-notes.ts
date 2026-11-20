import { useCallback, useEffect, useRef, useState } from 'react';
import type { PassNote } from '../../../../shared/contracts/scan-history.ts';
import { ApiError } from '../../../lib/errors.ts';
import type { ScanApi } from '../../api/scan-api.ts';
import { scanId } from '../../platform/id.ts';

export type AddResult = 'ok' | 'full' | 'wait' | 'failed';

interface Loaded {
  passId: string;
  items: PassNote[];
  status: 'ready' | 'failed';
}

/**
 * The person's staff notes. They belong to their pass and are dropped the moment it changes.
 * A save that fails keeps its key, so the retry is the same note and never a second one.
 */
export function useNotes(api: ScanApi, passId: string, enabled: boolean, onAdded: () => void) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<{ body: string; key: string } | null>(null);

  useEffect(() => {
    void attempt;
    if (!enabled) return;
    const run = new AbortController();
    Promise.resolve()
      .then(() => api.notes(passId, { signal: run.signal }))
      .then(
        (page) => {
          if (!run.signal.aborted) setLoaded({ passId, items: page.items, status: 'ready' });
        },
        () => {
          if (!run.signal.aborted)
            setLoaded((was) =>
              was?.passId === passId && was.status === 'ready'
                ? was
                : { passId, items: [], status: 'failed' },
            );
        },
      );
    return () => run.abort();
  }, [api, passId, enabled, attempt]);

  const add = useCallback(
    async (body: string): Promise<AddResult> => {
      const same = pending.current?.body === body ? pending.current : null;
      const sent = same ?? { body, key: scanId() };
      pending.current = sent;
      try {
        const note = await api.addNote(passId, { body, idempotencyKey: sent.key });
        pending.current = null;
        setLoaded((was) => ({
          passId,
          status: 'ready',
          items: [
            note,
            ...(was?.passId === passId ? was.items : []).filter((n) => n.id !== note.id),
          ],
        }));
        onAdded();
        return 'ok';
      } catch (error) {
        if (error instanceof ApiError && error.code === 'NOTE_CAP') return 'full';
        if (error instanceof ApiError && error.status === 429) return 'wait';
        return 'failed';
      }
    },
    [api, passId, onAdded],
  );

  const current = loaded?.passId === passId ? loaded : null;
  return {
    items: current?.items ?? [],
    loading: enabled && current === null,
    failed: current?.status === 'failed',
    add,
    retry: () => {
      setLoaded(null);
      setAttempt((n) => n + 1);
    },
  };
}
