import { useEffect, useState } from 'react';
import type { RequestLogDetail } from '../../../shared/contracts/developer.ts';
import type { BenchGet, CausedEvent } from '../bench/trace-events.ts';
import { loadRequestEvents } from '../bench/trace-events.ts';
import { loadSession } from '../console/session.ts';
import { token } from '../console/token.ts';
import { LOG_API } from './model.ts';

export type Detail =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; row: RequestLogDetail };

/** Bodies are fixed once logged: a row is read once per page. */
const cache = new Map<string, RequestLogDetail>();

/** For tests: the next selection reads again. */
export const forgetDetails = (): void => cache.clear();

/** The logged call with its bodies, read when it is selected. */
export function useDetail(id: string | null): Detail | null {
  const [state, setState] = useState<{ id: string; detail: Detail } | null>(null);
  useEffect(() => {
    if (!id) return;
    const hit = cache.get(id);
    if (hit) return setState({ id, detail: { kind: 'ready', row: hit } });
    let live = true;
    setState({ id, detail: { kind: 'loading' } });
    void fetch(`${LOG_API}/${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) return null;
        const row = (await res.json()) as RequestLogDetail;
        cache.set(id, row);
        cache.set(row.id, row);
        return row;
      })
      .catch((error: unknown) => {
        // Offline: the inspector says it did not load, and the page's handler hears why.
        if (live) reportError(error);
        return null;
      })
      .then((row) => {
        if (live) setState({ id, detail: row ? { kind: 'ready', row } : { kind: 'failed' } });
      });
    return () => {
      live = false;
    };
  }, [id]);
  return state && state.id === id ? state.detail : null;
}

/** The sandbox's own API as the session, on a try token (15 minutes, Test only): the log never holds a key. */
async function get<T>(path: string): Promise<T> {
  const session = await loadSession();
  if (session.kind !== 'ready') throw new Error('No sandbox');
  const res = await fetch(`/api/v1${path}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${await token(session.csrf)}` },
  });
  if (!res.ok) throw new Error(`The request failed (${res.status}).`);
  return (await res.json()) as T;
}
const api: BenchGet = get;

/** A call that can have caused events: it wrote, and it worked. */
export const causesEvents = (row: Pick<RequestLogDetail, 'method' | 'status'>): boolean =>
  row.method !== 'GET' && row.status >= 200 && row.status < 300;

const events = new Map<string, CausedEvent[]>();

/** A fresh write's events land a moment after its answer: look again a few times before saying there are none. */
const AGAIN_MS = 3000;
const AGAIN_TIMES = 3;
const FRESH_MS = 60_000;

/** The webhook events a call caused (the Trace's last nodes); none known until they are read, and none on failure. */
export function useCausedEvents(row: RequestLogDetail | null): CausedEvent[] {
  const requestId = row && causesEvents(row) ? row.requestId : null;
  const at = row?.at ?? 0;
  const [found, setFound] = useState<{ id: string; list: CausedEvent[] } | null>(null);
  useEffect(() => {
    if (!requestId || events.has(requestId)) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (left: number) => {
      loadRequestEvents(requestId, api).then(
        (list) => {
          if (!live) return;
          if (list.length === 0 && left > 0 && Date.now() - at < FRESH_MS) {
            timer = setTimeout(() => read(left - 1), AGAIN_MS);
            return;
          }
          events.set(requestId, list);
          setFound({ id: requestId, list });
        },
        (error: unknown) => {
          // The Trace ends at the request; the page's handler hears why while the inspector is open.
          if (live) reportError(error);
        },
      );
    };
    read(AGAIN_TIMES);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [requestId, at]);
  if (!requestId) return [];
  return events.get(requestId) ?? (found?.id === requestId ? found.list : []);
}
