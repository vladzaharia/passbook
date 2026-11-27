import { useEffect, useState } from 'react';
import type { RequestLogDetail } from '../../../shared/contracts/developer.ts';
import { useToolApi, useToolKey } from '../../lib/tool-api.tsx';
import type { CausedEvent } from '../bench/trace-events.ts';
import { loadRequestEvents } from '../bench/trace-events.ts';
import { readOne, traceGet } from './api.ts';

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
  const api = useToolApi();
  // A cached call never crosses clients: the Workbench's org, then the id.
  const scope = useToolKey().join('/');
  const [state, setState] = useState<{ id: string; detail: Detail } | null>(null);
  useEffect(() => {
    if (!id) return;
    const hit = cache.get(`${scope}:${id}`);
    if (hit) return setState({ id, detail: { kind: 'ready', row: hit } });
    const ctl = new AbortController();
    setState({ id, detail: { kind: 'loading' } });
    readOne(api, id, ctl.signal).then(
      (row) => {
        cache.set(`${scope}:${id}`, row);
        cache.set(`${scope}:${row.id}`, row);
        setState({ id, detail: { kind: 'ready', row } });
      },
      () => {
        if (!ctl.signal.aborted) setState({ id, detail: { kind: 'failed' } });
      },
    );
    return () => ctl.abort();
  }, [id, api, scope]);
  return state && state.id === id ? state.detail : null;
}

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
  const toolApi = useToolApi();
  const requestId = row && causesEvents(row) ? row.requestId : null;
  const at = row?.at ?? 0;
  const [found, setFound] = useState<{ id: string; list: CausedEvent[] } | null>(null);
  useEffect(() => {
    if (!requestId || events.has(requestId)) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (left: number) => {
      loadRequestEvents(requestId, traceGet(toolApi)).then(
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
  }, [requestId, at, toolApi]);
  if (!requestId) return [];
  return events.get(requestId) ?? (found?.id === requestId ? found.list : []);
}
